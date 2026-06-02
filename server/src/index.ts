import express, { Response } from "express";
import cors from "cors";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { WebSocketServer, WebSocket } from "ws";
import { PlotterDriver, PortInfo } from "./drivers/types.js";
import { detectDriver, listPorts, DEFAULT_DRIVER } from "./drivers/registry.js";
import { flattenSvg } from "./svg.js";
import { isLocalOrigin } from "./origin.js";
import { optimizePolylines } from "./optimize.js";
import { planPolylines, Plotter, PlotProgress } from "./plotter.js";
import {
  ConnectSchema,
  parsePlotOptions,
  PenSchema,
  PlotOptionsBodySchema,
  SvgFieldSchema,
} from "../../shared/schema.js";

const PORT = parseInt(process.env.PORT || "49787", 10);
// Bind to loopback only by default. This server has no auth and /api/plot
// drives physical motors, so it must not be reachable from the local network.
// HOST can be overridden for advanced setups, but the safe default is enforced
// in code, not just documented.
const HOST = process.env.HOST || "127.0.0.1";
const IS_PROD = process.env.NODE_ENV === "production";

const app = express();
app.use(
  cors({
    origin(origin, cb) {
      // A missing Origin means a same-origin request or a non-browser client
      // (curl, the packaged Electron shell). Allow those; the listener already
      // only accepts loopback connections.
      if (!origin || isLocalOrigin(origin)) return cb(null, true);
      cb(new Error("Origin not allowed"));
    },
  }),
);
app.use(express.json({ limit: "25mb" }));

// The active driver and the engine bound to it. Both are reassigned by
// `ensureDriverFor` when a port resolves to a different driver class. Routes
// reference these module variables at call time, so they always see the
// current instances.
let driver: PlotterDriver = new DEFAULT_DRIVER();
let activeDriverId: string = DEFAULT_DRIVER.id;
let plotter = new Plotter(driver);

let currentPath: string | null = null;
let currentVersion: string | null = null;
// Whether the coordinate origin has been established for the current session.
// Set on the first connect (and on explicit "set origin"); cleared only on an
// explicit disconnect. A transient USB drop must NOT clear it, so a reconnect
// preserves the origin the user set instead of silently re-zeroing to wherever
// the pen happens to be sitting.
let originEstablished = false;

/**
 * Make `driver`/`plotter` use the driver class that matches `port` (falling
 * back to the default driver). If that differs from the current driver, the
 * old one is closed and a fresh engine is bound to the new driver.
 */
async function ensureDriverFor(port: PortInfo): Promise<void> {
  const DriverClass = detectDriver(port) ?? DEFAULT_DRIVER;
  if (DriverClass.id === activeDriverId) return;
  if (driver.isOpen()) await driver.close().catch(() => {});
  driver = new DriverClass();
  activeDriverId = DriverClass.id;
  plotter = new Plotter(driver);
}

const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  // WebSocket upgrades bypass CORS, so gate them on the same loopback-origin
  // check — the WS channel is what streams plot progress and commands.
  verifyClient: ({ origin }: { origin?: string }) =>
    !origin || isLocalOrigin(origin),
});
const clients = new Set<WebSocket>();
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(
    JSON.stringify({
      type: "hello",
      connected: driver.isOpen(),
      path: currentPath,
      version: currentVersion,
    })
  );
  ws.on("close", () => clients.delete(ws));
});
function broadcast(msg: unknown) {
  const str = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === WebSocket.OPEN) c.send(str);
  }
}

/** Surface an out-of-band message in the client's status area. */
function notify(level: "info" | "warn", message: string) {
  broadcast({ type: "notice", level, message });
}

/**
 * Zero the coordinate origin (G92) at the pen's current position and mark the
 * origin as established for this session. Used by the explicit "set origin"
 * action and by the first connect of a session.
 */
async function setOriginHere() {
  await plotter.zeroHere();
  originEstablished = true;
}

/**
 * Validate `data` against `schema`. On success returns the parsed value; on
 * failure sends a 400 with a readable message and returns undefined — callers
 * must `return` immediately when they get undefined (the response is sent).
 */
function parseOrReject<T>(res: Response, schema: z.ZodType<T>, data: unknown): T | undefined {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  res.status(400).json({
    error: result.error.issues
      .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
      .join("; "),
  });
  return undefined;
}

// ---------- Routes ----------
app.get("/api/ports", async (_req, res) => {
  try {
    const ports = await listPorts();
    res.json({ ports, connected: driver.isOpen() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/connect", async (req, res) => {
  const body = parseOrReject(res, ConnectSchema, req.body);
  if (!body) return;
  const portPath = body.path;
  try {
    autoConnectPaused = false;
    // Pick the driver for this port (by VID/PID) before opening.
    const ports = await listPorts();
    await ensureDriverFor(ports.find((p) => p.path === portPath) ?? { path: portPath });
    await driver.open(portPath);
    let version: string;
    try {
      version = await driver.handshake();
    } catch (verr) {
      await driver.close().catch(() => {});
      return res.status(502).json({
        error: `Connected to ${portPath} but firmware did not identify as a supported plotter. ${(verr as Error).message}`,
      });
    }
    await driver.setAbsoluteMode().catch(() => {});
    if (originEstablished) {
      // Reconnecting within a session — keep the origin the user already has.
      notify("warn", 'Reconnected; kept the existing origin. Use "Set origin here" to re-zero.');
    } else {
      // First connect of the session: treat the current pen position as origin.
      await setOriginHere().catch(() => {});
    }
    currentPath = portPath;
    currentVersion = version;
    broadcast({ type: "connection", connected: true, path: portPath, version });
    res.json({ connected: true, path: portPath, version });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/disconnect", async (_req, res) => {
  try {
    await driver.close();
    currentPath = null;
    currentVersion = null;
    // Explicit disconnect ends the session — the next connect re-zeros.
    originEstablished = false;
    autoConnectPaused = true;
    broadcast({ type: "connection", connected: false });
    res.json({ connected: false });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/pen", async (req, res) => {
  const body = parseOrReject(res, PenSchema, req.body);
  if (!body) return;
  const opts = parseOrReject(res, PlotOptionsBodySchema, (req.body as { options?: unknown }).options);
  if (!opts) return;
  try {
    if (body.state === "down") await plotter.penDown(opts);
    else await plotter.penUp(opts);
    res.json({ ok: true, state: body.state });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/motors", async (req, res) => {
  const { enable } = req.body as { enable?: boolean };
  try {
    if (enable === false) await plotter.sleep();
    // No explicit enable command in DrawCore; motors come back on with the next move.
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/home", async (_req, res) => {
  try {
    await plotter.home();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/set-origin", async (_req, res) => {
  try {
    await setOriginHere();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/optimize", async (req, res) => {
  const svg = parseOrReject(res, SvgFieldSchema, req.body?.svg);
  if (svg === undefined) return;
  try {
    // Looser sampling — optimize stats only need the polyline topology, not
    // pen-quality density.
    const flat = await flattenSvg(svg, { maxChordMm: 0.5 });
    const { stats } = optimizePolylines(flat.polylines);
    res.json({ stats });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/plan", async (req, res) => {
  const svg = parseOrReject(res, SvgFieldSchema, req.body?.svg);
  if (svg === undefined) return;
  const opts = parseOrReject(res, PlotOptionsBodySchema, req.body?.options);
  if (!opts) return;
  try {
    const flat = await flattenSvg(svg, { mmPerUnit: opts.svgUnitsToMm });
    const polylines = planPolylines(flat, opts);
    res.json({ polylines });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/preview", async (req, res) => {
  const svg = parseOrReject(res, SvgFieldSchema, req.body?.svg);
  if (svg === undefined) return;
  try {
    // Preview is for the screen, not the plotter — coarser sampling keeps
    // the websocket payload small for huge SVGs.
    const flat = await flattenSvg(svg, { maxChordMm: 0.5 });
    res.json({
      viewBox: flat.viewBox,
      polylineCount: flat.polylines.length,
      polylines: flat.polylines,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/plot", async (req, res) => {
  console.log(
    `[plot] request: svgBytes=${req.body?.svg?.length ?? 0} connected=${driver.isOpen()} plotting=${plotter.isRunning()}`
  );
  const svg = parseOrReject(res, SvgFieldSchema, req.body?.svg);
  if (svg === undefined) {
    console.log(`[plot] rejected: invalid svg`);
    return;
  }
  const opts = parseOrReject(res, PlotOptionsBodySchema, req.body?.options);
  if (!opts) {
    console.log(`[plot] rejected: invalid options`);
    return;
  }
  if (!driver.isOpen()) {
    console.log(`[plot] rejected: not connected`);
    return res.status(400).json({ error: "not connected" });
  }
  if (plotter.isRunning()) {
    console.log(`[plot] rejected: already plotting`);
    return res.status(409).json({ error: "already plotting" });
  }

  try {
    const flat = await flattenSvg(svg, { mmPerUnit: opts.svgUnitsToMm });
    console.log(
      `[plot] starting: polylines=${flat.polylines.length} viewBox=${JSON.stringify(flat.viewBox)} mmPerUnit=${opts.svgUnitsToMm} offset=(${opts.offsetXMm},${opts.offsetYMm}) page=(${opts.pageWidthMm}x${opts.pageHeightMm}) flip=(${opts.flipX},${opts.flipY}) swap=${opts.swapXY}`
    );
    if (flat.polylines.length === 0) {
      console.log(`[plot] warning: SVG flattened to 0 polylines — nothing to draw`);
    }
    res.json({ started: true, polylineCount: flat.polylines.length });
    const onProgress = (p: PlotProgress) => {
      if (p.phase !== "drawing") console.log(`[plot] phase=${p.phase} ${p.polylineIndex}/${p.polylineCount}${p.message ? ` msg=${p.message}` : ""}`);
      broadcast({ type: "progress", ...p });
    };
    const onStart = (polylines: { x: number; y: number }[][], startIndex: number) =>
      broadcast({ type: "plot-start", polylines, startIndex });
    plotter.plot(flat, opts, onProgress, onStart).catch((err) => {
      console.log(`[plot] failed: ${(err as Error).message}`);
      broadcast({ type: "progress", phase: "error", message: (err as Error).message });
    });
  } catch (err) {
    console.log(`[plot] flatten failed: ${(err as Error).message}`);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Scripted smoke-test: draws a small square via the same Plotter pipeline so
// you can prove the motion path works without involving the UI. Run with:
//   curl -X POST http://localhost:49787/api/plot-test
app.post("/api/plot-test", async (_req, res) => {
  console.log(`[plot-test] connected=${driver.isOpen()} plotting=${plotter.isRunning()}`);
  if (!driver.isOpen()) return res.status(400).json({ error: "not connected" });
  if (plotter.isRunning()) return res.status(409).json({ error: "already plotting" });
  const opts = parsePlotOptions({});
  const size = 20;
  const flat = {
    viewBox: { x: 0, y: 0, width: size, height: size },
    polylines: [
      [
        { x: 0, y: 0 },
        { x: size, y: 0 },
        { x: size, y: size },
        { x: 0, y: size },
        { x: 0, y: 0 },
      ],
    ],
  };
  res.json({ started: true, polylineCount: 1 });
  const onProgress = (p: PlotProgress) => {
    if (p.phase !== "drawing") console.log(`[plot-test] phase=${p.phase}${p.message ? ` msg=${p.message}` : ""}`);
    broadcast({ type: "progress", ...p });
  };
  const onStart = (polylines: { x: number; y: number }[][], startIndex: number) =>
    broadcast({ type: "plot-start", polylines, startIndex });
  plotter.plot(flat, opts, onProgress, onStart).catch((err) => {
    console.log(`[plot-test] failed: ${(err as Error).message}`);
    broadcast({ type: "progress", phase: "error", message: (err as Error).message });
  });
});

app.post("/api/cancel", (_req, res) => {
  plotter.cancel();
  res.json({ ok: true });
});

app.post("/api/pause", (_req, res) => {
  plotter.pause();
  res.json({ ok: true });
});

app.post("/api/resume", (_req, res) => {
  plotter.resume();
  res.json({ ok: true });
});

app.get("/api/status", (_req, res) => {
  res.json({ connected: driver.isOpen(), plotting: plotter.isRunning() });
});

if (IS_PROD) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // In prod this file is built to server/dist/server/src/index.js (the nested
  // layout comes from rootDir being the repo root — see server/tsconfig.json),
  // so the web bundle at repo-root dist/web is four levels up.
  const webDist = path.resolve(here, "../../../../dist/web");
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

// ---------- Auto-connect ----------
// Periodically scan for a recognized plotter and connect if we're not already
// connected. Lets the server come up before the plotter is plugged in / powered
// on, and recovers automatically when the USB cable is reseated.
let autoConnectBusy = false;
let autoConnectPaused = false;

async function tryAutoConnect() {
  if (autoConnectBusy || autoConnectPaused) return;
  autoConnectBusy = true;
  try {
    if (driver.isOpen()) return;
    // Device is closed — make sure cached connection state agrees.
    if (currentPath !== null) {
      currentPath = null;
      currentVersion = null;
      broadcast({ type: "connection", connected: false });
    }
    let ports;
    try {
      ports = await listPorts();
    } catch (err) {
      console.log(`[auto-connect] listPorts failed: ${(err as Error).message}`);
      return;
    }
    const candidate = ports.find((p) => p.likelyPlotter);
    if (!candidate) return;
    console.log(`[auto-connect] trying ${candidate.path}`);
    await ensureDriverFor(candidate);
    try {
      await driver.open(candidate.path);
    } catch (err) {
      console.log(`[auto-connect] open failed: ${(err as Error).message}`);
      return;
    }
    let version: string;
    try {
      version = await driver.handshake();
    } catch (err) {
      console.log(`[auto-connect] handshake failed: ${(err as Error).message}`);
      await driver.close().catch(() => {});
      return;
    }
    await driver.setAbsoluteMode().catch(() => {});
    if (originEstablished) {
      // Reconnect after a transient drop (e.g. a CH340 cable hiccup). Preserve
      // the origin — re-zeroing here would silently move it to the pen's
      // current position and ruin a resumed/subsequent plot.
      notify("warn", `Auto-reconnected to ${candidate.path}; origin preserved. Re-zero if the plotter lost power.`);
    } else {
      await setOriginHere().catch(() => {});
      notify("info", `Auto-connected to ${candidate.path}; origin set at the current position.`);
    }
    currentPath = candidate.path;
    currentVersion = version;
    console.log(`[auto-connect] connected to ${candidate.path} (${version})`);
    broadcast({ type: "connection", connected: true, path: candidate.path, version });
  } finally {
    autoConnectBusy = false;
  }
}

setInterval(tryAutoConnect, 5000);

server.listen(PORT, HOST, () => {
  console.log(`Plotter server listening on http://${HOST}:${PORT}`);
  if (!IS_PROD) console.log(`Dev UI: http://localhost:49173`);
  // Kick off the first attempt right away — don't wait 5s.
  tryAutoConnect();
});

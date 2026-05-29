import express from "express";
import cors from "cors";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { PlotterDevice } from "./device.js";
import { flattenSvg } from "./svg.js";
import { optimizePolylines } from "./optimize.js";
import {
  DEFAULT_PLOT_OPTIONS,
  planPolylines,
  Plotter,
  PlotOptions,
  PlotProgress,
} from "./plotter.js";

const PORT = parseInt(process.env.PORT || "49787", 10);
const IS_PROD = process.env.NODE_ENV === "production";

const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const device = new PlotterDevice();
const plotter = new Plotter(device);

let currentPath: string | null = null;
let currentVersion: string | null = null;

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set<WebSocket>();
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(
    JSON.stringify({
      type: "hello",
      connected: device.isOpen(),
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

function parsePlotOptions(body: Partial<PlotOptions>): PlotOptions {
  return { ...DEFAULT_PLOT_OPTIONS, ...body };
}

// ---------- Routes ----------
app.get("/api/ports", async (_req, res) => {
  try {
    const ports = await device.listPorts();
    res.json({ ports, connected: device.isOpen() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/connect", async (req, res) => {
  const { path: portPath } = req.body as { path?: string };
  if (!portPath) return res.status(400).json({ error: "missing path" });
  try {
    autoConnectPaused = false;
    await device.open(portPath);
    let version: string;
    try {
      version = await device.handshake();
    } catch (verr) {
      await device.close().catch(() => {});
      return res.status(502).json({
        error: `Connected to ${portPath} but firmware did not identify as DrawCore. ${(verr as Error).message}`,
      });
    }
    // Start in absolute mode and treat current physical pen position as origin.
    await device.setAbsoluteMode().catch(() => {});
    await plotter.zeroHere().catch(() => {});
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
    await device.close();
    currentPath = null;
    currentVersion = null;
    autoConnectPaused = true;
    broadcast({ type: "connection", connected: false });
    res.json({ connected: false });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/pen", async (req, res) => {
  const { state, options } = req.body as { state?: "up" | "down"; options?: Partial<PlotOptions> };
  const opts = parsePlotOptions(options || {});
  try {
    if (state === "down") await plotter.penDown(opts);
    else await plotter.penUp(opts);
    res.json({ ok: true, state });
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
    await plotter.zeroHere();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/optimize", async (req, res) => {
  const { svg } = req.body as { svg?: string };
  if (!svg) return res.status(400).json({ error: "missing svg" });
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
  const { svg, options } = req.body as { svg?: string; options?: Partial<PlotOptions> };
  if (!svg) return res.status(400).json({ error: "missing svg" });
  const opts = parsePlotOptions(options || {});
  try {
    const flat = await flattenSvg(svg, { mmPerUnit: opts.svgUnitsToMm });
    const polylines = planPolylines(flat, opts);
    res.json({ polylines });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/preview", async (req, res) => {
  const { svg } = req.body as { svg?: string };
  if (!svg) return res.status(400).json({ error: "missing svg" });
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
  const { svg, options } = req.body as { svg?: string; options?: Partial<PlotOptions> };
  console.log(
    `[plot] request: svgBytes=${svg?.length ?? 0} connected=${device.isOpen()} plotting=${plotter.isRunning()}`
  );
  if (!svg) {
    console.log(`[plot] rejected: missing svg`);
    return res.status(400).json({ error: "missing svg" });
  }
  if (!device.isOpen()) {
    console.log(`[plot] rejected: not connected`);
    return res.status(400).json({ error: "not connected" });
  }
  if (plotter.isRunning()) {
    console.log(`[plot] rejected: already plotting`);
    return res.status(409).json({ error: "already plotting" });
  }

  const opts = parsePlotOptions(options || {});
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
  console.log(`[plot-test] connected=${device.isOpen()} plotting=${plotter.isRunning()}`);
  if (!device.isOpen()) return res.status(400).json({ error: "not connected" });
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
  res.json({ connected: device.isOpen(), plotting: plotter.isRunning() });
});

if (IS_PROD) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(here, "../../dist/web");
  app.use(express.static(webDist));
  app.get("*", (_req, res) => res.sendFile(path.join(webDist, "index.html")));
}

// ---------- Auto-connect ----------
// Periodically scan for a DrawCore plotter and connect if we're not already
// connected. Lets the server come up before the plotter is plugged in / powered
// on, and recovers automatically when the USB cable is reseated.
let autoConnectBusy = false;
let autoConnectPaused = false;

async function tryAutoConnect() {
  if (autoConnectBusy || autoConnectPaused) return;
  autoConnectBusy = true;
  try {
    if (device.isOpen()) return;
    // Device is closed — make sure cached connection state agrees.
    if (currentPath !== null) {
      currentPath = null;
      currentVersion = null;
      broadcast({ type: "connection", connected: false });
    }
    let ports;
    try {
      ports = await device.listPorts();
    } catch (err) {
      console.log(`[auto-connect] listPorts failed: ${(err as Error).message}`);
      return;
    }
    const candidate = ports.find((p) => p.likelyPlotter);
    if (!candidate) return;
    console.log(`[auto-connect] trying ${candidate.path}`);
    try {
      await device.open(candidate.path);
    } catch (err) {
      console.log(`[auto-connect] open failed: ${(err as Error).message}`);
      return;
    }
    let version: string;
    try {
      version = await device.handshake();
    } catch (err) {
      console.log(`[auto-connect] handshake failed: ${(err as Error).message}`);
      await device.close().catch(() => {});
      return;
    }
    await device.setAbsoluteMode().catch(() => {});
    await plotter.zeroHere().catch(() => {});
    currentPath = candidate.path;
    currentVersion = version;
    console.log(`[auto-connect] connected to ${candidate.path} (${version})`);
    broadcast({ type: "connection", connected: true, path: candidate.path, version });
  } finally {
    autoConnectBusy = false;
  }
}

setInterval(tryAutoConnect, 5000);

server.listen(PORT, () => {
  console.log(`Plotter server listening on http://localhost:${PORT}`);
  if (!IS_PROD) console.log(`Dev UI: http://localhost:49173`);
  // Kick off the first attempt right away — don't wait 5s.
  tryAutoConnect();
});

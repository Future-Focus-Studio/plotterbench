import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import InstructionList from "./InstructionList.js";
import NumberInput from "./NumberInput.js";
import PageCanvas from "./PageCanvas.js";
import SvgTree, { applyLayerColors, buildSvgTree, filterSvgByHidden, SvgTreeNode } from "./SvgTree.js";
import { api, openWs, OptimizeStats, PlotOptions, PortInfo, WsEvent } from "./api.js";
import { DEFAULT_PLOT_OPTIONS } from "@shared/types.js";
import { lengthToMm } from "@shared/svg-units.js";

type ConnectionState = {
  connected: boolean;
  path?: string;
  version?: string;
};

type ProgressState = Extract<WsEvent, { type: "progress" }> | null;

const inToMm = (n: number) => n * 25.4;
const mmToIn = (n: number) => n / 25.4;

// ---- Persistence ----
const PRESETS_KEY = "plotterbench-page-presets";
const SETTINGS_KEY = "plotterbench-settings";

type PresetMap = Record<string, { w: number; h: number }>;

interface SavedSettings {
  selectedPort: string;
  pageW: number;
  pageH: number;
  pageBackground: string;
  parsed: ParsedSvg | null;
  widthMm: number;
  heightMm: number;
  lockAspect: boolean;
  lockCenter: boolean;
  offsetX: number;
  offsetY: number;
  drawSpeed: number;
  travelSpeed: number;
  penDownDelayMs: number;
  penUpDelayMs: number;
  penUpZ: number;
  penDownZ: number;
  penSpeedMmPerMin: number;
  flipX: boolean;
  flipY: boolean;
  swapXY: boolean;
  optimizePaths: boolean;
  reversePaths: boolean;
  previewThinLines: boolean;
  testPatternOn: boolean;
  hiddenKeys: string[];
  layerLabels: Record<string, string>;
  layerColors: Record<string, string>;
}

const DEFAULTS: SavedSettings = {
  selectedPort: "",
  pageW: inToMm(11),
  pageH: inToMm(8.5),
  pageBackground: "#ffffff",
  parsed: null,
  widthMm: 100,
  heightMm: 100,
  lockAspect: true,
  lockCenter: false,
  offsetX: 10,
  offsetY: 10,
  drawSpeed: 40,
  travelSpeed: 80,
  penDownDelayMs: 0,
  penUpDelayMs: 0,
  penUpZ: 0,
  penDownZ: 5,
  penSpeedMmPerMin: 4000,
  flipX: true,
  flipY: true,
  swapXY: false,
  optimizePaths: false,
  reversePaths: false,
  previewThinLines: true,
  testPatternOn: false,
  hiddenKeys: [],
  layerLabels: {},
  layerColors: {},
};

function loadSettings(): SavedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { return DEFAULTS; }
}

/** A setter argument: a new value, or an updater of the previous value. */
type SetArg<T> = T | ((prev: T) => T);
type SetSetting = <K extends keyof SavedSettings>(key: K, value: SetArg<SavedSettings[K]>) => void;

/**
 * Single source of truth for all persisted settings. Holds the whole
 * `SavedSettings` object as one state and persists it with one debounced
 * effect, so there is no hand-maintained persistence literal or dependency
 * array to keep in sync (the old source of silent persistence bugs).
 */
function useSettings(): [SavedSettings, SetSetting] {
  const [settings, setSettings] = useState<SavedSettings>(loadSettings);

  useEffect(() => {
    const t = setTimeout(() => {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }, 300);
    return () => clearTimeout(t);
  }, [settings]);

  const set = useCallback<SetSetting>((key, value) => {
    setSettings((prev) => {
      const next = typeof value === "function"
        ? (value as (p: SavedSettings[typeof key]) => SavedSettings[typeof key])(prev[key])
        : value;
      return Object.is(prev[key], next) ? prev : { ...prev, [key]: next };
    });
  }, []);

  return [settings, set];
}

function loadPresets(): PresetMap {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || "{}"); } catch { return {}; }
}
function savePresets(p: PresetMap) {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(p));
}

interface ParsedSvg {
  text: string;
  viewBoxWidth: number;
  viewBoxHeight: number;
  /** Natural width in mm if declared, else guessed. */
  naturalWidthMm: number;
  naturalHeightMm: number;
  /** Factor that converts 1 source user-unit to mm. */
  svgUnitsToMm: number;
}

function parseSvg(text: string): ParsedSvg | null {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.querySelector("svg");
  if (!root) return null;
  if (doc.querySelector("parsererror")) return null;

  const vbAttr = root.getAttribute("viewBox");
  let vbW = 0,
    vbH = 0;
  if (vbAttr) {
    const parts = vbAttr.split(/[\s,]+/).map((n) => parseFloat(n));
    if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
      vbW = parts[2];
      vbH = parts[3];
    }
  }

  const wMm = lengthToMm(root.getAttribute("width"));
  const hMm = lengthToMm(root.getAttribute("height"));

  if (!vbW || !vbH) {
    vbW = wMm ? (wMm / 25.4) * 96 : 100;
    vbH = hMm ? (hMm / 25.4) * 96 : 100;
  }

  const naturalWidthMm = wMm ?? (vbW / 96) * 25.4;
  const naturalHeightMm = hMm ?? (vbH / 96) * 25.4;
  const svgUnitsToMm = naturalWidthMm / vbW;

  return { text, viewBoxWidth: vbW, viewBoxHeight: vbH, naturalWidthMm, naturalHeightMm, svgUnitsToMm };
}

function rotateSvg90(prev: ParsedSvg): ParsedSvg {
  const doc = new DOMParser().parseFromString(prev.text, "image/svg+xml");
  const root = doc.querySelector("svg");
  if (!root) return prev;

  const vbW = prev.viewBoxWidth;
  const vbH = prev.viewBoxHeight;

  const g = doc.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("transform", `translate(${vbH} 0) rotate(90)`);
  while (root.firstChild) g.appendChild(root.firstChild);
  root.appendChild(g);

  root.setAttribute("viewBox", `0 0 ${vbH} ${vbW}`);
  root.setAttribute("width", `${prev.naturalHeightMm}mm`);
  root.setAttribute("height", `${prev.naturalWidthMm}mm`);

  const newText = new XMLSerializer().serializeToString(root);
  return {
    text: newText,
    viewBoxWidth: vbH,
    viewBoxHeight: vbW,
    naturalWidthMm: prev.naturalHeightMm,
    naturalHeightMm: prev.naturalWidthMm,
    svgUnitsToMm: prev.naturalHeightMm / vbH,
  };
}

function buildTestPatternSvg(w: number, h: number): string {
  const sq = 12;
  const inset = 5;

  // Single-stroke digit glyphs on a 2×4 unit grid, drawn as polylines.
  // No <text> — the flattener can't convert fonts to paths.
  const GLYPHS: Record<string, [number, number][][]> = {
    "1": [[[1,0],[1,4]]],
    "2": [[[0,0],[2,0],[2,2],[0,2],[0,4],[2,4]]],
    "3": [[[0,0],[2,0],[2,4],[0,4]], [[0,2],[2,2]]],
    "4": [[[1.5,0],[0,2.5],[2,2.5]], [[1.5,0],[1.5,4]]],
  };

  const digitSvg = (digit: string, cx: number, cy: number, gw: number, gh: number) => {
    const strokes = GLYPHS[digit] ?? [];
    const sx = gw / 2, sy = gh / 4;
    return strokes.map((pts) => {
      const points = pts.map(([gx, gy]) =>
        `${(cx - gw / 2 + gx * sx).toFixed(2)},${(cy - gh / 2 + gy * sy).toFixed(2)}`
      ).join(" ");
      return `<polyline points="${points}" fill="none" stroke="black" stroke-width="0.4"/>`;
    }).join("\n");
  };

  const rectSvg = (x: number, y: number) =>
    `<rect x="${x}" y="${y}" width="${sq}" height="${sq}" fill="none" stroke="black" stroke-width="0.5"/>`;

  const corners = [
    { x: inset, y: inset, label: "1" },
    { x: w - inset - sq, y: inset, label: "2" },
    { x: inset, y: h - inset - sq, label: "3" },
    { x: w - inset - sq, y: h - inset - sq, label: "4" },
  ];

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">\n` +
    corners.map((c) =>
      rectSvg(c.x, c.y) + "\n" + digitSvg(c.label, c.x + sq / 2, c.y + sq / 2, 4, 6)
    ).join("\n") +
    `\n</svg>`
  );
}

function fmtMm(mm: number): string {
  if (mm >= 1000) return `${(mm / 1000).toFixed(2)} m`;
  return `${mm.toFixed(1)} mm`;
}

function OptimizeSummary({ stats }: { stats: OptimizeStats }) {
  const {
    originalCount, optimizedCount, reversed, merged,
    originalTravel, optimizedTravel, drawDistance,
  } = stats;
  const travelSaved = originalTravel - optimizedTravel;
  const pct = originalTravel > 0 ? (travelSaved / originalTravel) * 100 : 0;
  const strokesRemoved = originalCount - optimizedCount;

  return (
    <div className="opt-stats">
      <div className="opt-row">
        <span>Strokes</span>
        <span>{originalCount}{strokesRemoved > 0 ? ` → ${optimizedCount} (−${strokesRemoved})` : ""}</span>
      </div>
      <div className="opt-row">
        <span>Merged</span>
        <span>{merged}</span>
      </div>
      <div className="opt-row">
        <span>Reversed</span>
        <span>{reversed}</span>
      </div>
      <div className="opt-row">
        <span>Pen-up travel</span>
        <span>{fmtMm(originalTravel)} → {fmtMm(optimizedTravel)}</span>
      </div>
      {originalTravel > 0 && (
        <div className="opt-row opt-highlight">
          <span>Travel saved</span>
          <span>{fmtMm(travelSaved)} ({pct.toFixed(1)}%)</span>
        </div>
      )}
      <div className="opt-row muted">
        <span>Draw distance</span>
        <span>{fmtMm(drawDistance)}</span>
      </div>
    </div>
  );
}

export default function App() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [conn, setConn] = useState<ConnectionState>({ connected: false });
  const [status, setStatus] = useState<{ msg: string; kind: "ok" | "error" | "warn" } | null>(null);

  const [presets, setPresets] = useState<PresetMap>(() => loadPresets());
  const [presetName, setPresetName] = useState("");
  const [selectedPreset, setSelectedPreset] = useState("");

  const [settings, setSetting] = useSettings();
  const {
    selectedPort, pageW, pageH, pageBackground, parsed,
    widthMm, heightMm, lockAspect, lockCenter, offsetX, offsetY,
    drawSpeed, travelSpeed, penDownDelayMs, penUpDelayMs,
    penUpZ, penDownZ, penSpeedMmPerMin,
    flipX, flipY, swapXY, optimizePaths, reversePaths,
    previewThinLines, testPatternOn, layerLabels, layerColors,
  } = settings;

  // Per-field setters preserve the original `useState` ergonomics at call sites
  // while the store owns persistence. Adding a setting is: extend SavedSettings
  // + DEFAULTS (TypeScript links them) and bind it here — a missing binding is a
  // compile error, not silently-dropped persistence.
  const setSelectedPort = (v: SetArg<string>) => setSetting("selectedPort", v);
  const setPageW = (v: SetArg<number>) => setSetting("pageW", v);
  const setPageH = (v: SetArg<number>) => setSetting("pageH", v);
  const setPageBackground = (v: SetArg<string>) => setSetting("pageBackground", v);
  const setParsed = (v: SetArg<ParsedSvg | null>) => setSetting("parsed", v);
  const setWidthMm = (v: SetArg<number>) => setSetting("widthMm", v);
  const setHeightMm = (v: SetArg<number>) => setSetting("heightMm", v);
  const setLockAspect = (v: SetArg<boolean>) => setSetting("lockAspect", v);
  const setLockCenter = (v: SetArg<boolean>) => setSetting("lockCenter", v);
  const setOffsetX = (v: SetArg<number>) => setSetting("offsetX", v);
  const setOffsetY = (v: SetArg<number>) => setSetting("offsetY", v);
  const setDrawSpeed = (v: SetArg<number>) => setSetting("drawSpeed", v);
  const setTravelSpeed = (v: SetArg<number>) => setSetting("travelSpeed", v);
  const setPenDownDelayMs = (v: SetArg<number>) => setSetting("penDownDelayMs", v);
  const setPenUpDelayMs = (v: SetArg<number>) => setSetting("penUpDelayMs", v);
  const setPenUpZ = (v: SetArg<number>) => setSetting("penUpZ", v);
  const setPenDownZ = (v: SetArg<number>) => setSetting("penDownZ", v);
  const setPenSpeedMmPerMin = (v: SetArg<number>) => setSetting("penSpeedMmPerMin", v);
  const setFlipX = (v: SetArg<boolean>) => setSetting("flipX", v);
  const setFlipY = (v: SetArg<boolean>) => setSetting("flipY", v);
  const setSwapXY = (v: SetArg<boolean>) => setSetting("swapXY", v);
  const setOptimizePaths = (v: SetArg<boolean>) => setSetting("optimizePaths", v);
  const setReversePaths = (v: SetArg<boolean>) => setSetting("reversePaths", v);
  const setPreviewThinLines = (v: SetArg<boolean>) => setSetting("previewThinLines", v);
  const setTestPatternOn = (v: SetArg<boolean>) => setSetting("testPatternOn", v);
  const setLayerLabels = (v: SetArg<Record<string, string>>) => setSetting("layerLabels", v);
  const setLayerColors = (v: SetArg<Record<string, string>>) => setSetting("layerColors", v);

  // hiddenKeys is persisted as an array but consumed as a Set in the UI; bridge
  // the two here so the array/Set conversion lives in one place.
  const hiddenKeys = useMemo(() => new Set(settings.hiddenKeys), [settings.hiddenKeys]);
  const setHiddenKeys = (next: SetArg<Set<string>>) =>
    setSetting("hiddenKeys", (prev) =>
      Array.from(typeof next === "function" ? next(new Set(prev)) : next));

  const [optimizeStats, setOptimizeStats] = useState<OptimizeStats | null>(null);
  const [optimizeLoading, setOptimizeLoading] = useState(false);

  const [svgTree, setSvgTree] = useState<SvgTreeNode[]>(() => settings.parsed ? buildSvgTree(settings.parsed.text) : []);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());

  const [progress, setProgress] = useState<ProgressState>(null);
  const [plotPolylines, setPlotPolylines] = useState<{ x: number; y: number }[][] | null>(null);
  const [hoveredPolyline, setHoveredPolyline] = useState<number | null>(null);
  const [dragHover, setDragHover] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initial loads
  useEffect(() => {
    api.ports()
      .then(async (r) => {
        setPorts(r.ports);
        if (r.connected) {
          setConn({ connected: true });
          return;
        }
        // Pick the port to auto-connect. Prefer whichever port VID/PID-matches
        // a DrawCore plotter — the saved port is only a fallback for unusual
        // setups where the plotter doesn't enumerate as a CH340.
        const savedPath = settings.selectedPort;
        const portToUse =
          r.ports.find((p) => p.likelyPlotter)?.path ??
          (savedPath && r.ports.some((p) => p.path === savedPath) ? savedPath : null) ??
          null;
        if (portToUse) {
          setSelectedPort(portToUse);
          try {
            const result = await api.connect(portToUse);
            setConn({ connected: true, path: portToUse, version: result.version });
            setStatus({ msg: `Connected (${result.version})`, kind: "ok" });
          } catch (e) {
            setStatus({ msg: `Auto-connect failed: ${(e as Error).message}`, kind: "warn" });
          }
        }
      })
      .catch((e) => setStatus({ msg: e.message, kind: "error" }));
    const close = openWs((ev) => {
      if (ev.type === "hello" || ev.type === "connection") {
        setConn((prev) => ({
          connected: ev.connected,
          path: ev.path ?? (ev.connected ? prev.path : undefined),
          version: ev.version ?? (ev.connected ? prev.version : undefined),
        }));
        if (ev.connected && ev.path) setSelectedPort(ev.path);
      } else if (ev.type === "notice") {
        setStatus({ msg: ev.message, kind: ev.level === "warn" ? "warn" : "ok" });
      } else if (ev.type === "progress") {
        setProgress(ev);
        if (ev.phase === "done") setStatus({ msg: "Plot complete", kind: "ok" });
        if (ev.phase === "error") setStatus({ msg: ev.message || "Error", kind: "error" });
        if (ev.phase === "cancelled") setStatus({ msg: "Cancelled", kind: "warn" });
      } else if (ev.type === "plot-start") {
        setPlotPolylines(ev.polylines);
        setProgress(null);
      }
    });
    return () => close();
  }, []);

  // Persistence is handled inside useSettings — the whole settings object is
  // saved with one debounced effect, so there's nothing to keep in sync here.

  // Keep SVG centered on the page when lockCenter is on.
  useEffect(() => {
    if (!lockCenter) return;
    const cx = Math.round((pageW - widthMm) / 2 * 10) / 10;
    const cy = Math.round((pageH - heightMm) / 2 * 10) / 10;
    setOffsetX((prev) => (prev === cx ? prev : cx));
    setOffsetY((prev) => (prev === cy ? prev : cy));
  }, [lockCenter, pageW, pageH, widthMm, heightMm]);

  // Sync width/height when SVG changes. New SVGs auto-rotate to match the page
  // orientation (portrait/landscape) and scale to fill the page minus 10% padding
  // on each side, then are locked to the center.
  const onSvgLoaded = useCallback((p: ParsedSvg) => {
    // Rotate only when doing so produces a strictly better page fit.
    const fitNow = Math.min(pageW / p.naturalWidthMm, pageH / p.naturalHeightMm);
    const fitRot = Math.min(pageW / p.naturalHeightMm, pageH / p.naturalWidthMm);
    const final = fitRot > fitNow ? rotateSvg90(p) : p;

    const scale = Math.min(
      (pageW * 0.8) / final.naturalWidthMm,
      (pageH * 0.8) / final.naturalHeightMm,
    );
    const w = Math.round(final.naturalWidthMm * scale * 10) / 10;
    const h = Math.round(final.naturalHeightMm * scale * 10) / 10;

    setParsed(final);
    setWidthMm(w);
    setHeightMm(h);
    setLockCenter(true);
    setOffsetX(Math.round(((pageW - w) / 2) * 10) / 10);
    setOffsetY(Math.round(((pageH - h) / 2) * 10) / 10);
    setSvgTree(buildSvgTree(final.text));
    setExpandedKeys(new Set());
    setHiddenKeys(new Set());
    setLayerLabels({});
    setLayerColors({});
  }, [pageW, pageH]);

  const rotate90 = useCallback(() => {
    if (!parsed) return;
    const rotated = rotateSvg90(parsed);
    setSvgTree(buildSvgTree(rotated.text));
    setExpandedKeys(new Set());
    // Re-key hidden layers under the new rotation wrapper.
    setHiddenKeys((prevKeys) => {
      const next = new Set<string>();
      for (const k of prevKeys) next.add(`0-${k}`);
      return next;
    });
    setParsed(rotated);
    setWidthMm(heightMm);
    setHeightMm(widthMm);
  }, [parsed, widthMm, heightMm]);

  const onFile = useCallback(async (file: File) => {
    const text = await file.text();
    const p = parseSvg(text);
    if (!p) {
      setStatus({ msg: "Could not parse SVG", kind: "error" });
      return;
    }
    onSvgLoaded(p);
    setStatus({ msg: `Loaded ${file.name} (${p.viewBoxWidth.toFixed(0)}×${p.viewBoxHeight.toFixed(0)} units)`, kind: "ok" });
  }, [onSvgLoaded]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragHover(false);
      const file = e.dataTransfer.files[0];
      if (file) onFile(file);
    },
    [onFile]
  );

  // Global drag-and-drop: accept SVG drops anywhere on the app, not just the
  // sidebar drop zone. We track a counter because dragenter/dragleave fire for
  // every child element as the cursor passes over them.
  const dragCounter = useRef(0);
  useEffect(() => {
    const hasFile = (e: DragEvent) =>
      !!e.dataTransfer?.types?.some((t) => t === "Files");
    const onDragEnter = (e: DragEvent) => {
      if (!hasFile(e)) return;
      e.preventDefault();
      dragCounter.current += 1;
      setDragHover(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFile(e)) return;
      e.preventDefault();
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFile(e)) return;
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setDragHover(false);
    };
    const onDropWindow = (e: DragEvent) => {
      if (!hasFile(e)) return;
      e.preventDefault();
      dragCounter.current = 0;
      setDragHover(false);
      const file = e.dataTransfer?.files[0];
      if (file) onFile(file);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDropWindow);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDropWindow);
    };
  }, [onFile]);

  const aspect = parsed ? parsed.naturalWidthMm / parsed.naturalHeightMm : 1;
  const setWidthLocked = (w: number) => {
    setWidthMm(w);
    if (lockAspect && aspect) setHeightMm(Math.round((w / aspect) * 10) / 10);
  };
  const setHeightLocked = (h: number) => {
    setHeightMm(h);
    if (lockAspect && aspect) setWidthMm(Math.round(h * aspect * 10) / 10);
  };

  const testPatternParsed = useMemo<ParsedSvg | null>(
    () => (testPatternOn ? parseSvg(buildTestPatternSvg(pageW, pageH)) : null),
    [testPatternOn, pageW, pageH]
  );

  const displayParsed: ParsedSvg | null = testPatternOn ? testPatternParsed : parsed;
  const displayWidthMm = testPatternOn && testPatternParsed ? testPatternParsed.naturalWidthMm : widthMm;
  const displayHeightMm = testPatternOn && testPatternParsed ? testPatternParsed.naturalHeightMm : heightMm;
  const displayOffsetX = testPatternOn ? 0 : offsetX;
  const displayOffsetY = testPatternOn ? 0 : offsetY;

  const visibleSvg = useMemo(() => {
    if (testPatternOn && testPatternParsed) return testPatternParsed.text;
    if (!parsed) return null;
    const colored = applyLayerColors(parsed.text, layerColors);
    return filterSvgByHidden(colored, hiddenKeys);
  }, [testPatternOn, testPatternParsed, parsed, hiddenKeys, layerColors]);

  // Fetch optimize stats whenever the visible SVG changes. The optimize toggle
  // only affects which counts/travel we *display*. Debounced to avoid spamming
  // the server on rapid layer toggles.
  useEffect(() => {
    if (!visibleSvg) {
      setOptimizeStats(null);
      setOptimizeLoading(false);
      return;
    }
    let cancelled = false;
    setOptimizeLoading(true);
    const handle = setTimeout(() => {
      api.optimize(visibleSvg)
        .then((r) => { if (!cancelled) { setOptimizeStats(r.stats); setOptimizeLoading(false); } })
        .catch(() => { if (!cancelled) { setOptimizeStats(null); setOptimizeLoading(false); } });
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [visibleSvg]);

  const plotOptions: PlotOptions = useMemo(
    // Start from the shared defaults so the client and server agree on every
    // field, then override only the ones the user controls in the UI.
    () => ({
      ...DEFAULT_PLOT_OPTIONS,
      pageWidthMm: pageW,
      pageHeightMm: pageH,
      offsetXMm: displayOffsetX,
      offsetYMm: displayOffsetY,
      svgUnitsToMm: displayParsed ? displayWidthMm / displayParsed.viewBoxWidth : 1,
      drawSpeedMmPerSec: drawSpeed,
      travelSpeedMmPerSec: travelSpeed,
      penUpDelayMs,
      penDownDelayMs,
      penUpZ,
      penDownZ,
      penSpeedMmPerMin,
      flipX,
      flipY,
      swapXY,
      optimizePaths,
      reversePaths,
    }),
    [pageW, pageH, displayOffsetX, displayOffsetY, displayParsed, displayWidthMm, drawSpeed, travelSpeed, penDownDelayMs, penUpDelayMs, penUpZ, penDownZ, penSpeedMmPerMin, flipX, flipY, swapXY, optimizePaths, reversePaths]
  );

  const refreshPorts = async () => {
    try {
      const r = await api.ports();
      setPorts(r.ports);
    } catch (e) {
      setStatus({ msg: (e as Error).message, kind: "error" });
    }
  };

  const connect = async () => {
    if (!selectedPort) return;
    try {
      const r = await api.connect(selectedPort);
      setConn({ connected: true, path: selectedPort, version: r.version });
      setStatus({ msg: `Connected (${r.version})`, kind: "ok" });
    } catch (e) {
      setStatus({ msg: (e as Error).message, kind: "error" });
    }
  };

  const disconnect = async () => {
    try {
      await api.disconnect();
      setConn({ connected: false });
    } catch (e) {
      setStatus({ msg: (e as Error).message, kind: "error" });
    }
  };

  const penUp = async () => { try { await api.pen("up"); } catch (e) { setStatus({ msg: (e as Error).message, kind: "error" }); } };
  const penDown = async () => { try { await api.pen("down"); } catch (e) { setStatus({ msg: (e as Error).message, kind: "error" }); } };
  const home = async () => { try { await api.home(); } catch (e) { setStatus({ msg: (e as Error).message, kind: "error" }); } };
  const motorsOff = async () => { try { await api.motors(false); } catch (e) { setStatus({ msg: (e as Error).message, kind: "error" }); } };

  const plot = async (startPolylineIndex = 0) => {
    if (!displayParsed) return setStatus({ msg: "Load an SVG first", kind: "warn" });
    if (!conn.connected) return setStatus({ msg: "Connect to the plotter first", kind: "warn" });
    try {
      if (!visibleSvg) return setStatus({ msg: "No visible content to plot", kind: "warn" });
      await api.plot(visibleSvg, { ...plotOptions, startPolylineIndex });
      setStatus({
        msg: startPolylineIndex > 0
          ? `Plot started from #${startPolylineIndex + 1}`
          : "Plot started",
        kind: "ok",
      });
    } catch (e) {
      setStatus({ msg: (e as Error).message, kind: "error" });
    }
  };

  const cancel = async () => {
    try { await api.cancel(); } catch (e) { setStatus({ msg: (e as Error).message, kind: "error" }); }
  };

  const pause = async () => {
    try { await api.pause(); } catch (e) { setStatus({ msg: (e as Error).message, kind: "error" }); }
  };

  const resume = async () => {
    try { await api.resume(); } catch (e) { setStatus({ msg: (e as Error).message, kind: "error" }); }
  };

  const progressPct = progress && progress.polylineCount
    ? Math.min(100, (progress.polylineIndex / progress.polylineCount) * 100)
    : 0;

  const plotting = progress?.phase === "preparing" || progress?.phase === "drawing";
  const paused = progress?.phase === "paused";

  // Live preview of the instruction list. Whenever the visible SVG or plot
  // options change, re-derive the post-transform/post-optimize polylines so
  // the right sidebar always shows what would happen if Plot were clicked
  // right now. Skipped while a plot is in flight (the plot-start broadcast
  // is authoritative then). After a plot ends, we deliberately do NOT
  // re-fetch — the "done" state is preserved until the user changes something
  // material.
  const plotInProgressRef = useRef(false);
  plotInProgressRef.current = plotting || paused;
  useEffect(() => {
    if (plotInProgressRef.current) return;
    if (!visibleSvg) {
      setPlotPolylines(null);
      setProgress(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      api.plan(visibleSvg, plotOptions)
        .then((r) => {
          if (cancelled || plotInProgressRef.current) return;
          setPlotPolylines(r.polylines);
          setProgress(null);
        })
        .catch(() => { /* leave existing list in place */ });
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [visibleSvg, plotOptions]);

  return (
    <div className="app">
      <aside className="sidebar">
        <h2>Connection</h2>
        <div className="row">
          <select value={selectedPort} onChange={(e) => setSelectedPort(e.target.value)}>
            <option value="">-- Select port --</option>
            {ports.map((p) => {
              const vidPid = p.vendorId && p.productId ? ` [${p.vendorId}:${p.productId}]` : "";
              const tag = p.likelyPlotter ? " ★ plotter" : "";
              return (
                <option key={p.path} value={p.path}>
                  {p.path}
                  {p.manufacturer ? ` (${p.manufacturer})` : ""}
                  {vidPid}
                  {tag}
                </option>
              );
            })}
          </select>
        </div>
        <div className="row">
          <button className="secondary" onClick={refreshPorts}>Refresh</button>
          {!conn.connected ? (
            <button onClick={connect} disabled={!selectedPort}>Connect</button>
          ) : (
            <button className="danger" onClick={disconnect}>Disconnect</button>
          )}
        </div>
        {conn.connected && <div className="status">Connected {conn.path}{conn.version ? ` · ${conn.version}` : ""}</div>}

        <h2>Page</h2>
        {Object.keys(presets).length > 0 && (
          <div className="row">
            <select
              value={selectedPreset}
              onChange={(e) => {
                const p = presets[e.target.value];
                if (p) { setPageW(p.w); setPageH(p.h); }
                setSelectedPreset(e.target.value);
              }}
            >
              <option value="">Load preset…</option>
              {Object.keys(presets).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <button
              className="secondary"
              disabled={!selectedPreset}
              onClick={() => {
                const updated = { ...presets };
                delete updated[selectedPreset];
                setPresets(updated);
                savePresets(updated);
                setSelectedPreset("");
              }}
            >Delete</button>
          </div>
        )}
        <div className="row">
          <label>Width (in)</label>
          <NumberInput
            step="0.01" min="0.1" decimals={2}
            value={mmToIn(pageW)}
            onCommit={(v) => setPageW(inToMm(v))}
          />
        </div>
        <div className="row">
          <label>Height (in)</label>
          <NumberInput
            step="0.01" min="0.1" decimals={2}
            value={mmToIn(pageH)}
            onCommit={(v) => setPageH(inToMm(v))}
          />
        </div>
        <div className="row">
          <label>Background</label>
          <input
            type="color"
            value={pageBackground}
            onChange={(e) => setPageBackground(e.target.value)}
            title="Preview only — not plotted"
          />
          <button
            className="secondary"
            onClick={() => setPageBackground("#ffffff")}
            title="Reset to white"
          >Reset</button>
        </div>
        <div className="row">
          <input
            type="text"
            placeholder="Preset name…"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
          />
          <button
            onClick={() => {
              const name = presetName.trim();
              if (!name) return;
              const updated = { ...presets, [name]: { w: pageW, h: pageH } };
              setPresets(updated);
              savePresets(updated);
              setPresetName("");
              setSelectedPreset(name);
            }}
            disabled={!presetName.trim()}
          >Save</button>
        </div>

        <h2>SVG</h2>
        <div
          className={`file-drop${dragHover ? " hover" : ""}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragHover(true); }}
          onDragLeave={() => setDragHover(false)}
          onDrop={onDrop}
        >
          {parsed ? "Drop to replace · click to browse" : "Drop SVG here · click to browse"}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".svg,image/svg+xml"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
        />
        <div className="row">
          <label>
            <input
              type="checkbox"
              checked={testPatternOn}
              onChange={(e) => setTestPatternOn(e.target.checked)}
            /> Show test pattern
          </label>
        </div>
        <div className="row">
          <label>
            <input
              type="checkbox"
              checked={previewThinLines}
              onChange={(e) => setPreviewThinLines(e.target.checked)}
            /> Preview as thin black lines
          </label>
        </div>

        {svgTree.length > 0 && !testPatternOn && (
          <>
            <h2>Layers</h2>
            <SvgTree
              nodes={svgTree}
              expanded={expandedKeys}
              hidden={hiddenKeys}
              labels={layerLabels}
              colors={layerColors}
              onExpand={(key) => setExpandedKeys((prev) => {
                const next = new Set(prev);
                next.has(key) ? next.delete(key) : next.add(key);
                return next;
              })}
              onHide={(key) => setHiddenKeys((prev) => {
                const next = new Set(prev);
                next.has(key) ? next.delete(key) : next.add(key);
                return next;
              })}
              onRename={(key, label) => setLayerLabels((prev) => {
                const next = { ...prev };
                if (label) next[key] = label;
                else delete next[key];
                return next;
              })}
              onColor={(key, color) => setLayerColors((prev) => {
                const next = { ...prev };
                if (color) next[key] = color;
                else delete next[key];
                return next;
              })}
            />
          </>
        )}

        {displayParsed && (
          <>
            <h2>Optimization</h2>
            <div className="row">
              <label>
                <input
                  type="checkbox"
                  checked={optimizePaths}
                  onChange={(e) => setOptimizePaths(e.target.checked)}
                /> Optimize paths
              </label>
            </div>
            <div className="row">
              <label>
                <input
                  type="checkbox"
                  checked={reversePaths}
                  onChange={(e) => setReversePaths(e.target.checked)}
                /> Reverse (plot end → start)
              </label>
            </div>
            {optimizePaths && (
              <div className="optimize-summary">
                {optimizeLoading && !optimizeStats && <div className="muted">Analyzing…</div>}
                {optimizeStats && <OptimizeSummary stats={optimizeStats} />}
              </div>
            )}
          </>
        )}

        {parsed && !testPatternOn && (
          <>
            <div className="row">
              <label>Width (mm)</label>
              <NumberInput step="0.1" live value={widthMm} onCommit={setWidthLocked} />
            </div>
            <div className="row">
              <label>Height (mm)</label>
              <NumberInput step="0.1" live value={heightMm} onCommit={setHeightLocked} />
            </div>
            <div className="row">
              <label>
                <input type="checkbox" checked={lockAspect} onChange={(e) => setLockAspect(e.target.checked)} /> Lock aspect
              </label>
            </div>
            <div className="row">
              <label>
                <input
                  type="checkbox"
                  checked={lockCenter}
                  onChange={(e) => setLockCenter(e.target.checked)}
                /> Lock SVG to center
              </label>
            </div>
            <div className="row">
              <button className="secondary" onClick={rotate90}>Rotate 90°</button>
            </div>
            <div className="row">
              <label>Offset X (mm)</label>
              <NumberInput step="0.5" decimals={1} value={offsetX} onCommit={setOffsetX} disabled={lockCenter} />
            </div>
            <div className="row">
              <label>Offset Y (mm)</label>
              <NumberInput step="0.5" decimals={1} value={offsetY} onCommit={setOffsetY} disabled={lockCenter} />
            </div>
          </>
        )}

        <h2>Speed</h2>
        <div className="row">
          <label>Draw (mm/s)</label>
          <NumberInput min="1" value={drawSpeed} onCommit={setDrawSpeed} />
        </div>
        <div className="row">
          <label>Travel (mm/s)</label>
          <NumberInput min="1" value={travelSpeed} onCommit={setTravelSpeed} />
        </div>
        <div className="row">
          <label>Pen-down delay (ms)</label>
          <NumberInput min="0" step="10" value={penDownDelayMs} onCommit={setPenDownDelayMs} />
        </div>
        <div className="row">
          <label>Pen-up delay (ms)</label>
          <NumberInput min="0" step="10" value={penUpDelayMs} onCommit={setPenUpDelayMs} />
        </div>
        <div className="row">
          <label>Pen-up Z</label>
          <NumberInput min="0" max="10" step="0.5" value={penUpZ} onCommit={setPenUpZ} />
        </div>
        <div className="row">
          <label>Pen-down Z</label>
          <NumberInput min="0" max="10" step="0.5" value={penDownZ} onCommit={setPenDownZ} />
        </div>
        <div className="row">
          <label>Pen speed up/down (mm/s)</label>
          <NumberInput
            min="1" step="1" decimals={1}
            value={penSpeedMmPerMin / 60}
            onCommit={(v) => setPenSpeedMmPerMin(Math.max(1, Math.round(v * 60)))}
          />
        </div>

        <h2>Orientation</h2>
        <div className="row">
          <label>
            <input type="checkbox" checked={flipX} onChange={(e) => setFlipX(e.target.checked)} /> Flip X
          </label>
        </div>
        <div className="row">
          <label>
            <input type="checkbox" checked={flipY} onChange={(e) => setFlipY(e.target.checked)} /> Flip Y
          </label>
        </div>
        <div className="row">
          <label>
            <input type="checkbox" checked={swapXY} onChange={(e) => setSwapXY(e.target.checked)} /> Swap X/Y
          </label>
        </div>

      </aside>

      <main className="stage">
        <PageCanvas
          pageWidthMm={pageW}
          pageHeightMm={pageH}
          svg={visibleSvg}
          svgViewBoxWidth={displayParsed?.viewBoxWidth ?? 0}
          svgViewBoxHeight={displayParsed?.viewBoxHeight ?? 0}
          svgWidthMm={displayWidthMm}
          svgHeightMm={displayHeightMm}
          offsetXMm={displayOffsetX}
          offsetYMm={displayOffsetY}
          onOffsetChange={(x, y) => { if (testPatternOn || lockCenter) return; setOffsetX(x); setOffsetY(y); }}
          lockedAspect={lockAspect && displayParsed ? displayParsed.naturalWidthMm / displayParsed.naturalHeightMm : null}
          onSizeChange={(w, h, ox, oy) => {
            if (testPatternOn) return;
            setWidthMm(Math.round(w * 10) / 10);
            setHeightMm(Math.round(h * 10) / 10);
            setOffsetX(Math.round(ox * 10) / 10);
            setOffsetY(Math.round(oy * 10) / 10);
          }}
          plotPolylines={plotPolylines}
          plotPolylineIndex={progress?.polylineIndex ?? 0}
          plotSegmentIndex={progress?.segmentIndex ?? 0}
          plotPhase={progress?.phase ?? null}
          hoveredPolylineIndex={hoveredPolyline}
          thinLinePreview={previewThinLines}
          pageBackground={pageBackground}
        />
      </main>

      <aside className="sidebar sidebar-right">
        <h2>Controls</h2>
        <div className="row">
          <button className="secondary" onClick={penUp} disabled={!conn.connected}>Pen up</button>
          <button className="secondary" onClick={penDown} disabled={!conn.connected}>Pen down</button>
        </div>
        <div className="row">
          <button className="secondary" onClick={home} disabled={!conn.connected}>Go to 0,0</button>
          <button className="secondary" onClick={motorsOff} disabled={!conn.connected}>Motors off</button>
        </div>
        <div className="row">
          <button
            className="secondary"
            onClick={async () => {
              try { await api.setOrigin(); setStatus({ msg: "Origin set at current position", kind: "ok" }); }
              catch (e) { setStatus({ msg: (e as Error).message, kind: "error" }); }
            }}
            disabled={!conn.connected}
          >
            Set origin here
          </button>
        </div>

        <h2>Plot</h2>
        <div className="row">
          {!plotting && !paused ? (
            <button onClick={() => plot(0)} disabled={!conn.connected || !displayParsed}>Plot</button>
          ) : paused ? (
            <>
              <button onClick={resume}>Resume</button>
              <button className="danger" onClick={cancel}>Cancel</button>
            </>
          ) : (
            <>
              <button className="secondary" onClick={pause}>Pause</button>
              <button className="danger" onClick={cancel}>Cancel</button>
            </>
          )}
        </div>
        {progress && (
          <>
            <div className="status">
              {progress.phase}: {progress.polylineIndex}/{progress.polylineCount}
            </div>
            <div className="progress-bar"><div style={{ width: `${progressPct}%` }} /></div>
          </>
        )}
        {status && <div className={`status ${status.kind === "error" ? "error" : status.kind === "warn" ? "warn" : ""}`}>{status.msg}</div>}

        <h2>Instructions</h2>
        <div className="instr-panel">
          <InstructionList
            polylines={plotPolylines}
            currentIndex={progress?.polylineIndex ?? 0}
            drawing={plotting || paused}
            hoveredIndex={hoveredPolyline}
            onHover={setHoveredPolyline}
            onRewind={(i) => plot(i)}
            rewindDisabled={!conn.connected || !displayParsed || plotting || paused}
          />
        </div>
      </aside>
    </div>
  );
}

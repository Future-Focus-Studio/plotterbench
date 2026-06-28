import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import InstructionList from "./InstructionList.js";
import Modal from "./Modal.js";
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
  /** Active driver id, e.g. "drawcore" or "ebb". Drives which pen settings are
   *  relevant (Z depth vs. servo height). */
  driverId?: string;
  driverName?: string;
};

type ProgressState = Extract<WsEvent, { type: "progress" }> | null;

const inToMm = (n: number) => n * 25.4;
const mmToIn = (n: number) => n / 25.4;

// ---- Persistence ----
const SETTINGS_KEY = "plotterbench-settings";

interface SavedSettings {
  selectedPort: string;
  pageW: number;
  pageH: number;
  pageBackground: string;
  parsed: ParsedSvg | null;
  fileName: string;
  widthMm: number;
  heightMm: number;
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
  penUpPercent: number;
  penDownPercent: number;
  flipX: boolean;
  flipY: boolean;
  swapXY: boolean;
  optimizePaths: boolean;
  reversePaths: boolean;
  previewThinLines: boolean;
  /** Active calibration pattern: "none" (show the loaded SVG) or a pattern id
   *  like "corners". Add more pattern ids here as they're implemented. */
  testPattern: string;
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
  fileName: "",
  widthMm: 100,
  heightMm: 100,
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
  penUpPercent: 60,
  penDownPercent: 30,
  flipX: true,
  flipY: true,
  swapXY: false,
  optimizePaths: false,
  reversePaths: false,
  previewThinLines: true,
  testPattern: "none",
  hiddenKeys: [],
  layerLabels: {},
  layerColors: {},
};

// SVGs larger than this aren't persisted to localStorage or inlined as a
// thumbnail data URL: a multi-megabyte SVG (e.g. 100k+ dithered <line>s) blows
// the ~5MB localStorage quota and re-freezes the UI on every refresh when
// restored. Such files are simply re-loaded by hand instead.
const MAX_INLINE_SVG_BYTES = 1_500_000;

function loadSettings(): SavedSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    const saved: SavedSettings = { ...DEFAULTS, ...JSON.parse(raw) };
    // Drop an oversized restored SVG so it doesn't re-freeze the app on load.
    if (saved.parsed && saved.parsed.text.length > MAX_INLINE_SVG_BYTES) {
      saved.parsed = null;
      saved.fileName = "";
    }
    return saved;
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
      try {
        // Don't persist an oversized SVG — it overflows the quota (which would
        // throw and drop ALL settings) and slows refresh. Save it minus `parsed`.
        const toSave =
          settings.parsed && settings.parsed.text.length > MAX_INLINE_SVG_BYTES
            ? { ...settings, parsed: null }
            : settings;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(toSave));
      } catch {
        /* quota or serialization error — skip this save */
      }
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

function buildCornerNumbers(w: number, h: number): string {
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

// Minimal single-stroke font for plot labels (no <text> — the flattener can't
// outline fonts). Each glyph is one or more polylines on a 0..1 box, y down.
const STROKE_GLYPHS: Record<string, [number, number][][]> = {
  "0": [[[0,0],[1,0],[1,1],[0,1],[0,0]]],
  "1": [[[0.5,0],[0.5,1]]],
  "2": [[[0,0],[1,0],[1,0.5],[0,0.5],[0,1],[1,1]]],
  "3": [[[0,0],[1,0],[1,1],[0,1]],[[0,0.5],[1,0.5]]],
  "4": [[[0,0],[0,0.5],[1,0.5]],[[1,0],[1,1]]],
  "5": [[[1,0],[0,0],[0,0.5],[1,0.5],[1,1],[0,1]]],
  "6": [[[1,0],[0,0],[0,1],[1,1],[1,0.5],[0,0.5]]],
  "7": [[[0,0],[1,0],[1,1]]],
  "8": [[[0,0],[1,0],[1,1],[0,1],[0,0]],[[0,0.5],[1,0.5]]],
  "9": [[[1,1],[1,0],[0,0],[0,0.5],[1,0.5]]],
  ".": [[[0.4,1],[0.6,1]]],
  "\"": [[[0.25,0],[0.25,0.3]],[[0.55,0],[0.55,0.3]]],
  "U": [[[0,0],[0,1],[1,1],[1,0]]],
  "P": [[[0,1],[0,0],[1,0],[1,0.5],[0,0.5]]],
  "D": [[[0,1],[0,0],[0.6,0],[1,0.4],[1,0.6],[0.6,1],[0,1]]],
  "O": [[[0,0],[1,0],[1,1],[0,1],[0,0]]],
  "W": [[[0,0],[0.25,1],[0.5,0.4],[0.75,1],[1,0]]],
  "N": [[[0,1],[0,0],[1,1],[1,0]]],
  "M": [[[0,1],[0,0],[0.5,0.6],[1,0],[1,1]]],
  "X": [[[0,0],[1,1]],[[1,0],[0,1]]],
  "Y": [[[0,0],[0.5,0.55]],[[1,0],[0.5,0.55]],[[0.5,0.55],[0.5,1]]],
};

/**
 * Render `text` as single-stroke polylines. (x, y) is the top of the text; with
 * anchor "middle" the run is horizontally centered on x. `size` is the glyph
 * height in mm; glyphs are 0.6× as wide.
 */
function strokeText(
  text: string,
  x: number,
  y: number,
  size: number,
  anchor: "start" | "middle" = "start",
): string {
  const charW = size * 0.6;
  const advance = charW + size * 0.25;
  const totalW = text.length * advance - size * 0.25;
  const startX = anchor === "middle" ? x - totalW / 2 : x;
  const out: string[] = [];
  text.split("").forEach((ch, i) => {
    const glyph = STROKE_GLYPHS[ch.toUpperCase()];
    if (!glyph) return;
    const ox = startX + i * advance;
    for (const pl of glyph) {
      const pts = pl
        .map(([gx, gy]) => `${(ox + gx * charW).toFixed(2)},${(y + gy * size).toFixed(2)}`)
        .join(" ");
      out.push(`<polyline points="${pts}" fill="none" stroke="black" stroke-width="0.3"/>`);
    }
  });
  return out.join("\n");
}

/**
 * Size-measurement calibration pattern: a centered whole-inch square (sized to
 * fit the page) with a numbered 1/8" ruler, up/down orientation arrows, and a
 * page-perimeter rectangle whose dimensions are labelled in inches. All geometry
 * is derived from page size.
 */
function buildSizeMeasurement(w: number, h: number): string {
  const IN = 25.4;
  const cx = w / 2, cy = h / 2;
  const els: string[] = [];

  const rect = (x: number, y: number, rw: number, rh: number, sw = 0.4) =>
    `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${rw.toFixed(2)}" height="${rh.toFixed(2)}" fill="none" stroke="black" stroke-width="${sw}"/>`;
  const line = (x1: number, y1: number, x2: number, y2: number, sw = 0.3) =>
    `<polyline points="${x1.toFixed(2)},${y1.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}" fill="none" stroke="black" stroke-width="${sw}"/>`;

  // Perimeter rectangle is 1" inset from the page edges; the reference square is
  // the largest whole-inch square that fits inside it while leaving a side gap
  // for the orientation arrows.
  const inset = 1 * IN;
  const innerW = w - 2 * inset, innerH = h - 2 * inset;
  const sideGap = 0.7 * IN; // breathing room between the square and the perimeter
  const maxSide = Math.min(innerW - 2 * sideGap, innerH - 0.5 * IN);
  const sqIn = Math.max(1, Math.floor(maxSide / IN));
  const sq = sqIn * IN;
  const sx = cx - sq / 2, sy = cy - sq / 2;
  els.push(rect(sx, sy, sq, sq));

  // 1/8" ruler ticks inward along the top and left edges of the square (longer
  // tick every full inch, labelled with its inch count).
  const step = IN / 8;
  const tickSize = 0.1 * IN;
  for (let i = 0; i <= sqIn * 8; i++) {
    const major = i % 8 === 0;
    const len = major ? 4 : 2;
    els.push(line(sx + i * step, sy, sx + i * step, sy + len));
    els.push(line(sx, sy + i * step, sx + len, sy + i * step));
    // Number each full-inch tick just inside the edge (skip the shared corner).
    if (major && i > 0) {
      const inch = (i / 8).toString();
      els.push(strokeText(inch, sx + i * step, sy + len + 1, tickSize, "middle"));
      els.push(strokeText(inch, sx + len + 1, sy + i * step - tickSize / 2, tickSize, "start"));
    }
  }

  // Orientation arrows stacked in the outer right margin (between the perimeter
  // rectangle and the page edge): UP near the top, DOWN near the bottom.
  const arrLen = 2 * IN, headW = 2, headL = 4;
  const rax = w - inset / 2; // centered in the outer right margin
  const upCy = inset + arrLen, downCy = h - inset - arrLen; // near top / bottom
  // UP arrow (points up)
  els.push(line(rax, upCy + arrLen / 2, rax, upCy - arrLen / 2, 0.4));
  els.push(line(rax, upCy - arrLen / 2, rax - headW, upCy - arrLen / 2 + headL, 0.4));
  els.push(line(rax, upCy - arrLen / 2, rax + headW, upCy - arrLen / 2 + headL, 0.4));
  els.push(strokeText("UP", rax, upCy + arrLen / 2 + 0.1 * IN, 0.2 * IN, "middle"));
  // DOWN arrow (points down)
  els.push(line(rax, downCy - arrLen / 2, rax, downCy + arrLen / 2, 0.4));
  els.push(line(rax, downCy + arrLen / 2, rax - headW, downCy + arrLen / 2 - headL, 0.4));
  els.push(line(rax, downCy + arrLen / 2, rax + headW, downCy + arrLen / 2 - headL, 0.4));
  els.push(strokeText("DOWN", rax, downCy - arrLen / 2 - 0.3 * IN, 0.2 * IN, "middle"));

  // Perimeter rectangle, with its width/height labelled in inches in the top
  // and left margins.
  els.push(rect(inset, inset, innerW, innerH, 0.5));
  // Whole-inch ruler ticks inward along the top and left edges of the perimeter.
  for (let i = 0; i <= Math.floor(innerW / IN); i++)
    els.push(line(inset + i * IN, inset, inset + i * IN, inset + 3));
  for (let i = 0; i <= Math.floor(innerH / IN); i++)
    els.push(line(inset, inset + i * IN, inset + 3, inset + i * IN));
  const fmt = (n: number) => (Math.round(n * 1000) / 1000).toString() + "\"";
  els.push(strokeText(fmt(w / IN - 2), cx, inset / 2 - 0.15 * IN, 0.3 * IN, "middle"));
  // Rotate the left label to read bottom-to-top so it always fits the narrow
  // margin regardless of how many digits the height has.
  const leftLabel = strokeText(fmt(h / IN - 2), inset / 2, cy - 0.15 * IN, 0.3 * IN, "middle");
  els.push(`<g transform="rotate(-90 ${(inset / 2).toFixed(2)} ${cy.toFixed(2)})">\n${leftLabel}\n</g>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">\n${els.join("\n")}\n</svg>`;
}

/**
 * Metric scale-calibration pattern: a precise millimetre ruler along each axis,
 * sharing a common origin corner. Lay a physical ruler/calipers against the
 * drawn X ruler and the Y ruler separately to confirm that "100 mm drawn =
 * 100 mm measured" — i.e. that steps-per-mm is correct AND that the X and Y
 * scales match (an H-bot can be right on one axis and wrong on the other). A
 * square + inscribed circle give an at-a-glance cross-check: if the scales agree
 * the square stays square and the circle stays round. Minor tick every 5 mm,
 * major (labelled) tick every 10 mm; the ruler span is rounded down to a whole
 * centimetre so the last mark is a clean number to measure to. All geometry is
 * derived from the page size, so it adapts to any bed.
 */
function buildCalibrationRuler(w: number, h: number): string {
  const els: string[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number, sw = 0.3) =>
    `<polyline points="${x1.toFixed(2)},${y1.toFixed(2)} ${x2.toFixed(2)},${y2.toFixed(2)}" fill="none" stroke="black" stroke-width="${sw}"/>`;
  const rect = (x: number, y: number, rw: number, rh: number, sw = 0.4) =>
    `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${rw.toFixed(2)}" height="${rh.toFixed(2)}" fill="none" stroke="black" stroke-width="${sw}"/>`;

  const margin = Math.min(12, w * 0.08, h * 0.08);
  const ox = margin, oy = margin; // shared origin corner for both rulers
  // Round each span down to a whole 10 mm so the final labelled mark is a clean
  // decade (e.g. 130, not 134) for the eye to land a ruler on.
  const spanX = Math.max(10, Math.floor((w - 2 * margin) / 10) * 10);
  const spanY = Math.max(10, Math.floor((h - 2 * margin) / 10) * 10);

  const MAJOR = 3.5, MINOR = 1.5; // tick lengths, mm
  const GLYPH = 2; // label glyph height, mm

  // Horizontal (X) ruler, ticks pointing down, labels beneath.
  els.push(line(ox, oy, ox + spanX, oy, 0.5));
  for (let mm = 0; mm <= spanX; mm += 5) {
    const x = ox + mm;
    const major = mm % 10 === 0;
    els.push(line(x, oy, x, oy + (major ? MAJOR : MINOR)));
    if (major) els.push(strokeText(String(mm), x, oy + MAJOR + 1, GLYPH, "middle"));
  }
  els.push(strokeText("X", ox + spanX + 3, oy - GLYPH / 2, GLYPH + 1, "start"));

  // Vertical (Y) ruler, ticks pointing right, labels to their right. Skip the
  // "0" mark — the X ruler already prints it at the shared origin.
  els.push(line(ox, oy, ox, oy + spanY, 0.5));
  for (let mm = 0; mm <= spanY; mm += 5) {
    const y = oy + mm;
    const major = mm % 10 === 0;
    els.push(line(ox, y, ox + (major ? MAJOR : MINOR), y));
    if (major && mm > 0) els.push(strokeText(String(mm), ox + MAJOR + 1.5, y - GLYPH / 2, GLYPH, "start"));
  }
  els.push(strokeText("Y", ox - GLYPH, oy + spanY + 3, GLYPH + 1, "middle"));

  // Cross-scale check: a clean-decade square + inscribed circle, placed clear of
  // the L-shaped rulers (which occupy a ~8 mm band along the top and left).
  const clearX0 = ox + 9, clearY0 = oy + 9;
  const clearW = ox + spanX - clearX0;
  const clearH = oy + spanY - clearY0;
  const s = Math.min(50, Math.floor(Math.min(clearW, clearH) / 10) * 10);
  if (s >= 10) {
    const bx = clearX0 + (clearW - s) / 2;
    const by = clearY0 + (clearH - s) / 2;
    els.push(rect(bx, by, s, s, 0.4));
    els.push(`<circle cx="${(bx + s / 2).toFixed(2)}" cy="${(by + s / 2).toFixed(2)}" r="${(s / 2).toFixed(2)}" fill="none" stroke="black" stroke-width="0.4"/>`);
    els.push(strokeText(`${s}MM`, bx + s / 2, by + s / 2 - GLYPH / 2, GLYPH, "middle"));
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">\n${els.join("\n")}\n</svg>`;
}

/**
 * Registry of calibration test patterns. Each entry is a label for the dropdown
 * and a builder that turns the current page size (mm) into an SVG string. To add
 * a pattern, write a builder above and add one entry here.
 */
const TEST_PATTERNS: Record<string, { label: string; build: (w: number, h: number) => string }> = {
  corners: { label: "Corner numbers", build: buildCornerNumbers },
  size: { label: "Size measurement", build: buildSizeMeasurement },
  ruler: { label: "Calibration ruler (mm)", build: buildCalibrationRuler },
};

function fmtMm(mm: number): string {
  if (mm >= 1000) return `${(mm / 1000).toFixed(2)} m`;
  return `${mm.toFixed(1)} mm`;
}

function OptimizeSummary({ stats }: { stats: OptimizeStats }) {
  const {
    originalCount, optimizedCount, merged,
    originalTravel, optimizedTravel,
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
        <span>Pen-up travel</span>
        <span>{fmtMm(originalTravel)} → {fmtMm(optimizedTravel)}</span>
      </div>
      {originalTravel > 0 && (
        <div className="opt-row opt-highlight">
          <span>Travel saved</span>
          <span>{fmtMm(travelSaved)} ({pct.toFixed(1)}%)</span>
        </div>
      )}
    </div>
  );
}

/**
 * Refresh / reset glyph. Public-domain icon from The Noun Project
 * ("Refresh" by Marina Rizo, Mono Icons). Single filled path so it stays crisp
 * at tiny sizes; uses currentColor to inherit the button's text colour.
 */
function RefreshIcon() {
  return (
    <svg viewBox="0 0 100 100" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="m53.305 9.5547c1.625-1.6289 4.2656-1.6289 5.8906 0l12.5 12.5c1.6289 1.625 1.6289 4.2656 0 5.8906l-12.5 12.5c-1.625 1.6289-4.2656 1.6289-5.8906 0-1.6289-1.625-1.6289-4.2656 0-5.8906l5.3867-5.3867h-6.6094c-14.781 0-27.082 12.301-27.082 27.082s12.301 27.082 27.082 27.082c14.785 0 27.086-12.301 27.086-27.082 0-2.3008 1.8633-4.168 4.1641-4.168s4.168 1.8672 4.168 4.168c0 19.383-16.031 35.418-35.418 35.418-19.383 0-35.414-16.035-35.414-35.418s16.031-35.418 35.414-35.418h6.6094l-5.3867-5.3867c-1.6289-1.625-1.6289-4.2656 0-5.8906z" />
    </svg>
  );
}

export default function App() {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [conn, setConn] = useState<ConnectionState>({ connected: false });
  const [status, setStatus] = useState<{ msg: string; kind: "ok" | "error" | "warn" } | null>(null);
  // Connection-scoped feedback (connect / auto-connect / disconnect, success and
  // failure) shown in the Connection section under the buttons — kept separate
  // from the global `status` line at the bottom, which carries plot / file /
  // control feedback. Connection messages used to land in that bottom line,
  // far from the Connection UI they describe.
  const [connStatus, setConnStatus] = useState<{ msg: string; kind: "ok" | "error" | "warn" } | null>(null);

  const [settings, setSetting] = useSettings();
  const {
    selectedPort, pageW, pageH, pageBackground, parsed, fileName,
    widthMm, heightMm, lockCenter, offsetX, offsetY,
    drawSpeed, travelSpeed, penDownDelayMs, penUpDelayMs,
    penUpZ, penDownZ, penSpeedMmPerMin, penUpPercent, penDownPercent,
    flipX, flipY, swapXY, optimizePaths, reversePaths,
    previewThinLines, testPattern, layerLabels, layerColors,
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
  const setFileName = (v: SetArg<string>) => setSetting("fileName", v);
  const setWidthMm = (v: SetArg<number>) => setSetting("widthMm", v);
  const setHeightMm = (v: SetArg<number>) => setSetting("heightMm", v);
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
  const setPenUpPercent = (v: SetArg<number>) => setSetting("penUpPercent", v);
  const setPenDownPercent = (v: SetArg<number>) => setSetting("penDownPercent", v);
  const setFlipX = (v: SetArg<boolean>) => setSetting("flipX", v);
  const setFlipY = (v: SetArg<boolean>) => setSetting("flipY", v);
  const setSwapXY = (v: SetArg<boolean>) => setSetting("swapXY", v);
  const setOptimizePaths = (v: SetArg<boolean>) => setSetting("optimizePaths", v);
  const setReversePaths = (v: SetArg<boolean>) => setSetting("reversePaths", v);
  const setPreviewThinLines = (v: SetArg<boolean>) => setSetting("previewThinLines", v);
  const setTestPattern = (v: SetArg<string>) => setSetting("testPattern", v);
  // Any non-"none" pattern means a calibration pattern is showing instead of the
  // loaded SVG. Existing logic keys off this derived boolean.
  const testPatternOn = testPattern !== "none";
  const setLayerLabels = (v: SetArg<Record<string, string>>) => setSetting("layerLabels", v);
  const setLayerColors = (v: SetArg<Record<string, string>>) => setSetting("layerColors", v);

  // The AxiDraw/EBB family lifts the pen with a servo (height %), while the
  // DrawCore/iDraw uses a Z-axis depth. Rather than hide the irrelevant fields,
  // we gray them out based on the connected machine so the UI shape is stable.
  // Before anything connects we don't presume a machine, so both stay enabled.
  const isEbb = conn.driverId === "ebb";
  const isDrawCore = conn.driverId === "drawcore";
  const zFieldsDisabled = isEbb;
  const servoFieldsDisabled = isDrawCore;
  const zHint = isEbb ? "Not used by the AxiDraw — it lifts the pen with a servo (see Pen-up/down height)" : undefined;
  const servoHint = isDrawCore ? "Not used by the iDraw — it sets pen height with the Z axis (see Pen-up/down Z)" : undefined;

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
  // Pre-plot origin confirmation gate (see the "Begin plot" modal below).
  const [originConfirmOpen, setOriginConfirmOpen] = useState(false);
  const [originConfirmed, setOriginConfirmed] = useState(false);
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
            setConn({ connected: true, path: portToUse, version: result.version, driverId: result.driverId, driverName: result.driverName });
            setConnStatus(null);
          } catch (e) {
            setConnStatus({ msg: `Auto-connect failed: ${(e as Error).message}`, kind: "warn" });
          }
        }
      })
      .catch((e) => setConnStatus({ msg: e.message, kind: "error" }));
    const close = openWs((ev) => {
      if (ev.type === "hello" || ev.type === "connection") {
        setConn((prev) => ({
          connected: ev.connected,
          path: ev.path ?? (ev.connected ? prev.path : undefined),
          version: ev.version ?? (ev.connected ? prev.version : undefined),
          driverId: ev.driverId ?? prev.driverId,
          driverName: ev.driverName ?? prev.driverName,
        }));
        if (ev.connected && ev.path) setSelectedPort(ev.path);
      } else if (ev.type === "notice") {
        // Server notices are all connection/origin-on-connect feedback.
        setConnStatus({ msg: ev.message, kind: ev.level === "warn" ? "warn" : "ok" });
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
    // A calibration pattern overrides the displayed SVG, so loading a real one
    // clears it — otherwise the new SVG would be hidden behind the pattern.
    setTestPattern("none");
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
    setFileName(file.name);
    setStatus({ msg: `Loaded ${file.name} (${p.viewBoxWidth.toFixed(0)}×${p.viewBoxHeight.toFixed(0)} units)`, kind: "ok" });
  }, [onSvgLoaded]);

  // Unload the current SVG and clear everything derived from it.
  const clearSvg = () => {
    setParsed(null);
    setFileName("");
    setSvgTree([]);
    setExpandedKeys(new Set());
    setHiddenKeys(new Set());
    setLayerLabels({});
    setLayerColors({});
    setTestPattern("none");
  };

  // Render the loaded SVG as an <img> data URL for the sidebar thumbnail.
  // Using <img> (not innerHTML) keeps the untrusted SVG sandboxed — no scripts.
  // Skip it for very large SVGs: encoding multi-MB text into a data URL (and
  // decoding it for a tiny thumbnail) is a needless main-thread hit. The main
  // canvas still shows the (rasterized) preview.
  const thumbUrl = useMemo(
    () =>
      parsed && parsed.text.length <= MAX_INLINE_SVG_BYTES
        ? `data:image/svg+xml;utf8,${encodeURIComponent(parsed.text)}`
        : null,
    [parsed],
  );

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

  // Aspect ratio is always locked to the source SVG — width and height stay
  // proportional.
  const aspect = parsed ? parsed.naturalWidthMm / parsed.naturalHeightMm : 1;
  const setWidthLocked = (w: number) => {
    setWidthMm(w);
    if (aspect) setHeightMm(Math.round((w / aspect) * 10) / 10);
  };
  const setHeightLocked = (h: number) => {
    setHeightMm(h);
    if (aspect) setWidthMm(Math.round(h * aspect * 10) / 10);
  };

  const testPatternParsed = useMemo<ParsedSvg | null>(() => {
    const pattern = TEST_PATTERNS[testPattern];
    return pattern ? parseSvg(pattern.build(pageW, pageH)) : null;
  }, [testPattern, pageW, pageH]);

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
      penUpPercent,
      penDownPercent,
      flipX,
      flipY,
      swapXY,
      optimizePaths,
      reversePaths,
    }),
    [pageW, pageH, displayOffsetX, displayOffsetY, displayParsed, displayWidthMm, drawSpeed, travelSpeed, penDownDelayMs, penUpDelayMs, penUpZ, penDownZ, penSpeedMmPerMin, penUpPercent, penDownPercent, flipX, flipY, swapXY, optimizePaths, reversePaths]
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
      setConn({ connected: true, path: selectedPort, version: r.version, driverId: r.driverId, driverName: r.driverName });
      setConnStatus(null);
    } catch (e) {
      setConnStatus({ msg: (e as Error).message, kind: "error" });
    }
  };

  const disconnect = async () => {
    try {
      await api.disconnect();
      setConn({ connected: false });
      setConnStatus(null);
    } catch (e) {
      setConnStatus({ msg: (e as Error).message, kind: "error" });
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
    ? Math.min(100,
        ((progress.polylineIndex + (progress.segmentCount
          ? progress.segmentIndex / progress.segmentCount
          : 0)) / progress.polylineCount) * 100)
    : 0;

  // polylineIndex is 0-based while drawing; show a 1-based count to humans so a
  // single-stroke job reads "1/1" instead of "0/1". Terminal phases already
  // report a final index (done sends count/count), so leave those untouched.
  const progressIndexDisplay = progress
    ? (progress.phase === "drawing" || progress.phase === "paused"
        ? Math.min(progress.polylineIndex + 1, progress.polylineCount)
        : progress.polylineIndex)
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
        <div className="section">
        <h2 className="conn-header">
          <span>Connection</span>
          <span
            className={`conn-led ${conn.connected ? "on" : "off"}`}
            role="img"
            aria-label={conn.connected ? "Connected" : "Disconnected"}
            title={conn.connected
              ? `Connected ${conn.path ?? ""}${conn.driverName ? ` · ${conn.driverName}` : ""}${conn.version ? ` · ${conn.version}` : ""}`
              : "Disconnected"}
          />
        </h2>
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
        <div className="row row-2col">
          <button className="secondary" onClick={refreshPorts}>Refresh</button>
          {!conn.connected ? (
            <button onClick={connect} disabled={!selectedPort}>Connect</button>
          ) : (
            <button className="danger" onClick={disconnect}>Disconnect</button>
          )}
        </div>
        {connStatus && <div className={`status ${connStatus.kind === "error" ? "error" : connStatus.kind === "warn" ? "warn" : ""}`}>{connStatus.msg}</div>}
        </div>

        <div className="section">
        <h2>Page</h2>
        <div className="field-grid">
          <div className="field-grid-cell label">Width (in)</div>
          <div className="field-grid-cell">
            <NumberInput
              className="field-input"
              step="0.01" min="0.1" decimals={2}
              value={mmToIn(pageW)}
              onCommit={(v) => setPageW(inToMm(v))}
            />
          </div>
          <div className="field-grid-cell label">Height (in)</div>
          <div className="field-grid-cell">
            <NumberInput
              className="field-input"
              step="0.01" min="0.1" decimals={2}
              value={mmToIn(pageH)}
              onCommit={(v) => setPageH(inToMm(v))}
            />
          </div>
          <div className="field-grid-cell label">Background</div>
          <div className="field-grid-cell page-dims-bg">
            <input
              type="color"
              className="page-bg-swatch"
              value={pageBackground}
              onChange={(e) => setPageBackground(e.target.value)}
              title="Preview only — not plotted"
            />
            <button
              className="page-bg-reset"
              onClick={() => setPageBackground("#ffffff")}
              title="Reset to white"
              aria-label="Reset background to white"
            >
              <RefreshIcon />
            </button>
          </div>
        </div>
        </div>

        <div className="section">
        <h2>Calibration</h2>
        <div className="field-grid">
          <label className="field-grid-cell label" htmlFor="cb-testpattern">Test pattern</label>
          <div className="field-grid-cell">
            <select
              id="cb-testpattern"
              className="field-select"
              value={testPattern}
              onChange={(e) => setTestPattern(e.target.value)}
            >
              <option value="none">None</option>
              {Object.entries(TEST_PATTERNS).map(([id, p]) => (
                <option key={id} value={id}>{p.label}</option>
              ))}
            </select>
          </div>
        </div>
        </div>

        <div className="section">
        <h2>SVG</h2>
        {parsed ? (
          <div
            className={`svg-card${dragHover ? " hover" : ""}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragHover(true); }}
            onDragLeave={() => setDragHover(false)}
            onDrop={onDrop}
            title="Click or drop to replace"
          >
            {thumbUrl && (
              <img
                className="svg-thumb"
                src={thumbUrl}
                alt=""
                style={{ background: pageBackground }}
              />
            )}
            <div className="svg-card-meta">
              <span className="svg-filename" title={fileName || undefined}>
                {fileName || "Untitled.svg"}
              </span>
              <span className="svg-subline">
                {Math.round(parsed.naturalWidthMm)} × {Math.round(parsed.naturalHeightMm)} mm
              </span>
            </div>
            <button
              className="svg-remove"
              onClick={(e) => { e.stopPropagation(); clearSvg(); }}
              title="Remove SVG"
              aria-label="Remove SVG"
            >✕</button>
          </div>
        ) : (
          <div
            className={`file-drop${dragHover ? " hover" : ""}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragHover(true); }}
            onDragLeave={() => setDragHover(false)}
            onDrop={onDrop}
          >
            Drop SVG here · click to browse
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept=".svg,image/svg+xml"
          style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
        />

        {svgTree.length > 0 && (
          <div className={testPatternOn ? "dimmed" : undefined}>
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
          </div>
        )}

        {parsed && (
          <div className={testPatternOn ? "dimmed" : undefined}>
            <div className="field-grid">
              <label className="field-grid-cell label" htmlFor="cb-previewthin">Preview as thin black lines</label>
              <div className="field-grid-cell">
                <input id="cb-previewthin" className="field-checkbox" type="checkbox"
                  checked={previewThinLines} onChange={(e) => setPreviewThinLines(e.target.checked)} />
              </div>
              <div className="field-grid-cell label">Width (mm)</div>
              <div className="field-grid-cell">
                <NumberInput className="field-input" step="0.1" live value={widthMm} onCommit={setWidthLocked} />
              </div>
              <div className="field-grid-cell label">Height (mm)</div>
              <div className="field-grid-cell">
                <NumberInput className="field-input" step="0.1" live value={heightMm} onCommit={setHeightLocked} />
              </div>
              <label className="field-grid-cell label" htmlFor="cb-lockcenter">Lock SVG to center</label>
              <div className="field-grid-cell">
                <input id="cb-lockcenter" className="field-checkbox" type="checkbox"
                  checked={lockCenter} onChange={(e) => setLockCenter(e.target.checked)} />
              </div>
              <div className="field-grid-cell label">Offset X (mm)</div>
              <div className="field-grid-cell">
                <NumberInput className="field-input" step="0.5" decimals={1} value={offsetX} onCommit={setOffsetX} disabled={lockCenter} />
              </div>
              <div className="field-grid-cell label">Offset Y (mm)</div>
              <div className="field-grid-cell">
                <NumberInput className="field-input" step="0.5" decimals={1} value={offsetY} onCommit={setOffsetY} disabled={lockCenter} />
              </div>
              <div className="field-grid-cell label">Rotate 90 degrees</div>
              <div className="field-grid-cell">
                <button className="field-icon-btn" onClick={rotate90} title="Rotate 90°" aria-label="Rotate 90 degrees">
                  <RefreshIcon />
                </button>
              </div>
            </div>
          </div>
        )}
        </div>

        {displayParsed && (
          <div className={`section${testPatternOn ? " dimmed" : ""}`}>
            <h2>Path modifications</h2>
            <div className="field-grid">
              <label className="field-grid-cell label" htmlFor="cb-reverse">Reverse (plot end → start)</label>
              <div className="field-grid-cell">
                <input id="cb-reverse" className="field-checkbox" type="checkbox"
                  checked={reversePaths} onChange={(e) => setReversePaths(e.target.checked)} />
              </div>
              <label className="field-grid-cell label" htmlFor="cb-flipx">Flip X</label>
              <div className="field-grid-cell">
                <input id="cb-flipx" className="field-checkbox" type="checkbox" checked={flipX} onChange={(e) => setFlipX(e.target.checked)} />
              </div>
              <label className="field-grid-cell label" htmlFor="cb-flipy">Flip Y</label>
              <div className="field-grid-cell">
                <input id="cb-flipy" className="field-checkbox" type="checkbox" checked={flipY} onChange={(e) => setFlipY(e.target.checked)} />
              </div>
              <label className="field-grid-cell label" htmlFor="cb-swapxy">Swap X/Y</label>
              <div className="field-grid-cell">
                <input id="cb-swapxy" className="field-checkbox" type="checkbox" checked={swapXY} onChange={(e) => setSwapXY(e.target.checked)} />
              </div>
            </div>
          </div>
        )}

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
          lockedAspect={displayParsed ? displayParsed.naturalWidthMm / displayParsed.naturalHeightMm : null}
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
        <div className="section">
        <h2>Pen speed</h2>
        <div className="field-grid">
          <div className="field-grid-cell label">Draw (mm/s)</div>
          <div className="field-grid-cell">
            <NumberInput className="field-input" min="1" value={drawSpeed} onCommit={setDrawSpeed} />
          </div>
          <div className="field-grid-cell label">Travel (mm/s)</div>
          <div className="field-grid-cell">
            <NumberInput className="field-input" min="1" value={travelSpeed} onCommit={setTravelSpeed} />
          </div>
          <div className="field-grid-cell label">Pen-down delay (ms)</div>
          <div className="field-grid-cell">
            <NumberInput className="field-input" min="0" step="10" value={penDownDelayMs} onCommit={setPenDownDelayMs} />
          </div>
          <div className="field-grid-cell label">Pen-up delay (ms)</div>
          <div className="field-grid-cell">
            <NumberInput className="field-input" min="0" step="10" value={penUpDelayMs} onCommit={setPenUpDelayMs} />
          </div>
          <div className="field-grid-cell label" title={zHint}>Pen-up Z</div>
          <div className="field-grid-cell">
            <NumberInput className="field-input" min="0" max="10" step="0.5" value={penUpZ} onCommit={setPenUpZ} disabled={zFieldsDisabled} title={zHint} />
          </div>
          <div className="field-grid-cell label" title={zHint}>Pen-down Z</div>
          <div className="field-grid-cell">
            <NumberInput className="field-input" min="0" max="10" step="0.5" value={penDownZ} onCommit={setPenDownZ} disabled={zFieldsDisabled} title={zHint} />
          </div>
          <div className="field-grid-cell label" title={zHint}>Pen speed up/down (mm/s)</div>
          <div className="field-grid-cell">
            <NumberInput
              className="field-input"
              min="1" step="1" decimals={1}
              value={penSpeedMmPerMin / 60}
              onCommit={(v) => setPenSpeedMmPerMin(Math.max(1, Math.round(v * 60)))}
              disabled={zFieldsDisabled}
              title={zHint}
            />
          </div>
          <div className="field-grid-cell label" title={servoHint}>Pen-up height (%)</div>
          <div className="field-grid-cell">
            <NumberInput className="field-input" min="0" max="100" step="1" value={penUpPercent} onCommit={setPenUpPercent} disabled={servoFieldsDisabled} title={servoHint} />
          </div>
          <div className="field-grid-cell label" title={servoHint}>Pen-down height (%)</div>
          <div className="field-grid-cell">
            <NumberInput className="field-input" min="0" max="100" step="1" value={penDownPercent} onCommit={setPenDownPercent} disabled={servoFieldsDisabled} title={servoHint} />
          </div>
        </div>
        </div>

        <div className="section section-grow">
        <h2>Instructions</h2>
        {displayParsed && (
          <div className={testPatternOn ? "dimmed" : undefined}>
            <div className="field-grid">
              <label className="field-grid-cell label" htmlFor="cb-optimize">Optimize paths</label>
              <div className="field-grid-cell">
                <input id="cb-optimize" className="field-checkbox" type="checkbox"
                  checked={optimizePaths} onChange={(e) => setOptimizePaths(e.target.checked)} />
              </div>
            </div>
            {optimizePaths && (
              <div className="optimize-summary">
                {optimizeLoading && !optimizeStats && <div className="muted">Analyzing…</div>}
                {optimizeStats && <OptimizeSummary stats={optimizeStats} />}
              </div>
            )}
          </div>
        )}
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
        </div>

        <div className="section">
        <h2>Controls</h2>
        <div className="ctrl-row">
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
          <button className="secondary" onClick={home} disabled={!conn.connected}>Go to 0,0</button>
        </div>
        <div className="ctrl-row">
          <button className="secondary" onClick={penUp} disabled={!conn.connected}>Pen up</button>
          <button className="secondary" onClick={penDown} disabled={!conn.connected}>Pen down</button>
        </div>
        <div className="ctrl-row">
          <div className="ctrl-plot">
            {!plotting && !paused ? (
              <button
                onClick={() => { setOriginConfirmed(false); setOriginConfirmOpen(true); }}
                disabled={!conn.connected || !displayParsed}
              >
                Plot
              </button>
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
          <button className="secondary" onClick={motorsOff} disabled={!conn.connected}>Motors off</button>
        </div>

        <Modal
          open={originConfirmOpen}
          onClose={() => setOriginConfirmOpen(false)}
          title="Set origin before plotting"
        >
          <p className="modal-text">
            Move the pen to the <strong>top-left corner (0,0)</strong> of your
            page and confirm it's positioned there. The plot starts from this
            point.
          </p>
          {originConfirmed && (
            <p className="modal-origin-set">✓ Origin set at the current position.</p>
          )}
          <div className="modal-actions">
            <button
              className="secondary"
              onClick={async () => {
                try {
                  await api.setOrigin();
                  setOriginConfirmed(true);
                  setStatus({ msg: "Origin set at current position", kind: "ok" });
                } catch (e) {
                  setStatus({ msg: (e as Error).message, kind: "error" });
                }
              }}
            >
              Set origin here
            </button>
            <button
              disabled={!originConfirmed}
              title={originConfirmed ? undefined : "Set the origin first"}
              onClick={() => { setOriginConfirmOpen(false); plot(0); }}
            >
              Begin plot
            </button>
          </div>
        </Modal>
        {progress && (
          <>
            <div className="status">
              {progress.phase}: {progressIndexDisplay}/{progress.polylineCount}
            </div>
            <div className="progress-bar"><div style={{ width: `${progressPct}%` }} /></div>
          </>
        )}
        {status && <div className={`status ${status.kind === "error" ? "error" : status.kind === "warn" ? "warn" : ""}`}>{status.msg}</div>}
        </div>
      </aside>
    </div>
  );
}

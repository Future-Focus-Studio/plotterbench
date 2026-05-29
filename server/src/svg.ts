import { parse, INode } from "svgson";
import { svgPathProperties } from "svg-path-properties";

export type Point = { x: number; y: number };
export type Polyline = Point[];

// Affine matrix [a, b, c, d, e, f] → (x', y') = (a*x + c*y + e, b*x + d*y + f)
// The matrix helpers below are exported for unit testing (svg-matrix.test.ts);
// they are pure and have no other external consumers.
export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m1: Matrix, m2: Matrix): Matrix {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ];
}

export function apply(m: Matrix, p: Point): Point {
  const [a, b, c, d, e, f] = m;
  return { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f };
}

export function parseTransform(str: string | undefined): Matrix {
  if (!str) return IDENTITY;
  let m: Matrix = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(str))) {
    const fn = match[1];
    const args = match[2]
      .split(/[ ,]+/)
      .map((s) => parseFloat(s))
      .filter((n) => !Number.isNaN(n));
    let next: Matrix = IDENTITY;
    if (fn === "matrix" && args.length === 6) {
      next = args as Matrix;
    } else if (fn === "translate") {
      next = [1, 0, 0, 1, args[0] ?? 0, args[1] ?? 0];
    } else if (fn === "scale") {
      const sx = args[0] ?? 1;
      const sy = args[1] ?? sx;
      next = [sx, 0, 0, sy, 0, 0];
    } else if (fn === "rotate") {
      const a = ((args[0] ?? 0) * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      if (args.length === 3) {
        const cx = args[1];
        const cy = args[2];
        const t1: Matrix = [1, 0, 0, 1, cx, cy];
        const r: Matrix = [cos, sin, -sin, cos, 0, 0];
        const t2: Matrix = [1, 0, 0, 1, -cx, -cy];
        next = multiply(multiply(t1, r), t2);
      } else {
        next = [cos, sin, -sin, cos, 0, 0];
      }
    } else if (fn === "skewX") {
      next = [1, 0, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    } else if (fn === "skewY") {
      next = [1, Math.tan(((args[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    }
    m = multiply(m, next);
  }
  return m;
}

function samplePath(d: string, tolerance: number): Polyline {
  const props = new svgPathProperties(d);
  const total = props.getTotalLength();
  if (total === 0) return [];
  const n = Math.max(2, Math.ceil(total / Math.max(0.05, tolerance)));
  const pts: Polyline = [];
  for (let i = 0; i <= n; i++) {
    const p = props.getPointAtLength((i / n) * total);
    pts.push({ x: p.x, y: p.y });
  }
  return pts;
}

// Number of parameters consumed per command letter.
const CMD_ARG_COUNT: Record<string, number> = {
  M: 2, L: 2, H: 1, V: 1, Z: 0,
  C: 6, S: 4, Q: 4, T: 2, A: 7,
};

// Tokenize a path d attribute into [command, args] pairs, expanding implicit
// repetition (e.g. "L 1,2 3,4" → two L commands) and converting post-M
// implicit lineto sequences to L/l.
function parseCmds(d: string): [string, number[]][] {
  const result: [string, number[]][] = [];
  const cmdRe = /([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)/g;
  const numRe = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = cmdRe.exec(d))) {
    const letter = m[1];
    const upper = letter.toUpperCase();
    const nums: number[] = [];
    let nm: RegExpExecArray | null;
    numRe.lastIndex = 0;
    while ((nm = numRe.exec(m[2]))) nums.push(parseFloat(nm[0]));
    const n = CMD_ARG_COUNT[upper] ?? 0;
    if (n === 0) {
      result.push([letter, []]);
    } else if (nums.length === 0) {
      result.push([letter, []]);
    } else {
      let first = true;
      for (let i = 0; i + n <= nums.length; i += n) {
        let cmd = letter;
        if (!first && upper === "M") cmd = letter === "M" ? "L" : "l";
        result.push([cmd, nums.slice(i, i + n)]);
        first = false;
      }
    }
  }
  return result;
}

// Flatten a path d string into polylines, emitting straight-command endpoints
// directly and sampling only genuinely curved segments. This avoids the
// serial-command explosion that happens when every segment of a straight path
// is uniformly re-sampled at small intervals.
function flattenPathD(d: string, tolerance: number): Polyline[] {
  const polylines: Polyline[] = [];
  let current: Polyline = [];
  let cx = 0, cy = 0, startX = 0, startY = 0;
  // Last control point, needed to reflect for S and T commands.
  let lastCtrlX = 0, lastCtrlY = 0, lastCurveCmd = "";

  const flush = () => {
    if (current.length >= 2) polylines.push(current);
    current = [];
  };

  const addPt = (x: number, y: number) => {
    const p = current[current.length - 1];
    if (!p || Math.abs(p.x - x) > 1e-9 || Math.abs(p.y - y) > 1e-9)
      current.push({ x, y });
  };

  // Sample a single curve segment expressed as absolute SVG command(s)
  // starting at (cx, cy) and ending at (ex, ey).
  const sampleSeg = (segD: string, ex: number, ey: number) => {
    const props = new svgPathProperties(`M ${cx},${cy} ${segD}`);
    const total = props.getTotalLength();
    if (total === 0) { addPt(ex, ey); return; }
    const n = Math.max(1, Math.ceil(total / Math.max(0.05, tolerance)));
    for (let i = 1; i <= n; i++) {
      const p = props.getPointAtLength((i / n) * total);
      addPt(p.x, p.y);
    }
    addPt(ex, ey);
  };

  for (const [cmd, args] of parseCmds(d)) {
    const upper = cmd.toUpperCase();
    const rel = cmd !== upper;
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    let isCurve = false;

    switch (upper) {
      case "M": {
        flush();
        cx = ox + args[0]; cy = oy + args[1];
        startX = cx; startY = cy;
        current = [{ x: cx, y: cy }];
        break;
      }
      case "L": {
        cx = ox + args[0]; cy = oy + args[1];
        addPt(cx, cy);
        break;
      }
      case "H": {
        cx = ox + args[0];
        addPt(cx, cy);
        break;
      }
      case "V": {
        cy = oy + args[0];
        addPt(cx, cy);
        break;
      }
      case "Z": {
        addPt(startX, startY);
        flush();
        cx = startX; cy = startY;
        break;
      }
      case "C": {
        const [x1, y1, x2, y2, x, y] = rel
          ? args.map((v, i) => v + (i % 2 === 0 ? cx : cy))
          : args;
        sampleSeg(`C ${x1},${y1} ${x2},${y2} ${x},${y}`, x, y);
        lastCtrlX = x2; lastCtrlY = y2;
        cx = x; cy = y; isCurve = true;
        break;
      }
      case "S": {
        const rx = ["C", "S"].includes(lastCurveCmd) ? 2 * cx - lastCtrlX : cx;
        const ry = ["C", "S"].includes(lastCurveCmd) ? 2 * cy - lastCtrlY : cy;
        const [x2, y2, x, y] = rel
          ? [ox + args[0], oy + args[1], ox + args[2], oy + args[3]]
          : args;
        sampleSeg(`C ${rx},${ry} ${x2},${y2} ${x},${y}`, x, y);
        lastCtrlX = x2; lastCtrlY = y2;
        cx = x; cy = y; isCurve = true;
        break;
      }
      case "Q": {
        const [x1, y1, x, y] = rel
          ? [ox + args[0], oy + args[1], ox + args[2], oy + args[3]]
          : args;
        sampleSeg(`Q ${x1},${y1} ${x},${y}`, x, y);
        lastCtrlX = x1; lastCtrlY = y1;
        cx = x; cy = y; isCurve = true;
        break;
      }
      case "T": {
        const rx = ["Q", "T"].includes(lastCurveCmd) ? 2 * cx - lastCtrlX : cx;
        const ry = ["Q", "T"].includes(lastCurveCmd) ? 2 * cy - lastCtrlY : cy;
        const [x, y] = rel ? [ox + args[0], oy + args[1]] : args;
        sampleSeg(`Q ${rx},${ry} ${x},${y}`, x, y);
        lastCtrlX = rx; lastCtrlY = ry;
        cx = x; cy = y; isCurve = true;
        break;
      }
      case "A": {
        const [rx, ry, xRot, laf, sf] = args;
        const [x, y] = rel ? [ox + args[5], oy + args[6]] : [args[5], args[6]];
        sampleSeg(`A ${rx},${ry} ${xRot} ${laf} ${sf} ${x},${y}`, x, y);
        cx = x; cy = y; isCurve = true;
        break;
      }
    }

    if (isCurve) lastCurveCmd = upper;
    else if (upper !== "M") lastCurveCmd = "";
  }

  flush();
  return polylines;
}

function polylineFromPoints(str: string | undefined): Polyline {
  if (!str) return [];
  return str
    .trim()
    .split(/[\s,]+/)
    .reduce<number[]>((acc, v) => {
      const n = parseFloat(v);
      if (!Number.isNaN(n)) acc.push(n);
      return acc;
    }, [])
    .reduce<Polyline>((acc, _, i, arr) => {
      if (i % 2 === 0 && i + 1 < arr.length) acc.push({ x: arr[i], y: arr[i + 1] });
      return acc;
    }, []);
}

function shapeToPathD(node: INode): string | null {
  const a = node.attributes;
  switch (node.name) {
    case "line": {
      const x1 = +a.x1, y1 = +a.y1, x2 = +a.x2, y2 = +a.y2;
      return `M${x1},${y1} L${x2},${y2}`;
    }
    case "rect": {
      const x = +a.x || 0, y = +a.y || 0, w = +a.width, h = +a.height;
      return `M${x},${y} h${w} v${h} h${-w} Z`;
    }
    case "circle": {
      const cx = +a.cx, cy = +a.cy, r = +a.r;
      return `M${cx - r},${cy} a${r},${r} 0 1,0 ${2 * r},0 a${r},${r} 0 1,0 ${-2 * r},0 Z`;
    }
    case "ellipse": {
      const cx = +a.cx, cy = +a.cy, rx = +a.rx, ry = +a.ry;
      return `M${cx - rx},${cy} a${rx},${ry} 0 1,0 ${2 * rx},0 a${rx},${ry} 0 1,0 ${-2 * rx},0 Z`;
    }
    default:
      return null;
  }
}

// Elements that define resources but never render themselves. Anything inside
// one of these is a template (gradient stops, clip shapes, filter primitives,
// marker glyphs, etc.) and must NOT be plotted. Also includes metadata and
// Inkscape's <plotdata> extension.
const NON_RENDERING_TAGS = new Set([
  "defs",
  "clippath",
  "mask",
  "symbol",
  "pattern",
  "marker",
  "filter",
  "style",
  "metadata",
  "title",
  "desc",
  "script",
  "lineargradient",
  "radialgradient",
  "foreignobject",
  "plotdata",
]);

/**
 * svg-path-properties occasionally returns a regression — a single sample that
 * jumps off-curve and back — when asked for very dense samples. We can't
 * always lower density (callers may legitimately request fine sampling), so
 * we filter the output: any chord more than 10× the median chord of the
 * polyline AND larger than 1 unit is treated as a spike and the offending
 * point is dropped. Real curves don't produce isolated 10× chord jumps.
 */
function dropChordSpikes(pts: Polyline): Polyline {
  if (pts.length < 4) return pts;
  const chords: number[] = new Array(pts.length - 1);
  for (let i = 1; i < pts.length; i++) {
    chords[i - 1] = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  const sorted = [...chords].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  if (median <= 0) return pts;
  const threshold = Math.max(median * 10, 1);
  const out: Polyline = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    if (chords[i - 1] > threshold) continue; // skip the suspect endpoint
    out.push(pts[i]);
  }
  return out;
}

export interface FlattenOptions {
  /**
   * Max chord length when sampling curves, in physical millimetres.
   * The flattener converts this to SVG user units using `mmPerUnit`.
   * Default 0.25mm — fine enough for smooth pen output, coarse enough to
   * keep the planner buffer happy.
   */
  maxChordMm?: number;
  /**
   * Conversion factor from SVG user units to physical millimetres on the
   * plot. Defaults to 1 (which is right for SVGs already drawn in mm).
   * For an SVG with viewBox `0 0 1000 1000` rendered onto a 200mm-wide
   * page, this is 200/1000 = 0.2.
   */
  mmPerUnit?: number;
  /**
   * Direct user-unit override for the sampling chord. If set, takes
   * precedence over maxChordMm/mmPerUnit. Mostly for tests.
   */
  toleranceUu?: number;
}

export interface FlattenResult {
  polylines: Polyline[];
  /** Source viewport in SVG user units (used for fitting into a page). */
  viewBox: { x: number; y: number; width: number; height: number };
}

export async function flattenSvg(svgText: string, opts: FlattenOptions = {}): Promise<FlattenResult> {
  const maxChordMm = opts.maxChordMm ?? 0.25;
  const mmPerUnit = opts.mmPerUnit ?? 1;
  // Floor at 0.05 user-units to avoid pathological cases where mmPerUnit is
  // huge (tiny SVG scaled up). svg-path-properties starts producing precision
  // spikes when asked for >~10k samples per segment, so we also cap density
  // from below at the consumer level (see drop-spikes filter).
  const tolerance = opts.toleranceUu ?? Math.max(0.05, maxChordMm / Math.max(mmPerUnit, 1e-9));
  const root = await parse(svgText);

  let viewBox = { x: 0, y: 0, width: 100, height: 100 };
  const vb = root.attributes.viewBox;
  if (vb) {
    const parts = vb.split(/[\s,]+/).map((n) => parseFloat(n));
    if (parts.length === 4 && parts.every((n) => !Number.isNaN(n))) {
      viewBox = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] };
    }
  } else if (root.attributes.width && root.attributes.height) {
    viewBox = {
      x: 0,
      y: 0,
      width: parseFloat(root.attributes.width) || 100,
      height: parseFloat(root.attributes.height) || 100,
    };
  }

  const polylines: Polyline[] = [];

  const visit = (node: INode, parentTransform: Matrix) => {
    const tag = node.name?.toLowerCase();
    // Skip non-rendering containers AND all their descendants. Otherwise the
    // flattener will plot shapes defined inside <defs>, <clipPath>, etc.
    if (tag && NON_RENDERING_TAGS.has(tag)) return;
    const t = multiply(parentTransform, parseTransform(node.attributes?.transform));
    let raw: Polyline[] = [];

    if (node.name === "path" && node.attributes.d) {
      raw = flattenPathD(node.attributes.d, tolerance);
    } else if (node.name === "polyline" || node.name === "polygon") {
      const pts = polylineFromPoints(node.attributes.points);
      if (pts.length) {
        if (node.name === "polygon" && pts.length > 1) pts.push(pts[0]);
        raw = [pts];
      }
    } else if (node.name === "line") {
      const a = node.attributes;
      raw = [[{ x: +a.x1, y: +a.y1 }, { x: +a.x2, y: +a.y2 }]];
    } else if (node.name === "rect") {
      const a = node.attributes;
      const x = +a.x || 0, y = +a.y || 0, w = +a.width, h = +a.height;
      raw = [[
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
        { x, y },
      ]];
    } else {
      const d = shapeToPathD(node);
      if (d) raw = [samplePath(d, tolerance)];
    }

    for (const pl of raw) {
      if (pl.length < 2) continue;
      const transformed = pl.map((p) => apply(t, p));
      polylines.push(dropChordSpikes(transformed));
    }

    for (const child of node.children || []) visit(child, t);
  };

  visit(root, IDENTITY);
  return { polylines, viewBox };
}

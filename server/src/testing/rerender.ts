// Headless capture harness — re-render & compare (backlog task 31).
//
// Parses a captured command stream back into the polylines it would draw, in the
// driver's *machine* coordinate frame (millimetres). Comparing these against the
// geometry the engine intended to plot (planPolylines → toMachineCoords) is a
// protocol-independent fidelity check on the whole flatten → transform → optimize
// → emit pipeline: if the commands re-rasterize to the input within tolerance,
// the geometry survived the round trip.
//
// Re-render is the inverse of each driver's emitter, so it necessarily mirrors a
// little of that protocol knowledge (DrawCore: absolute G-code with a Z pen axis;
// EBB: relative CoreXY stepper deltas with a servo pen). It is deliberately
// minimal — it interprets only the commands the plot path emits.

import { Point, Polyline } from "../svg.js";
import { STEP_SCALE, MM_PER_INCH } from "../drivers/ebb.js";

/** Pull the last numeric value for an axis letter out of a G-code line. */
function axisValue(line: string, axis: "X" | "Y" | "Z"): number | null {
  const m = line.match(new RegExp(`${axis}(-?\\d*\\.?\\d+)`));
  return m ? parseFloat(m[1]) : null;
}

/**
 * Re-render a DrawCore (G-code) stream. Pen is DOWN when the Z axis is at
 * `penDownZ`; absolute G1 moves advance the carriage. A new polyline opens on
 * pen-down and closes on pen-up.
 */
export function rerenderDrawCore(commands: string[], penDownZ: number): Polyline[] {
  const out: Polyline[] = [];
  let cur: Polyline = [];
  let x = 0;
  let y = 0;
  let down = false;

  const flush = () => {
    if (cur.length >= 1) out.push(cur);
    cur = [];
  };

  for (const raw of commands) {
    const line = raw.trim();
    // G92 sets the origin without moving; the plot path never emits it, but guard
    // so a stray one can't be misread as a move to (0,0).
    if (line.startsWith("G92")) continue;

    const z = axisValue(line, "Z");
    if (z !== null) {
      const nowDown = Math.abs(z - penDownZ) < 1e-6;
      if (nowDown && !down) {
        cur = [{ x, y }];
      } else if (!nowDown && down) {
        flush();
      }
      down = nowDown;
      continue; // pen-lift moves carry no X/Y.
    }

    const nx = axisValue(line, "X");
    const ny = axisValue(line, "Y");
    if (nx === null && ny === null) continue;
    if (nx !== null) x = nx;
    if (ny !== null) y = ny;
    if (down) cur.push({ x, y });
  }
  flush();
  return out;
}

/**
 * Re-render an EBB stream. The host tracks absolute motor steps; `SM` carries the
 * per-motor delta of a CoreXY move, which inverts to an XY millimetre position.
 * `SP,0` lowers the pen (open a polyline), `SP,1` raises it (close). `CS` zeroes
 * the step counters.
 */
export function rerenderEbb(commands: string[]): Polyline[] {
  const out: Polyline[] = [];
  let cur: Polyline = [];
  let m1 = 0;
  let m2 = 0;
  let down = false;

  const point = (): Point => {
    const xIn = (m1 + m2) / (2 * STEP_SCALE);
    const yIn = (m1 - m2) / (2 * STEP_SCALE);
    return { x: xIn * MM_PER_INCH, y: yIn * MM_PER_INCH };
  };
  const flush = () => {
    if (cur.length >= 1) out.push(cur);
    cur = [];
  };

  for (const raw of commands) {
    const parts = raw.trim().split(",");
    const head = parts[0];
    if (head === "CS") {
      m1 = 0;
      m2 = 0;
    } else if (head === "SP") {
      const nowDown = parts[1] === "0";
      if (nowDown && !down) {
        cur = [point()];
      } else if (!nowDown && down) {
        flush();
      }
      down = nowDown;
    } else if (head === "SM") {
      const d1 = parseInt(parts[2] ?? "0", 10) || 0;
      const d2 = parseInt(parts[3] ?? "0", 10) || 0;
      if (d1 === 0 && d2 === 0) continue; // a zero-delta SM is a timed dwell, not a move.
      m1 += d1;
      m2 += d2;
      if (down) cur.push(point());
    }
  }
  flush();
  return out;
}

// ---- Geometry comparison (curve-aware Hausdorff) ----

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Shortest distance from point `p` to the segment [a, b]. */
function pointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Shortest distance from `p` to the polyline (its segments, or its single vertex). */
function pointToPolyline(p: Point, pl: Polyline): number {
  if (pl.length === 1) return distance(p, pl[0]);
  let min = Infinity;
  for (let i = 1; i < pl.length; i++) {
    min = Math.min(min, pointToSegment(p, pl[i - 1], pl[i]));
  }
  return min;
}

function directedHausdorff(a: Polyline, b: Polyline): number {
  let max = 0;
  for (const p of a) max = Math.max(max, pointToPolyline(p, b));
  return max;
}

/**
 * Symmetric Hausdorff distance between two polylines treated as curves (each
 * sampled point measured to the *segments* of the other, not just its vertices),
 * so a finely-subdivided re-render compares cleanly against a coarse intended
 * polyline.
 */
export function hausdorff(a: Polyline, b: Polyline): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  return Math.max(directedHausdorff(a, b), directedHausdorff(b, a));
}

export interface FidelityResult {
  ok: boolean;
  /** Worst per-polyline Hausdorff distance (mm). */
  maxDeviation: number;
  expectedCount: number;
  actualCount: number;
  /** Set when the polyline counts differ (a structural, not tolerance, failure). */
  countMismatch: boolean;
}

/**
 * Compare re-rendered polylines against the intended geometry, polyline by
 * polyline. Counts must match (same number of strokes); each pair must agree
 * within `toleranceMm`.
 */
export function compareGeometry(
  expected: Polyline[],
  actual: Polyline[],
  toleranceMm: number,
): FidelityResult {
  const countMismatch = expected.length !== actual.length;
  let maxDeviation = 0;
  const n = Math.min(expected.length, actual.length);
  for (let i = 0; i < n; i++) {
    maxDeviation = Math.max(maxDeviation, hausdorff(expected[i], actual[i]));
  }
  return {
    ok: !countMismatch && maxDeviation <= toleranceMm,
    maxDeviation,
    expectedCount: expected.length,
    actualCount: actual.length,
    countMismatch,
  };
}

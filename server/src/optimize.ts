import { Point, Polyline } from "./svg.js";
import { OptimizeStats } from "../../shared/types.js";

// `OptimizeStats` is defined once in shared/types.ts; re-export for importers.
export type { OptimizeStats };

function dist(a: Point, b: Point): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function polylineLength(pl: Polyline): number {
  let d = 0;
  for (let i = 1; i < pl.length; i++) d += dist(pl[i - 1], pl[i]);
  return d;
}

/** Pen-up travel: sum of distances from origin → first start, then each end → next start. */
function travelDistance(polylines: Polyline[], start: Point = { x: 0, y: 0 }): number {
  if (polylines.length === 0) return 0;
  let d = dist(start, polylines[0][0]);
  for (let i = 1; i < polylines.length; i++) {
    d += dist(polylines[i - 1][polylines[i - 1].length - 1], polylines[i][0]);
  }
  return d;
}

/**
 * Reorder polylines using a greedy nearest-neighbor heuristic. At each step we
 * pick whichever polyline has a start OR end closest to the current pen
 * position, reversing it if its end is closer. Starting pen position defaults
 * to (0, 0). Returns the reordered polylines and the count of reversals.
 */
function greedyReorder(input: Polyline[]): { polylines: Polyline[]; reversed: number } {
  const remaining = input.slice();
  const out: Polyline[] = [];
  let reversed = 0;
  let cur: Point = { x: 0, y: 0 };
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestReverse = false;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const pl = remaining[i];
      const ds = dist(cur, pl[0]);
      const de = dist(cur, pl[pl.length - 1]);
      if (ds < bestDist) { bestDist = ds; bestIdx = i; bestReverse = false; }
      if (de < bestDist) { bestDist = de; bestIdx = i; bestReverse = true; }
    }
    const [pl] = remaining.splice(bestIdx, 1);
    const chosen = bestReverse ? [...pl].reverse() : pl;
    if (bestReverse) reversed++;
    out.push(chosen);
    cur = chosen[chosen.length - 1];
  }
  return { polylines: out, reversed };
}

/**
 * Merge consecutive polylines whose shared endpoint is within `tol`. Reordering
 * must happen first, since this only inspects adjacent polylines in the input
 * list. Returns the merged polylines and the count of merges performed.
 */
function mergeAdjacent(input: Polyline[], tol: number): { polylines: Polyline[]; merged: number } {
  const out: Polyline[] = [];
  let merged = 0;
  for (const pl of input) {
    if (pl.length < 2) continue;
    const last = out[out.length - 1];
    if (last) {
      const lastEnd = last[last.length - 1];
      if (dist(lastEnd, pl[0]) <= tol) {
        for (let i = 1; i < pl.length; i++) last.push(pl[i]);
        merged++;
        continue;
      }
    }
    out.push(pl.slice());
  }
  return { polylines: out, merged };
}

export function optimizePolylines(
  input: Polyline[],
  mergeToleranceMm = 0.05
): { polylines: Polyline[]; stats: OptimizeStats } {
  const valid = input.filter((pl) => pl.length >= 2);
  const originalCount = valid.length;
  const originalTravel = travelDistance(valid);
  const drawDistance = valid.reduce((sum, pl) => sum + polylineLength(pl), 0);

  if (originalCount === 0) {
    return {
      polylines: [],
      stats: {
        originalCount: 0, optimizedCount: 0,
        reversed: 0, merged: 0,
        originalTravel: 0, optimizedTravel: 0,
        drawDistance: 0,
      },
    };
  }

  const reordered = greedyReorder(valid);
  const mergedResult = mergeAdjacent(reordered.polylines, mergeToleranceMm);
  const optimizedTravel = travelDistance(mergedResult.polylines);

  return {
    polylines: mergedResult.polylines,
    stats: {
      originalCount,
      optimizedCount: mergedResult.polylines.length,
      reversed: reordered.reversed,
      merged: mergedResult.merged,
      originalTravel,
      optimizedTravel,
      drawDistance,
    },
  };
}

import { describe, it, expect } from "vitest";
import { optimizePolylines } from "../src/optimize.js";
import type { Polyline } from "../src/svg.js";

// optimizePolylines is the only public entry point; its returned `stats`
// directly expose the behavior of the private helpers (greedyReorder →
// `reversed`, mergeAdjacent → `merged`, travelDistance → the travel figures),
// so we exercise all of them through it.

describe("optimizePolylines", () => {
  it("returns all-zero stats for empty input", () => {
    const { polylines, stats } = optimizePolylines([]);
    expect(polylines).toEqual([]);
    expect(stats).toEqual({
      originalCount: 0,
      optimizedCount: 0,
      reversed: 0,
      merged: 0,
      originalTravel: 0,
      optimizedTravel: 0,
      drawDistance: 0,
    });
  });

  it("drops polylines with fewer than 2 points before counting", () => {
    const input: Polyline[] = [
      [{ x: 0, y: 0 }], // single point — invalid
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ],
    ];
    const { stats } = optimizePolylines(input);
    expect(stats.originalCount).toBe(1);
  });

  it("reports draw distance as the summed segment length, unchanged by optimization", () => {
    const input: Polyline[] = [
      [
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 5, y: 5 },
      ],
    ];
    const { stats } = optimizePolylines(input);
    expect(stats.drawDistance).toBeCloseTo(10);
  });

  it("reorders polylines to cut pen-up travel", () => {
    // Input order forces a long origin→far hop; greedy should pick the near
    // polyline first and shrink total travel.
    const near: Polyline = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    const far: Polyline = [
      { x: 10, y: 0 },
      { x: 11, y: 0 },
    ];
    const { polylines, stats } = optimizePolylines([far, near]);
    expect(polylines[0][0]).toEqual({ x: 0, y: 0 }); // near drawn first
    expect(stats.reversed).toBe(0);
    expect(stats.merged).toBe(0);
    expect(stats.optimizedTravel).toBeLessThan(stats.originalTravel);
  });

  it("reverses a polyline when its end is closer than its start", () => {
    const a: Polyline = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    // Drawn right-to-left, so after A the pen is at (1,0) and B's end (10,0)
    // is closer than its start (11,0).
    const b: Polyline = [
      { x: 11, y: 0 },
      { x: 10, y: 0 },
    ];
    const { polylines, stats } = optimizePolylines([a, b]);
    expect(stats.reversed).toBe(1);
    expect(polylines[1]).toEqual([
      { x: 10, y: 0 },
      { x: 11, y: 0 },
    ]);
  });

  it("merges adjacent polylines whose endpoints touch within tolerance", () => {
    const a: Polyline = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
    ];
    const b: Polyline = [
      { x: 5, y: 0 },
      { x: 5, y: 5 },
    ];
    const { polylines, stats } = optimizePolylines([a, b]);
    expect(stats.merged).toBe(1);
    expect(stats.optimizedCount).toBe(1);
    expect(polylines[0]).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 5 },
    ]);
  });

  it("does not merge endpoints that are farther apart than the tolerance", () => {
    const a: Polyline = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
    ];
    const b: Polyline = [
      { x: 6, y: 0 },
      { x: 6, y: 5 },
    ];
    const { stats } = optimizePolylines([a, b], 0.05);
    expect(stats.merged).toBe(0);
    expect(stats.optimizedCount).toBe(2);
  });
});

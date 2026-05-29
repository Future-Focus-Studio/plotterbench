import { describe, it, expect } from "vitest";
import {
  toMachineCoords,
  transformPolylines,
  clampToPage,
  subdivide,
  planPolylines,
} from "../src/plotter.js";
import { DEFAULT_PLOT_OPTIONS, PlotOptions } from "../../shared/types.js";
import type { FlattenResult, Polyline } from "../src/svg.js";

const opts = (overrides: Partial<PlotOptions> = {}): PlotOptions => ({
  ...DEFAULT_PLOT_OPTIONS,
  ...overrides,
});

const flat = (polylines: Polyline[]): FlattenResult => ({
  polylines,
  viewBox: { x: 0, y: 0, width: 100, height: 100 },
});

describe("toMachineCoords", () => {
  it("passes coordinates through when no flips or swap are set", () => {
    expect(toMachineCoords(10, 20, opts({ flipX: false, flipY: false, swapXY: false }))).toEqual([10, 20]);
  });

  it("negates X / Y for flipX / flipY", () => {
    expect(toMachineCoords(10, 20, opts({ flipX: true, flipY: false, swapXY: false }))).toEqual([-10, 20]);
    expect(toMachineCoords(10, 20, opts({ flipX: false, flipY: true, swapXY: false }))).toEqual([10, -20]);
  });

  it("swaps axes after applying flips", () => {
    expect(toMachineCoords(10, 20, opts({ flipX: false, flipY: false, swapXY: true }))).toEqual([20, 10]);
    expect(toMachineCoords(10, 20, opts({ flipX: true, flipY: false, swapXY: true }))).toEqual([20, -10]);
  });
});

describe("transformPolylines", () => {
  it("scales by svgUnitsToMm then adds the offset", () => {
    const result = transformPolylines(
      [
        [
          { x: 1, y: 1 },
          { x: 2, y: 2 },
        ],
      ],
      opts({ svgUnitsToMm: 2, offsetXMm: 5, offsetYMm: 3 })
    );
    expect(result).toEqual([
      [
        { x: 7, y: 5 },
        { x: 9, y: 7 },
      ],
    ]);
  });
});

describe("clampToPage", () => {
  const page = opts({ pageWidthMm: 100, pageHeightMm: 80 });

  it("leaves in-bounds points untouched", () => {
    expect(clampToPage({ x: 50, y: 50 }, page)).toEqual({ x: 50, y: 50 });
  });

  it("clamps to the page edges", () => {
    expect(clampToPage({ x: -5, y: 50 }, page)).toEqual({ x: 0, y: 50 });
    expect(clampToPage({ x: 120, y: 90 }, page)).toEqual({ x: 100, y: 80 });
  });
});

describe("subdivide", () => {
  it("returns just the endpoint when the segment is within maxLen", () => {
    expect(subdivide({ x: 0, y: 0 }, { x: 3, y: 0 }, 5)).toEqual([{ x: 3, y: 0 }]);
  });

  it("splits a long segment into evenly spaced points ending at b", () => {
    const pts = subdivide({ x: 0, y: 0 }, { x: 10, y: 0 }, 5);
    expect(pts).toEqual([
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ]);
  });

  it("uses ceil(d/maxLen) sub-segments and always lands exactly on b", () => {
    const pts = subdivide({ x: 0, y: 0 }, { x: 10, y: 0 }, 3);
    expect(pts).toHaveLength(4); // ceil(10/3)
    expect(pts[pts.length - 1]).toEqual({ x: 10, y: 0 });
  });
});

describe("planPolylines", () => {
  it("applies the transform then clamps to the page", () => {
    const result = planPolylines(
      flat([
        [
          { x: 0, y: 0 },
          { x: 200, y: 0 },
        ],
      ]),
      opts({ svgUnitsToMm: 1, offsetXMm: 0, offsetYMm: 0, pageWidthMm: 100, pageHeightMm: 100 })
    );
    // The far x is clamped to the page width.
    expect(result).toEqual([
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
    ]);
  });

  it("reverses both polyline order and point order when reversePaths is set", () => {
    const result = planPolylines(
      flat([
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
        [
          { x: 2, y: 0 },
          { x: 3, y: 0 },
        ],
      ]),
      opts({ reversePaths: true })
    );
    expect(result).toEqual([
      [
        { x: 3, y: 0 },
        { x: 2, y: 0 },
      ],
      [
        { x: 1, y: 0 },
        { x: 0, y: 0 },
      ],
    ]);
  });

  it("reorders nearest-first when optimizePaths is set", () => {
    const result = planPolylines(
      flat([
        [
          { x: 10, y: 0 },
          { x: 11, y: 0 },
        ],
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
        ],
      ]),
      opts({ optimizePaths: true })
    );
    expect(result[0][0]).toEqual({ x: 0, y: 0 });
  });
});

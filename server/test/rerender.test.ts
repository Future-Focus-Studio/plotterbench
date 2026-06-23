import { describe, it, expect } from "vitest";
import { rerenderDrawCore, rerenderEbb, hausdorff, compareGeometry } from "../src/testing/rerender.js";
import { STEP_SCALE, MM_PER_INCH } from "../src/drivers/ebb.js";

// Unit coverage for the command-stream → geometry inverse, so a bug here can't
// be silently cancelled out by a matching bug in the emitter during the
// card round-trip (capture-harness.test.ts).

describe("rerenderDrawCore", () => {
  it("opens a polyline on pen-down and closes it on pen-up", () => {
    const out = rerenderDrawCore(
      [
        "G90 G1 X10.000 Y10.000 F4800", // travel (pen up) — not recorded
        "G90 G1 Z5.00 F4000", // pen down at (10,10)
        "G90 G1 X20.000 Y10.000 F2400",
        "G90 G1 X20.000 Y20.000 F2400",
        "G90 G1 Z0.00 F4000", // pen up — close
        "G90 G1 X0.000 Y0.000 F4800", // travel home — not recorded
      ],
      5, // penDownZ
    );
    expect(out).toEqual([
      [
        { x: 10, y: 10 },
        { x: 20, y: 10 },
        { x: 20, y: 20 },
      ],
    ]);
  });

  it("treats the larger Z as pen-down via the supplied penDownZ", () => {
    const out = rerenderDrawCore(
      ["G90 G1 X1.000 Y1.000 F1", "G90 G1 Z5.00 F1", "G90 G1 X2.000 Y1.000 F1", "G90 G1 Z0.00 F1"],
      5,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(2);
  });
});

describe("rerenderEbb", () => {
  it("inverts CoreXY SM deltas back to millimetres", () => {
    // A pure +X move of 1 inch: Motor1 = +STEP_SCALE, Motor2 = +STEP_SCALE.
    const out = rerenderEbb([
      "SP,0,150", // pen down at origin
      `SM,100,${STEP_SCALE},${STEP_SCALE}`, // +1 inch in X
      "SP,1,150", // pen up
    ]);
    expect(out).toHaveLength(1);
    expect(out[0][0]).toEqual({ x: 0, y: 0 });
    expect(out[0][1].x).toBeCloseTo(MM_PER_INCH, 6);
    expect(out[0][1].y).toBeCloseTo(0, 6);
  });

  it("resets the step counters on CS", () => {
    const out = rerenderEbb([
      `SM,100,${STEP_SCALE},${STEP_SCALE}`, // move before zeroing (pen up, ignored)
      "CS",
      "SP,0,150",
      `SM,100,0,${2 * STEP_SCALE}`, // Motor2 only → +X -Y diagonal
      "SP,1,150",
    ]);
    expect(out[0][0]).toEqual({ x: 0, y: 0 }); // CS re-zeroed before the stroke
    expect(out[0][1].x).toBeCloseTo(MM_PER_INCH, 6);
    expect(out[0][1].y).toBeCloseTo(-MM_PER_INCH, 6);
  });

  it("ignores zero-delta dwell moves", () => {
    const out = rerenderEbb(["SP,0,150", "SM,750,0,0", "SP,1,150"]);
    expect(out).toEqual([[{ x: 0, y: 0 }]]);
  });
});

describe("hausdorff", () => {
  it("is ~0 for a polyline against a finer subdivision of itself", () => {
    const coarse = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const fine = [
      { x: 0, y: 0 },
      { x: 2.5, y: 0 },
      { x: 5, y: 0 },
      { x: 7.5, y: 0 },
      { x: 10, y: 0 },
    ];
    expect(hausdorff(coarse, fine)).toBeCloseTo(0, 9);
  });

  it("measures points to segments, not just vertices", () => {
    // The apex sits 1 above the straight chord. Both endpoints coincide, so the
    // only deviation is the apex measured to the chord's *segment* — 1, not the
    // ~5.1 it would be if distance were taken to the chord's nearest vertex.
    const tent = [
      { x: 0, y: 0 },
      { x: 5, y: 1 },
      { x: 10, y: 0 },
    ];
    const chord = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    expect(hausdorff(tent, chord)).toBeCloseTo(1, 9);
  });
});

describe("compareGeometry", () => {
  it("flags a stroke-count mismatch as a structural failure", () => {
    const result = compareGeometry([[{ x: 0, y: 0 }, { x: 1, y: 0 }]], [], 0.1);
    expect(result.countMismatch).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("passes matching geometry within tolerance", () => {
    const expected = [[{ x: 0, y: 0 }, { x: 10, y: 0 }]];
    const actual = [[{ x: 0, y: 0 }, { x: 5, y: 0.01 }, { x: 10, y: 0 }]];
    const result = compareGeometry(expected, actual, 0.05);
    expect(result.ok).toBe(true);
  });
});

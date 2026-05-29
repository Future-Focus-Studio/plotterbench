import { describe, it, expect } from "vitest";
import { multiply, apply, parseTransform, IDENTITY, type Matrix } from "../src/svg.js";

describe("multiply", () => {
  it("treats IDENTITY as a left and right identity", () => {
    const m: Matrix = [2, 3, 4, 5, 6, 7];
    expect(multiply(IDENTITY, m)).toEqual(m);
    expect(multiply(m, IDENTITY)).toEqual(m);
  });

  it("composes such that m1*m2 applies m2 first", () => {
    const translate: Matrix = [1, 0, 0, 1, 10, 0];
    const scale: Matrix = [2, 0, 0, 2, 0, 0];
    // (translate * scale) applied to a point should scale then translate.
    const composed = multiply(translate, scale);
    expect(apply(composed, { x: 1, y: 1 })).toEqual({ x: 12, y: 2 });
  });
});

describe("apply", () => {
  it("leaves a point unchanged under IDENTITY", () => {
    expect(apply(IDENTITY, { x: 3, y: 4 })).toEqual({ x: 3, y: 4 });
  });

  it("applies translation", () => {
    expect(apply([1, 0, 0, 1, 5, 7], { x: 2, y: 3 })).toEqual({ x: 7, y: 10 });
  });

  it("applies scaling", () => {
    expect(apply([2, 0, 0, 3, 0, 0], { x: 2, y: 3 })).toEqual({ x: 4, y: 9 });
  });
});

describe("parseTransform", () => {
  it("returns IDENTITY for undefined or unrecognized input", () => {
    expect(parseTransform(undefined)).toEqual(IDENTITY);
    expect(parseTransform("")).toEqual(IDENTITY);
  });

  it("parses translate with one or two args", () => {
    expect(parseTransform("translate(5, 7)")).toEqual([1, 0, 0, 1, 5, 7]);
    expect(parseTransform("translate(5)")).toEqual([1, 0, 0, 1, 5, 0]);
  });

  it("parses uniform and non-uniform scale", () => {
    expect(parseTransform("scale(2)")).toEqual([2, 0, 0, 2, 0, 0]);
    expect(parseTransform("scale(2, 3)")).toEqual([2, 0, 0, 3, 0, 0]);
  });

  it("parses a raw matrix(...)", () => {
    expect(parseTransform("matrix(1, 2, 3, 4, 5, 6)")).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("parses rotate as a quarter-turn that maps (1,0) to (0,1)", () => {
    const m = parseTransform("rotate(90)");
    const p = apply(m, { x: 1, y: 0 });
    expect(p.x).toBeCloseTo(0);
    expect(p.y).toBeCloseTo(1);
  });

  it("rotates about a center point", () => {
    // 180° about (5,5) maps (5,0) → (5,10).
    const m = parseTransform("rotate(180, 5, 5)");
    const p = apply(m, { x: 5, y: 0 });
    expect(p.x).toBeCloseTo(5);
    expect(p.y).toBeCloseTo(10);
  });

  it("composes multiple transforms left-to-right", () => {
    // translate(10,0) then scale(2): point (1,1) scales to (2,2) then shifts.
    const m = parseTransform("translate(10, 0) scale(2)");
    expect(apply(m, { x: 1, y: 1 })).toEqual({ x: 12, y: 2 });
  });
});

import { describe, it, expect } from "vitest";
import { parseLength, lengthToMm } from "@shared/svg-units.js";

describe("parseLength", () => {
  it("splits value and unit", () => {
    expect(parseLength("10.5mm")).toEqual({ n: 10.5, unit: "mm" });
    expect(parseLength("  42  ")).toEqual({ n: 42, unit: "" });
    expect(parseLength("-3.2e1px")).toEqual({ n: -32, unit: "px" });
  });

  it("returns null for empty or non-numeric input", () => {
    expect(parseLength(null)).toBeNull();
    expect(parseLength("")).toBeNull();
    expect(parseLength("auto")).toBeNull();
  });
});

describe("lengthToMm", () => {
  it("converts absolute units to millimetres", () => {
    expect(lengthToMm("10mm")).toBeCloseTo(10);
    expect(lengthToMm("1cm")).toBeCloseTo(10);
    expect(lengthToMm("1in")).toBeCloseTo(25.4);
    expect(lengthToMm("72pt")).toBeCloseTo(25.4);
    expect(lengthToMm("6pc")).toBeCloseTo(25.4);
  });

  it("treats unitless and px as CSS pixels (96px = 1in)", () => {
    expect(lengthToMm("96")).toBeCloseTo(25.4);
    expect(lengthToMm("96px")).toBeCloseTo(25.4);
  });

  it("returns null for percentages and unknown units", () => {
    expect(lengthToMm("50%")).toBeNull();
    expect(lengthToMm("3em")).toBeNull();
    expect(lengthToMm(undefined)).toBeNull();
  });
});

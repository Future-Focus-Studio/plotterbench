import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { flattenSvg } from "../src/svg.js";

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

describe("flattenSvg", () => {
  it("parses the viewBox and flattens a rect into a closed 5-point polyline", async () => {
    const { polylines, viewBox } = await flattenSvg(fixture("rect.svg"));
    expect(viewBox).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    expect(polylines).toHaveLength(1);
    expect(polylines[0]).toEqual([
      { x: 10, y: 20 },
      { x: 40, y: 20 },
      { x: 40, y: 60 },
      { x: 10, y: 60 },
      { x: 10, y: 20 },
    ]);
  });

  it("accumulates nested parent transforms onto child coordinates", async () => {
    const { polylines } = await flattenSvg(fixture("group-translate.svg"));
    // Two nested translates (10,20)+(5,5) shift the line (0,0)→(50,0) to
    // (15,25)→(65,25).
    expect(polylines).toHaveLength(1);
    expect(polylines[0]).toEqual([
      { x: 15, y: 25 },
      { x: 65, y: 25 },
    ]);
  });

  it("skips shapes defined inside non-rendering containers like <defs>", async () => {
    const { polylines } = await flattenSvg(fixture("with-defs.svg"));
    // Only the visible polyline survives; the <defs> rect is a template.
    expect(polylines).toHaveLength(1);
    expect(polylines[0]).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
  });

  it("falls back to width/height when no viewBox is present", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><line x1="0" y1="0" x2="1" y2="1"/></svg>`;
    const { viewBox } = await flattenSvg(svg);
    expect(viewBox).toEqual({ x: 0, y: 0, width: 40, height: 30 });
  });

  it("returns no polylines for an empty SVG", async () => {
    const { polylines } = await flattenSvg(`<svg viewBox="0 0 10 10"></svg>`);
    expect(polylines).toEqual([]);
  });

  it("skips elements hidden with display:none (attribute and inline style)", async () => {
    const { polylines } = await flattenSvg(fixture("display-none.svg"));
    // Only the top-level visible line survives; the display:none group and the
    // style="display:none" rect are dropped.
    expect(polylines).toEqual([[{ x: 0, y: 0 }, { x: 10, y: 0 }]]);
  });

  it("honours visibility inheritance with a descendant override", async () => {
    const { polylines } = await flattenSvg(fixture("visibility-hidden.svg"));
    // The group is visibility:hidden; only the child that flips it back to
    // visible is drawn.
    expect(polylines).toEqual([[{ x: 0, y: 5 }, { x: 10, y: 5 }]]);
  });

  it("resolves a <use> reference into <defs>, applying x/y offset", async () => {
    const { polylines } = await flattenSvg(fixture("use-ref.svg"));
    // The referenced line (0,0)->(10,0) is translated by the use's (5,5).
    expect(polylines).toEqual([[{ x: 5, y: 5 }, { x: 15, y: 5 }]]);
  });

  it("renders a <use> of a <symbol> via xlink:href", async () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">` +
      `<symbol id="s"><rect x="0" y="0" width="10" height="10"/></symbol>` +
      `<use xlink:href="#s" x="2" y="3"/></svg>`;
    const { polylines } = await flattenSvg(svg);
    expect(polylines).toEqual([[
      { x: 2, y: 3 },
      { x: 12, y: 3 },
      { x: 12, y: 13 },
      { x: 2, y: 13 },
      { x: 2, y: 3 },
    ]]);
  });

  it("does not loop forever on mutually-referential <use> elements", async () => {
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">` +
      `<use id="a" href="#b"/><use id="b" href="#a"/></svg>`;
    const { polylines } = await flattenSvg(svg);
    expect(polylines).toEqual([]);
  });
});

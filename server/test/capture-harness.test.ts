import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { flattenSvg } from "../src/svg.js";
import { planPolylines, toMachineCoords } from "../src/plotter.js";
import { DEFAULT_PLOT_OPTIONS, PlotOptions } from "../../shared/types.js";
import type { Polyline } from "../src/svg.js";
import { PROTOCOLS, capturePlot, captureHandshake } from "../src/testing/harness.js";
import { rerenderDrawCore, rerenderEbb, compareGeometry } from "../src/testing/rerender.js";

// Headless command-capture & re-render QA harness (backlog task 31).
//
// Two automated test classes run entirely in software — no plotter, no paper:
//
//   1. Protocol golden files. Each (protocol × card) command stream is committed
//      under test/goldens/. A diff here means the emitter changed: review it, and
//      if intentional, re-record with `BLESS=1 npm test` (or `npm run test:bless`).
//
//   2. Re-render fidelity. The captured stream is parsed back into machine-space
//      polylines and compared against the geometry the engine intended to plot.
//      Staying within tolerance proves the flatten → transform → optimize → emit
//      pipeline preserved the input geometry, independent of the wire protocol.

const here = dirname(fileURLToPath(import.meta.url));
const CARDS_DIR = `${here}/cards`;
const GOLDENS_DIR = `${here}/goldens`;
const BLESS = !!process.env.BLESS;

// Canonical, deterministic plot settings for the harness. Axis flips are off so
// machine coordinates equal page coordinates (cleaner goldens and re-render);
// the test cards are authored 1 user-unit = 1 mm on an A4 page.
const HARNESS_OPTS: PlotOptions = {
  ...DEFAULT_PLOT_OPTIONS,
  pageWidthMm: 210,
  pageHeightMm: 297,
  svgUnitsToMm: 1,
  flipX: false,
  flipY: false,
  swapXY: false,
  optimizePaths: false,
  reversePaths: false,
};

// Re-render must land within this of the intended geometry. DrawCore is exact to
// its 3-decimal G-code rounding (~1µm); the EBB rounds to whole motor steps
// (1/2032 inch ≈ 12µm), so the observed worst case is ~6µm. 50µm leaves headroom.
const FIDELITY_TOLERANCE_MM = 0.05;

interface Card {
  file: string;
  /** Commit a byte-exact protocol golden. Disabled for the endurance card —
   *  its ~15k-line stream isn't reviewable as a diff; re-render + the command
   *  count below guard it instead. */
  golden: boolean;
}

const CARDS: Card[] = [
  { file: "00-smoke.svg", golden: true },
  { file: "01-calibration-ruler.svg", golden: true },
  { file: "02-orientation-key.svg", golden: true },
  { file: "03-curve-fidelity.svg", golden: true },
  { file: "04-pen-lift-comb.svg", golden: true },
  { file: "05-closing-loop.svg", golden: true },
  { file: "06-corner-ringing.svg", golden: true },
  { file: "07-bed-extent.svg", golden: true },
  { file: "08-parser-matrix.svg", golden: true },
  { file: "09-endurance-stress.svg", golden: false },
  { file: "10-acceptance-art.svg", golden: true },
];

/** Assert `content` matches the golden at `path`, or (in bless mode) record it. */
function checkGolden(path: string, content: string) {
  if (BLESS) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return;
  }
  if (!existsSync(path)) {
    throw new Error(`Missing golden ${path}. Record it with: BLESS=1 npm test`);
  }
  expect(content, `golden mismatch for ${path} — re-record with BLESS=1 if intentional`).toBe(
    readFileSync(path, "utf8"),
  );
}

/** The geometry the engine intends to plot, in machine coordinates (mm). */
function expectedGeometry(polylines: Polyline[]): Polyline[] {
  return planPolylines({ polylines, viewBox: { x: 0, y: 0, width: 0, height: 0 } }, HARNESS_OPTS)
    .map((pl) =>
      pl.map((p) => {
        const [x, y] = toMachineCoords(p.x, p.y, HARNESS_OPTS);
        return { x, y };
      }),
    )
    .filter((pl) => pl.length >= 2); // the plotter skips degenerate polylines
}

// Flatten every card once up front (async) so the per-protocol cases stay sync-ish.
const flattened = new Map<string, Polyline[]>();
beforeAll(async () => {
  for (const card of CARDS) {
    const svg = readFileSync(`${CARDS_DIR}/${card.file}`, "utf8");
    const { polylines } = await flattenSvg(svg, { mmPerUnit: 1 });
    flattened.set(card.file, polylines);
  }
});

for (const protocol of PROTOCOLS) {
  describe(`${protocol.displayName} [${protocol.id}]`, () => {
    it("emits a stable handshake", async () => {
      const commands = await captureHandshake(protocol);
      checkGolden(`${GOLDENS_DIR}/${protocol.id}/_handshake.txt`, commands.join("\n") + "\n");
    });

    for (const card of CARDS) {
      describe(card.file, () => {
        it("emits the golden command stream", async () => {
          const flat = { polylines: flattened.get(card.file)!, viewBox: { x: 0, y: 0, width: 0, height: 0 } };
          const { capture } = await capturePlot(protocol, flat, HARNESS_OPTS);
          if (card.golden) {
            checkGolden(`${GOLDENS_DIR}/${protocol.id}/${card.file}.txt`, capture.toText());
          } else {
            // Reviewability aside, the stream must still be non-trivial.
            expect(capture.commands.length).toBeGreaterThan(100);
          }
        });

        it("re-renders to the input geometry within tolerance", async () => {
          const polylines = flattened.get(card.file)!;
          const flat = { polylines, viewBox: { x: 0, y: 0, width: 0, height: 0 } };
          const { commands } = await capturePlot(protocol, flat, HARNESS_OPTS);
          const actual =
            protocol.id === "drawcore"
              ? rerenderDrawCore(commands, HARNESS_OPTS.penDownZ)
              : rerenderEbb(commands);
          const result = compareGeometry(expectedGeometry(polylines), actual, FIDELITY_TOLERANCE_MM);
          expect(result.countMismatch, `stroke count ${result.actualCount} ≠ expected ${result.expectedCount}`).toBe(false);
          expect(result.maxDeviation, `worst deviation ${result.maxDeviation.toFixed(4)}mm`).toBeLessThanOrEqual(
            FIDELITY_TOLERANCE_MM,
          );
        });
      });
    }
  });
}

// Faking the firmware version lets both EBB code paths be exercised before an
// AxiDraw is in hand (the v2/v3 split lands with the EBB port, backlog task 24).
describe("virtual firmware version routing", () => {
  it("handshakes against a faked EBB v2 firmware", async () => {
    const ebb = PROTOCOLS.find((p) => p.id === "ebb")!;
    const commands = await captureHandshake(ebb, { version: "EBB Firmware Version 2.5.3" });
    expect(commands[0]).toBe("V"); // the version query routes to the faked reply
    expect(commands).toContain("EM,1,1"); // handshake completed past the version check
  });
});

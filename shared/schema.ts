// Runtime validation for everything the API accepts. This is a hardware-safety
// boundary: the values here are fed to motors and a pen servo, so each numeric
// field has a hard min/max that rejects input that could damage the plotter,
// wedge the firmware, or ruin a plot (a 50,000 mm/min feed, a negative pen Z,
// a 5-metre page, etc.) before it ever reaches the device.
//
// Lives alongside shared/types.ts so the schema and the defaults it validates
// stay in one place; the bounds are deliberately generous relative to the UI's
// own input ranges so legitimate client values are never rejected.
//
// This module imports zod (a runtime dependency), unlike shared/types.ts which
// is dependency-free. Only the server imports it today; the client bundle stays
// zod-free because the web code imports types from "@shared/types.js" only.

import { z } from "zod";
import { DEFAULT_PLOT_OPTIONS, PlotOptions } from "./types.js";

/** 25 MB, matching the express.json body limit. */
export const MAX_SVG_BYTES = 25 * 1024 * 1024;

export const PlotOptionsSchema = z.object({
  pageWidthMm: z.number().positive().max(3000),
  pageHeightMm: z.number().positive().max(3000),
  offsetXMm: z.number().min(-3000).max(3000),
  offsetYMm: z.number().min(-3000).max(3000),
  svgUnitsToMm: z.number().positive().max(10000),
  drawSpeedMmPerSec: z.number().min(1).max(1000),
  travelSpeedMmPerSec: z.number().min(1).max(1000),
  penUpDelayMs: z.number().min(0).max(60000),
  penDownDelayMs: z.number().min(0).max(60000),
  maxSegmentMm: z.number().positive().max(100),
  penUpZ: z.number().min(0).max(10),
  penDownZ: z.number().min(0).max(10),
  penSpeedMmPerMin: z.number().min(1).max(50000),
  // Servo height is a percentage of the pen-lift servo's travel; the EBB
  // driver maps it onto the firmware's 83.3 ns servo-position units.
  penUpPercent: z.number().min(0).max(100),
  penDownPercent: z.number().min(0).max(100),
  flipX: z.boolean(),
  flipY: z.boolean(),
  swapXY: z.boolean(),
  optimizePaths: z.boolean(),
  reversePaths: z.boolean(),
  startPolylineIndex: z.number().int().min(0),
});

function mergeWithDefaults(val: unknown): unknown {
  const overrides = val && typeof val === "object" && !Array.isArray(val) ? val : {};
  return { ...DEFAULT_PLOT_OPTIONS, ...overrides };
}

/**
 * Accepts a partial (or missing) options object from a request body, fills in
 * the shared defaults, then validates the result against PlotOptionsSchema.
 * Unknown keys are stripped. Throws a ZodError on any out-of-bounds value.
 */
export const PlotOptionsBodySchema = z.preprocess(mergeWithDefaults, PlotOptionsSchema);

/** Validate a request's `options` field, returning a fully-populated PlotOptions. */
export function parsePlotOptions(body: unknown): PlotOptions {
  return PlotOptionsBodySchema.parse(body);
}

/** A non-empty SVG string within the body-size limit. */
export const SvgFieldSchema = z
  .string({ message: "missing svg" })
  .min(1, "missing svg")
  .max(MAX_SVG_BYTES, "svg exceeds the 25 MB limit");

/** Body for POST /api/connect. */
export const ConnectSchema = z.object({
  path: z.string().min(1, "missing path"),
});

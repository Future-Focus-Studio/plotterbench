// Single source of truth for the types and defaults that cross the
// server <-> web-client boundary. Both build targets import from here:
//   - the server via relative paths (e.g. "../../shared/types.js"), because
//     tsc emits the import as-is and resolves it at runtime;
//   - the web client via the "@shared/*" path alias (see vite.config.ts and
//     web/tsconfig.json), because Vite bundles it.
//
// Keep this file free of runtime dependencies — it is pure types plus one
// constant so it can be pulled into either bundle without side effects.

export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  productId?: string;
  vendorId?: string;
  /** True if some registered driver recognizes this port by VID/PID. */
  likelyPlotter?: boolean;
}

export interface PlotOptions {
  pageWidthMm: number;
  pageHeightMm: number;
  offsetXMm: number;
  offsetYMm: number;
  /** Scale from SVG user units to mm. */
  svgUnitsToMm: number;
  /** Pen-down drawing speed in mm/s. Converted to mm/min for G-code feed. */
  drawSpeedMmPerSec: number;
  /** Pen-up travel speed in mm/s. */
  travelSpeedMmPerSec: number;
  /** Delay after raising pen (ms). */
  penUpDelayMs: number;
  /** Delay after lowering pen (ms). */
  penDownDelayMs: number;
  /** Max segment length in mm. */
  maxSegmentMm: number;
  /** Pen "up" Z position (firmware units, 0–10). Smaller = more raised.
   *  DrawCore/iDraw only — the AxiDraw/EBB family lifts with a servo (see
   *  penUpPercent), so this field is ignored when an EBB driver is active. */
  penUpZ: number;
  /** Pen "down" Z position. Larger = more pressure. DrawCore/iDraw only. */
  penDownZ: number;
  /** Feed rate (mm/min) used when raising/lowering the pen. DrawCore/iDraw only. */
  penSpeedMmPerMin: number;
  /** Pen "up" servo height, 0–100% (0 = fully lowered, 100 = fully raised).
   *  AxiDraw/EBB family only — ignored when a DrawCore driver is active. */
  penUpPercent: number;
  /** Pen "down" servo height, 0–100%. AxiDraw/EBB family only. */
  penDownPercent: number;
  /** Invert X axis (toggle if +X in software moves pen LEFT on your plotter). */
  flipX: boolean;
  /** Invert Y axis (toggle if +Y moves pen UP on your plotter — fixes upside-down plots). */
  flipY: boolean;
  /** Swap X and Y (toggle if axes are rotated 90° in hardware). */
  swapXY: boolean;
  /** Reorder / reverse / merge polylines before plotting to cut pen-up travel. */
  optimizePaths: boolean;
  /** Play the entire plot back-to-front: reverse polyline order AND each polyline's direction. */
  reversePaths: boolean;
  /** Skip polylines before this index — used to "rewind" and resume mid-plot. */
  startPolylineIndex: number;
}

// Canonical defaults shared by server and client. These match the values the
// web UI has always shipped (flipX/flipY on, no settle delay), so this
// consolidation does not change the behavior users already experience. Both
// sides start from these and override only the fields the user has set.
export const DEFAULT_PLOT_OPTIONS: PlotOptions = {
  pageWidthMm: 210,
  pageHeightMm: 297,
  offsetXMm: 0,
  offsetYMm: 0,
  svgUnitsToMm: 1,
  drawSpeedMmPerSec: 40,
  travelSpeedMmPerSec: 80,
  penUpDelayMs: 0,
  penDownDelayMs: 0,
  maxSegmentMm: 1.5,
  penUpZ: 0,
  penDownZ: 5,
  penSpeedMmPerMin: 4000,
  // AxiDraw/EBB servo defaults mirror the stock AxiDraw values (up 60%, down
  // 30%); they only take effect when an EBB driver is connected.
  penUpPercent: 60,
  penDownPercent: 30,
  flipX: true,
  flipY: true,
  swapXY: false,
  optimizePaths: false,
  reversePaths: false,
  startPolylineIndex: 0,
};

export interface OptimizeStats {
  originalCount: number;
  optimizedCount: number;
  reversed: number;
  merged: number;
  /** Pen-up travel distance (sum of gaps between polylines). */
  originalTravel: number;
  optimizedTravel: number;
  /** Total draw distance (unchanged by optimization). */
  drawDistance: number;
}

// `driverId`/`driverName` identify the driver bound to the current (or most
// recently selected) port — e.g. "drawcore" / "ebb". The UI uses driverId to
// enable only the settings relevant to the connected machine (Z depth for
// DrawCore, servo height for the AxiDraw/EBB family).
export type WsEvent =
  | { type: "hello"; connected: boolean; path?: string | null; version?: string | null; driverId?: string; driverName?: string }
  | { type: "connection"; connected: boolean; path?: string; version?: string; driverId?: string; driverName?: string }
  // Out-of-band messages surfaced in the status area — e.g. an auto-connect
  // happened, or the origin was preserved/re-zeroed on (re)connect.
  | { type: "notice"; level: "info" | "warn"; message: string }
  | {
      type: "progress";
      phase: "preparing" | "drawing" | "paused" | "done" | "error" | "cancelled";
      polylineIndex: number;
      polylineCount: number;
      segmentIndex: number;
      segmentCount: number;
      message?: string;
    }
  | {
      type: "plot-start";
      polylines: { x: number; y: number }[][];
      startIndex: number;
    };

import { PlotterDriver } from "./drivers/types.js";
import { FlattenResult, Point, Polyline } from "./svg.js";
import { optimizePolylines, OptimizeStats } from "./optimize.js";

// ---------- Plot options ----------
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
  /** Pen "up" Z position (firmware units, 0–10). Smaller = more raised. */
  penUpZ: number;
  /** Pen "down" Z position. Larger = more pressure. */
  penDownZ: number;
  /** Feed rate (mm/min) used when raising/lowering the pen. */
  penSpeedMmPerMin: number;
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

export const DEFAULT_PLOT_OPTIONS: PlotOptions = {
  pageWidthMm: 210,
  pageHeightMm: 297,
  offsetXMm: 0,
  offsetYMm: 0,
  svgUnitsToMm: 1,
  drawSpeedMmPerSec: 40,
  travelSpeedMmPerSec: 80,
  penUpDelayMs: 200,
  penDownDelayMs: 200,
  maxSegmentMm: 1.5,
  penUpZ: 0,
  penDownZ: 5,
  penSpeedMmPerMin: 4000,
  flipX: false,
  flipY: false,
  swapXY: false,
  optimizePaths: false,
  reversePaths: false,
  startPolylineIndex: 0,
};

function toMachineCoords(xMm: number, yMm: number, opts: PlotOptions): [number, number] {
  let x = opts.flipX ? -xMm : xMm;
  let y = opts.flipY ? -yMm : yMm;
  if (opts.swapXY) [x, y] = [y, x];
  return [x, y];
}

export interface PlotProgress {
  phase: "preparing" | "drawing" | "paused" | "done" | "error" | "cancelled";
  polylineIndex: number;
  polylineCount: number;
  segmentIndex: number;
  segmentCount: number;
  message?: string;
}

type ProgressCb = (p: PlotProgress) => void;
type StartCb = (polylines: Polyline[], startIndex: number) => void;

function transformPolylines(polylines: Polyline[], opts: PlotOptions): Polyline[] {
  const s = opts.svgUnitsToMm;
  const dx = opts.offsetXMm;
  const dy = opts.offsetYMm;
  return polylines.map((pl) => pl.map((p) => ({ x: p.x * s + dx, y: p.y * s + dy })));
}

function clampToPage(p: Point, opts: PlotOptions): Point {
  return {
    x: Math.max(0, Math.min(opts.pageWidthMm, p.x)),
    y: Math.max(0, Math.min(opts.pageHeightMm, p.y)),
  };
}

/**
 * Compute the page-mm polylines the plotter would draw for `flat` under `opts`,
 * applying the same transform → optimize → reverse → clamp pipeline as the live
 * plot, but without sending any motion to the device. Used to preview the
 * instruction list before clicking Plot.
 */
export function planPolylines(flat: FlattenResult, opts: PlotOptions): Polyline[] {
  let polylines = transformPolylines(flat.polylines, opts);
  if (opts.optimizePaths) polylines = optimizePolylines(polylines).polylines;
  if (opts.reversePaths) polylines = polylines.map((pl) => [...pl].reverse()).reverse();
  return polylines.map((pl) => pl.map((p) => clampToPage(p, opts)));
}

function subdivide(a: Point, b: Point, maxLen: number): Point[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  if (d <= maxLen) return [b];
  const n = Math.ceil(d / maxLen);
  const out: Point[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    out.push({ x: a.x + dx * t, y: a.y + dy * t });
  }
  return out;
}

export class Plotter {
  private cancelling = false;
  private pausing = false;
  private paused = false;
  private resumeResolve: (() => void) | null = null;
  private running = false;
  private currentXmm = 0;
  private currentYmm = 0;
  private currentFeedMmPerMin: number | null = null;

  constructor(private device: PlotterDriver) {}

  isRunning() { return this.running; }
  isPaused() { return this.paused; }

  cancel() {
    if (this.running) {
      this.cancelling = true;
      // If paused, unblock the wait so the cancel is processed immediately.
      if (this.paused) {
        this.paused = false;
        this.resumeResolve?.();
        this.resumeResolve = null;
      }
    }
  }

  pause() {
    if (this.running && !this.paused) this.pausing = true;
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.pausing = false;
    this.resumeResolve?.();
    this.resumeResolve = null;
  }

  async penUp(opts: PlotOptions = DEFAULT_PLOT_OPTIONS) {
    await this.device.penUp(opts.penUpZ, opts.penSpeedMmPerMin);
    this.currentFeedMmPerMin = opts.penSpeedMmPerMin;
    if (opts.penUpDelayMs > 0) await this.device.dwellSeconds(opts.penUpDelayMs / 1000);
  }

  async penDown(opts: PlotOptions = DEFAULT_PLOT_OPTIONS) {
    await this.device.penDown(opts.penDownZ, opts.penSpeedMmPerMin);
    this.currentFeedMmPerMin = opts.penSpeedMmPerMin;
    if (opts.penDownDelayMs > 0) await this.device.dwellSeconds(opts.penDownDelayMs / 1000);
  }

  async home(opts: PlotOptions = DEFAULT_PLOT_OPTIONS) {
    await this.penUp(opts);
    await this.setFeed(opts.travelSpeedMmPerSec * 60);
    await this.moveToPage(0, 0, opts);
  }

  private async moveToPage(xMm: number, yMm: number, opts: PlotOptions) {
    const [mx, my] = toMachineCoords(xMm, yMm, opts);
    await this.device.moveTo(mx, my);
    this.currentXmm = xMm;
    this.currentYmm = yMm;
  }

  async sleep() {
    await this.device.sleep();
  }

  /** Zero the plotter's coordinate system at its current physical position. */
  async zeroHere() {
    await this.device.setAbsoluteMode();
    await this.device.zeroPosition();
    this.currentXmm = 0;
    this.currentYmm = 0;
    this.currentFeedMmPerMin = null;
  }

  async plot(flat: FlattenResult, opts: PlotOptions, onProgress?: ProgressCb, onStart?: StartCb): Promise<void> {
    if (this.running) throw new Error("Plot already in progress");
    this.running = true;
    this.cancelling = false;
    try {
      let polylines = transformPolylines(flat.polylines, opts);
      if (opts.optimizePaths) {
        polylines = optimizePolylines(polylines).polylines;
      }
      if (opts.reversePaths) {
        // Full time-reversal of the plot: reverse the list AND reverse each
        // polyline's internal point order.
        polylines = polylines.map((pl) => [...pl].reverse()).reverse();
      }
      const count = polylines.length;
      const startIndex = Math.max(0, Math.min(opts.startPolylineIndex | 0, count));

      onStart?.(polylines.map((pl) => pl.map((p) => clampToPage(p, opts))), startIndex);

      onProgress?.({
        phase: "preparing",
        polylineIndex: startIndex,
        polylineCount: count,
        segmentIndex: 0,
        segmentCount: 0,
      });

      // Ensure absolute mode and start with pen up.
      await this.device.setAbsoluteMode();
      await this.penUp(opts);

      for (let i = startIndex; i < polylines.length; i++) {
        if (this.cancelling) break;
        const pl = polylines[i];
        if (pl.length < 2) continue;

        const start = clampToPage(pl[0], opts);
        await this.setFeed(opts.travelSpeedMmPerSec * 60);
        await this.moveToPage(start.x, start.y, opts);

        await this.penDown(opts);
        await this.setFeed(opts.drawSpeedMmPerSec * 60);

        let prev = start;
        const segCount = pl.length - 1;
        for (let j = 1; j < pl.length; j++) {
          if (this.cancelling) break;
          const target = clampToPage(pl[j], opts);
          const sub = subdivide(prev, target, opts.maxSegmentMm);
          for (const s of sub) {
            await this.moveToPage(s.x, s.y, opts);
          }
          prev = target;
          onProgress?.({
            phase: "drawing",
            polylineIndex: i,
            polylineCount: count,
            segmentIndex: j,
            segmentCount: segCount,
          });
        }

        await this.penUp(opts);

        if (this.pausing && !this.cancelling) {
          this.pausing = false;
          this.paused = true;
          onProgress?.({
            phase: "paused",
            polylineIndex: i,
            polylineCount: count,
            segmentIndex: 0,
            segmentCount: segCount,
          });
          await new Promise<void>((resolve) => { this.resumeResolve = resolve; });
          if (this.cancelling) break;
        }
      }

      if (this.cancelling) {
        await this.penUp(opts);
        onProgress?.({
          phase: "cancelled",
          polylineIndex: startIndex,
          polylineCount: count,
          segmentIndex: 0,
          segmentCount: 0,
        });
        return;
      }

      await this.home(opts);
      onProgress?.({
        phase: "done",
        polylineIndex: count,
        polylineCount: count,
        segmentIndex: 0,
        segmentCount: 0,
      });
    } catch (err) {
      onProgress?.({
        phase: "error",
        polylineIndex: 0,
        polylineCount: 0,
        segmentIndex: 0,
        segmentCount: 0,
        message: (err as Error).message,
      });
      throw err;
    } finally {
      this.running = false;
      this.cancelling = false;
      this.pausing = false;
      this.paused = false;
      this.resumeResolve = null;
    }
  }

  private async setFeed(feedMmPerMin: number) {
    if (this.currentFeedMmPerMin === feedMmPerMin) return;
    await this.device.setFeed(feedMmPerMin);
    this.currentFeedMmPerMin = feedMmPerMin;
  }
}

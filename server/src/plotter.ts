import { PlotterDriver } from "./drivers/types.js";
import { FlattenResult, Point, Polyline } from "./svg.js";
import { optimizePolylines, OptimizeStats } from "./optimize.js";
import { DEFAULT_PLOT_OPTIONS, PlotOptions } from "../../shared/types.js";

// `PlotOptions` and `DEFAULT_PLOT_OPTIONS` are defined once in shared/types.ts.
// Re-export them so existing importers (index.ts, etc.) keep working.
export { DEFAULT_PLOT_OPTIONS };
export type { PlotOptions };

// The pure geometry helpers below (toMachineCoords, transformPolylines,
// clampToPage, subdivide) are exported for unit testing (plotter.test.ts).
export function toMachineCoords(xMm: number, yMm: number, opts: PlotOptions): [number, number] {
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

export function transformPolylines(polylines: Polyline[], opts: PlotOptions): Polyline[] {
  const s = opts.svgUnitsToMm;
  const dx = opts.offsetXMm;
  const dy = opts.offsetYMm;
  return polylines.map((pl) => pl.map((p) => ({ x: p.x * s + dx, y: p.y * s + dy })));
}

export function clampToPage(p: Point, opts: PlotOptions): Point {
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

export function subdivide(a: Point, b: Point, maxLen: number): Point[] {
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

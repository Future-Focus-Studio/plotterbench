// The seam between the plot engine and any concrete plotter protocol.
//
// `Plotter` (plotter.ts) and the HTTP layer (index.ts) depend ONLY on
// `PlotterDriver` — never on a concrete driver or protocol string. Adding
// support for a new plotter (AxiDraw/EBB, NextDraw, generic GRBL, EggBot, …)
// means writing a new class that implements `PlotterDriver` and registering it
// in registry.ts. No changes to the engine are required.

// `PortInfo` is defined once in shared/types.ts (it crosses the server/client
// boundary). Re-export it so driver modules can keep importing from "./types.js".
import { PlotOptions, PortInfo } from "../../../shared/types.js";
export type { PortInfo };

/**
 * The pen-lift parameters handed to a driver's penUp/penDown. It is a subset of
 * PlotOptions so the engine can pass the whole options object, while each driver
 * reads only the fields its hardware understands: DrawCore uses the Z-depth
 * fields, the AxiDraw/EBB family uses the servo-percent fields. Carrying both
 * keeps the interface protocol-neutral without per-driver method signatures.
 */
export type PenSettings = Pick<
  PlotOptions,
  "penUpZ" | "penDownZ" | "penSpeedMmPerMin" | "penUpPercent" | "penDownPercent"
>;

export interface SendOptions {
  timeoutMs?: number;
  /** Whether to wait for an "ok"-style ack. Defaults to the driver's per-command rule. */
  expectOk?: boolean;
}

/**
 * Everything the plot engine needs from a plotter, expressed in protocol-neutral
 * terms (millimetres, mm/min feed rates, a Z value for the pen). Concrete drivers
 * translate these into their wire protocol.
 */
export interface PlotterDriver {
  /** Enumerate serial ports, flagging the ones this driver recognizes. */
  listPorts(): Promise<PortInfo[]>;
  isOpen(): boolean;
  open(path: string): Promise<void>;
  close(): Promise<void>;
  /**
   * Prime the link and confirm the firmware identity. Resolves with the version
   * line; rejects if the device on this port is not what the driver expects.
   */
  handshake(): Promise<string>;
  setAbsoluteMode(): Promise<void>;
  setIncrementalMode(): Promise<void>;
  /** Set the current physical X/Y as the origin (must not move the pen / Z axis). */
  zeroPosition(): Promise<void>;
  penUp(pen: PenSettings): Promise<void>;
  penDown(pen: PenSettings): Promise<void>;
  moveTo(xMm: number, yMm: number, feedMmPerMin?: number): Promise<void>;
  setFeed(feedMmPerMin: number): Promise<void>;
  dwellSeconds(sec: number): Promise<void>;
  home(): Promise<void>;
  sleep(): Promise<void>;
}

/**
 * Constructor + static metadata for a driver. The registry stores these so it
 * can detect the right driver for a port before any instance exists.
 */
export interface PlotterDriverClass {
  new (): PlotterDriver;
  /** Stable machine id, e.g. "drawcore". */
  readonly id: string;
  /** Human-readable name for UI/logs, e.g. "DrawCore (Uunatek/iDraw)". */
  readonly displayName: string;
  /** True if this driver recognizes the given serial port (by VID/PID). */
  matches(port: PortInfo): boolean;
}

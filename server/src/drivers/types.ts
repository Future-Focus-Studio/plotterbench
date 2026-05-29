// The seam between the plot engine and any concrete plotter protocol.
//
// `Plotter` (plotter.ts) and the HTTP layer (index.ts) depend ONLY on
// `PlotterDriver` — never on a concrete driver or protocol string. Adding
// support for a new plotter (AxiDraw/EBB, NextDraw, generic GRBL, EggBot, …)
// means writing a new class that implements `PlotterDriver` and registering it
// in registry.ts. No changes to the engine are required.

export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  productId?: string;
  vendorId?: string;
  /** True if some registered driver recognizes this port by VID/PID. */
  likelyPlotter?: boolean;
}

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
  penUp(z?: number, speedMmPerMin?: number): Promise<void>;
  penDown(z?: number, speedMmPerMin?: number): Promise<void>;
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

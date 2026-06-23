// Headless capture harness — orchestration (backlog task 31).
//
// Runs the real SVG → driver pipeline against a VirtualDevice and returns the
// captured command stream. Two entry points:
//   - captureHandshake: just open + handshake (protocol setup commands).
//   - capturePlot: open + plot a flattened SVG (the per-card command stream).
//
// `PROTOCOLS` is the matrix the golden/re-render tests iterate. Each entry pairs
// a driver class with the firmware version its virtual device reports.

import { Plotter } from "../plotter.js";
import { FlattenResult } from "../svg.js";
import { PlotOptions } from "../../../shared/types.js";
import { PlotterDriver } from "../drivers/types.js";
import { SerialTransport } from "../drivers/transport.js";
import { DrawCoreDriver } from "../drivers/drawcore.js";
import { EBBDriver } from "../drivers/ebb.js";
import { attachCapture, CommandCapture, VirtualFirmwareOptions } from "./virtual-device.js";

export interface Protocol {
  /** Stable id used in golden-file paths, e.g. "drawcore" / "ebb". */
  id: string;
  displayName: string;
  /** Construct a fresh driver instance. */
  makeDriver: () => SerialTransport & PlotterDriver;
  /** Firmware identity the virtual device reports. */
  firmware: VirtualFirmwareOptions;
}

// The protocols the harness exercises. Firmware version strings are plausible
// real values; the EBB one is a v3.x string (the v2/v3 split lands with the EBB
// port, backlog task 24 — captureHandshake takes a version override to test the
// other path without a second registry entry).
export const PROTOCOLS: Protocol[] = [
  {
    id: DrawCoreDriver.id,
    displayName: DrawCoreDriver.displayName,
    makeDriver: () => new DrawCoreDriver(),
    firmware: { version: "DrawCore V2.17 (Uunatek)" },
  },
  {
    id: EBBDriver.id,
    displayName: EBBDriver.displayName,
    makeDriver: () => new EBBDriver(),
    firmware: { version: "EBB Firmware Version 3.0.1" },
  },
];

/** Capture the commands a driver emits during open + handshake. */
export async function captureHandshake(
  protocol: Protocol,
  firmwareOverride?: VirtualFirmwareOptions,
): Promise<string[]> {
  const driver = protocol.makeDriver();
  const capture = attachCapture(driver, firmwareOverride ?? protocol.firmware);
  await driver.open("virtual");
  try {
    await driver.handshake();
  } finally {
    await driver.close();
  }
  return capture.commands;
}

/**
 * Capture the command stream a driver emits to plot `flat` under `opts`. Skips
 * the handshake (captured separately) so the golden is exactly the plot: pen
 * lifts, travel moves, draw moves, and the return-home. The driver starts at the
 * origin (host position 0,0), matching a freshly-zeroed machine.
 */
export async function capturePlot(
  protocol: Protocol,
  flat: FlattenResult,
  opts: PlotOptions,
): Promise<{ commands: string[]; capture: CommandCapture }> {
  const driver = protocol.makeDriver();
  const capture = attachCapture(driver, protocol.firmware);
  await driver.open("virtual");
  try {
    const plotter = new Plotter(driver);
    await plotter.plot(flat, opts);
  } finally {
    await driver.close();
  }
  return { commands: capture.commands, capture };
}

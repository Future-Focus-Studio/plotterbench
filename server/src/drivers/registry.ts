import { SerialPort } from "serialport";
import { PlotterDriverClass, PortInfo } from "./types.js";
import { DrawCoreDriver } from "./drawcore.js";
import { EBBDriver } from "./ebb.js";

// All known plotter drivers, in detection-priority order. To add support for a
// new plotter, implement PlotterDriver (see drawcore.ts as the template) and
// add the class here — nothing else in the server needs to change. DrawCore and
// EBB match disjoint VID/PID sets, so detection order between them is moot.
export const DRIVERS: PlotterDriverClass[] = [DrawCoreDriver, EBBDriver];

/** Default driver used when a port matches none of the registered drivers. */
export const DEFAULT_DRIVER: PlotterDriverClass = DrawCoreDriver;

/** The first driver whose `matches()` recognizes this port, or null. */
export function detectDriver(port: PortInfo): PlotterDriverClass | null {
  return DRIVERS.find((d) => d.matches(port)) ?? null;
}

/** List every serial port, flagging those any registered driver recognizes. */
export async function listPorts(): Promise<PortInfo[]> {
  const ports = await SerialPort.list();
  return ports.map((p) => {
    const info: PortInfo = {
      path: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      productId: p.productId,
      vendorId: p.vendorId,
    };
    info.likelyPlotter = DRIVERS.some((d) => d.matches(info));
    return info;
  });
}

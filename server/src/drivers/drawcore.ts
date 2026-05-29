import { PlotterDriver, PortInfo } from "./types.js";
import { SerialTransport } from "./transport.js";

// DrawCore (Uunatek / iDraw) driver. This firmware is Grbl-derived and exposes
// a G-code + $-command interface over a CH340 USB-UART at 115200 baud. Most
// commands reply with "ok\r\n"; a few queries (v, i, a, mr, pi, qm) reply with
// a single data line and no "ok". Errors come back as "error:<n>" or "ALARM:".
//
// This is intentionally NOT the EBB (AxiDraw) protocol. To support genuine
// AxiDraws/NextDraws, add a sibling driver implementing PlotterDriver and
// register it in registry.ts (EBB = 04D8:FD92, DrawCore = 1A86:7523/8040).

const DRAWCORE_VENDOR_IDS = new Set(["1a86"]);
const DRAWCORE_PRODUCT_IDS = new Set(["7523", "8040"]);

export class DrawCoreDriver extends SerialTransport implements PlotterDriver {
  static readonly id = "drawcore";
  static readonly displayName = "DrawCore (Uunatek/iDraw)";

  /** USB VID/PID detection used by the registry. */
  static matches(port: PortInfo): boolean {
    const vid = (port.vendorId || "").toLowerCase();
    const pid = (port.productId || "").toLowerCase();
    return DRAWCORE_VENDOR_IDS.has(vid) && DRAWCORE_PRODUCT_IDS.has(pid);
  }

  protected readonly baudRate = 115200;

  constructor() {
    super(DrawCoreDriver.id);
    // Queries that reply with a data line instead of "ok".
    this.noOkCommands = new Set(["v", "i", "a", "mr", "pi", "qm"]);
  }

  protected matchesPort(port: PortInfo): boolean {
    return DrawCoreDriver.matches(port);
  }

  /**
   * Prime the serial link and confirm the device is DrawCore.
   * Mirrors the handshake used by the Uunatek Inkscape extensions.
   * Returns the firmware version line (e.g. "DrawCore V2.17 ...").
   * Throws if the device does not identify as DrawCore.
   */
  async handshake(): Promise<string> {
    if (!this.isOpen()) throw new Error("Not connected");
    // Send $B then drain anything the firmware sends back, plus any boot chatter.
    await this.writeRaw("$B" + this.lineTerminator);
    await this.drain(400);
    // Query version. "v" returns just a data line (no "ok") — usually once, but
    // sometimes blank the first time, so retry once before giving up.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const reply = await this.send("v", { expectOk: false, timeoutMs: 2500 });
        const line = reply.join(" ").trim();
        if (line.toLowerCase().startsWith("drawcore")) return line;
        this.log("unexpected version reply:", JSON.stringify(line));
      } catch (err) {
        this.log("version query failed:", (err as Error).message);
      }
    }
    throw new Error(
      "No DrawCore firmware response. This port is probably not a Uunatek/iDraw plotter."
    );
  }

  // ---- High-level motion helpers ----

  async setAbsoluteMode() {
    await this.send("G90");
  }

  async setIncrementalMode() {
    await this.send("G91");
  }

  async zeroPosition() {
    // Set current X/Y as origin. We deliberately do NOT zero Z — the Z axis is
    // the pen servo, whose position is meaningful in firmware units.
    await this.send("G92 X0 Y0");
  }

  /**
   * Pen up/down. DrawCore uses Z-axis moves to drive the pen servo.
   * Larger Z = pen DOWN (more pressure). Defaults match the Uunatek defaults.
   */
  async penUp(zUp = 0, speedMmPerMin = 4000) {
    await this.send(`G90 G1 Z${zUp.toFixed(2)} F${Math.round(speedMmPerMin)}`);
  }

  async penDown(zDown = 5, speedMmPerMin = 4000) {
    await this.send(`G90 G1 Z${zDown.toFixed(2)} F${Math.round(speedMmPerMin)}`);
  }

  /** Absolute linear move to (xMm, yMm) at the current feed rate. */
  async moveTo(xMm: number, yMm: number, feedMmPerMin?: number) {
    const feed = feedMmPerMin != null ? ` F${Math.round(feedMmPerMin)}` : "";
    await this.send(`G90 G1 X${xMm.toFixed(3)} Y${yMm.toFixed(3)}${feed}`);
  }

  /** Set the feed rate without issuing a move. */
  async setFeed(feedMmPerMin: number) {
    await this.send(`G1 F${Math.round(feedMmPerMin)}`);
  }

  async dwellSeconds(sec: number) {
    await this.send(`G4 P${sec.toFixed(3)}`);
  }

  async home() {
    // $H runs a limit-switch homing cycle if the plotter has limits and is
    // configured for homing. If not, this command errors; caller can catch.
    await this.send("$H", { timeoutMs: 60_000 });
  }

  async sleep() {
    await this.send("$SLP");
  }

  async queryPen(): Promise<boolean | null> {
    try {
      const reply = await this.send("$QP", { timeoutMs: 2000 });
      return reply[0]?.trim().startsWith("0") ? false : true;
    } catch {
      return null;
    }
  }
}

import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";

// DrawCore (Uunatek / iDraw) driver. This firmware is Grbl-derived and exposes
// a G-code + $-command interface over a CH340 USB-UART at 115200 baud. Most
// commands reply with "ok\r\n"; a few queries (v, i, a, mr, pi, qm) reply with
// a single data line and no "ok". Errors come back as "error:<n>" or "ALARM:".
//
// This is intentionally NOT the EBB (AxiDraw) protocol. If we ever need to
// support genuine AxiDraws again, add a sibling driver and auto-select by
// USB VID/PID (EBB = 04D8:FD92, DrawCore = 1A86:7523 or 1A86:8040).

const DEBUG = process.env.DEBUG_EBB !== "0"; // keep same env var for continuity
function log(...args: unknown[]) {
  if (DEBUG) console.log("[device]", ...args);
}

// Commands whose reply is only a data line, not terminated by "ok".
const NO_OK_COMMANDS = new Set(["v", "i", "a", "mr", "pi", "qm"]);

// USB vendor/product IDs we recognize as DrawCore plotters.
const DRAWCORE_VENDOR_IDS = new Set(["1a86", "1A86"]);
const DRAWCORE_PRODUCT_IDS = new Set(["7523", "8040"]);

export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  productId?: string;
  vendorId?: string;
  likelyPlotter?: boolean;
}

export interface SendOptions {
  timeoutMs?: number;
  expectOk?: boolean;
}

interface PendingCommand {
  command: string;
  resolve: (reply: string[]) => void;
  reject: (err: Error) => void;
  lines: string[];
  expectOk: boolean;
  timer: NodeJS.Timeout;
}

export class PlotterDevice {
  private port: SerialPort | null = null;
  private parser: ReadlineParser | null = null;
  private queue: PendingCommand[] = [];
  private current: PendingCommand | null = null;

  async listPorts(): Promise<PortInfo[]> {
    const ports = await SerialPort.list();
    return ports.map((p) => {
      const vid = (p.vendorId || "").toLowerCase();
      const pid = (p.productId || "").toLowerCase();
      return {
        path: p.path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        productId: p.productId,
        vendorId: p.vendorId,
        likelyPlotter: DRAWCORE_VENDOR_IDS.has(vid) && DRAWCORE_PRODUCT_IDS.has(pid),
      };
    });
  }

  isOpen(): boolean {
    return this.port?.isOpen === true;
  }

  async open(path: string): Promise<void> {
    if (this.port?.isOpen) await this.close();

    // CH340 wants RTS/DTR deasserted so we don't auto-reset the MCU on open.
    this.port = new SerialPort({
      path,
      baudRate: 115200,
      autoOpen: false,
      rtscts: false,
    });
    this.parser = this.port.pipe(new ReadlineParser({ delimiter: "\r\n" }));
    this.parser.on("data", (line: string) => this.onLine(line));
    this.port.on("close", () => this.onClose());
    this.port.on("error", (err) => this.onError(err));

    await new Promise<void>((resolve, reject) => {
      this.port!.open((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      this.port!.set({ rts: false, dtr: false }, (err) => (err ? reject(err) : resolve()));
    });
    log(`opened ${path} @ 115200`);
  }

  async close(): Promise<void> {
    if (!this.port) return;
    const p = this.port;
    this.port = null;
    this.parser = null;
    await new Promise<void>((resolve) => {
      if (!p.isOpen) return resolve();
      p.close(() => resolve());
    });
    this.flushPending(new Error("Serial port closed"));
    log("closed");
  }

  /**
   * Prime the serial link and confirm the device is DrawCore.
   * Mirrors the handshake used by the Uunatek Inkscape extensions.
   * Returns the firmware version line (e.g. "DrawCore V2.17 ...").
   * Throws if the device does not identify as DrawCore.
   */
  async handshake(): Promise<string> {
    if (!this.port?.isOpen) throw new Error("Not connected");
    // Send $B then drain anything the firmware sends back, plus any boot chatter.
    await this.writeRaw("$B\r");
    await this.drain(400);
    // Query version. "v" returns just a data line (no "ok") — usually once, but
    // sometimes blank the first time, so retry once before giving up.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const reply = await this.send("v", { expectOk: false, timeoutMs: 2500 });
        const line = reply.join(" ").trim();
        if (line.toLowerCase().startsWith("drawcore")) return line;
        log("unexpected version reply:", JSON.stringify(line));
      } catch (err) {
        log("version query failed:", (err as Error).message);
      }
    }
    throw new Error(
      "No DrawCore firmware response. This port is probably not a Uunatek/iDraw plotter."
    );
  }

  send(command: string, opts: SendOptions = {}): Promise<string[]> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const head = command.split(/[\s,]/)[0].toLowerCase();
    const expectOk = opts.expectOk ?? !NO_OK_COMMANDS.has(head);
    return new Promise<string[]>((resolve, reject) => {
      if (!this.port?.isOpen) return reject(new Error("Not connected"));
      const pending: PendingCommand = {
        command,
        resolve,
        reject,
        lines: [],
        expectOk,
        timer: setTimeout(() => this.onTimeout(pending, timeoutMs), timeoutMs),
      };
      this.queue.push(pending);
      this.pump();
    });
  }

  private writeRaw(data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.port?.isOpen) return reject(new Error("Not connected"));
      log("TX →", JSON.stringify(data));
      this.port.write(data, (err) => (err ? reject(err) : resolve()));
    });
  }

  private drain(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private pump() {
    if (this.current || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    this.current = next;
    log("TX →", next.command);
    this.port!.write(next.command + "\r", (err) => {
      if (err) {
        clearTimeout(next.timer);
        this.current = null;
        next.reject(err);
        this.pump();
      }
    });
  }

  private onLine(raw: string) {
    const line = raw.replace(/[\r\n]+$/, "");
    log("RX ←", JSON.stringify(line));
    if (!this.current) return;

    const lower = line.trim().toLowerCase();
    if (lower === "ok") {
      const done = this.current;
      this.current = null;
      clearTimeout(done.timer);
      done.resolve(done.lines);
      this.pump();
      return;
    }
    if (lower.startsWith("error") || lower.startsWith("alarm")) {
      const done = this.current;
      this.current = null;
      clearTimeout(done.timer);
      done.reject(new Error(`Plotter ${line.trim()} (after "${done.command}")`));
      this.pump();
      return;
    }

    this.current.lines.push(line);

    if (!this.current.expectOk && line.length > 0) {
      const done = this.current;
      this.current = null;
      clearTimeout(done.timer);
      done.resolve(done.lines);
      this.pump();
    }
  }

  private onTimeout(pending: PendingCommand, timeoutMs: number) {
    if (this.current === pending) {
      this.current = null;
      this.pump();
    } else {
      const idx = this.queue.indexOf(pending);
      if (idx >= 0) this.queue.splice(idx, 1);
    }
    const msg = `Plotter timeout after ${timeoutMs}ms waiting for reply to "${pending.command}"`;
    log(msg);
    pending.reject(new Error(msg));
  }

  private onClose() {
    this.flushPending(new Error("Serial port closed"));
  }

  private onError(err: Error) {
    log("serial error", err.message);
    if (this.current) {
      const done = this.current;
      this.current = null;
      clearTimeout(done.timer);
      done.reject(err);
      this.pump();
    }
  }

  private flushPending(err: Error) {
    const all = [this.current, ...this.queue].filter(Boolean) as PendingCommand[];
    this.current = null;
    this.queue = [];
    for (const c of all) {
      clearTimeout(c.timer);
      c.reject(err);
    }
  }

  // ---- High-level helpers ----

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

import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import { PortInfo, SendOptions } from "./types.js";

// Legacy env var name, kept for continuity with earlier (EBB-era) tooling.
const DEBUG = process.env.DEBUG_EBB !== "0";

/**
 * The minimal serial surface SerialTransport drives. A real plotter uses the
 * node-serialport backend below; the headless capture harness (server/src/testing)
 * injects a virtual backend that records every byte written and replies with
 * canned firmware responses — see `setBackendFactory`. Isolating I/O here is what
 * lets the golden-file / re-render tests exercise the *real* command emitters
 * without a serial port (backlog task 31).
 */
export interface SerialBackend {
  /** True between a resolved open() and close(). */
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  /** Write raw bytes (command + terminator) to the device. */
  write(data: string): Promise<void>;
}

/** Reply/lifecycle callbacks a backend pushes up into the transport. */
export interface BackendHandlers {
  /** One delimiter-framed reply line from the device. */
  onLine: (line: string) => void;
  onClose: () => void;
  onError: (err: Error) => void;
}

export type BackendFactory = (
  path: string,
  baudRate: number,
  delimiter: string,
  handlers: BackendHandlers,
) => SerialBackend;

/**
 * The production backend: a node-serialport with a line-framing parser. This is
 * exactly the open/parser/signal sequence SerialTransport used inline before the
 * backend seam existed, so real hardware behavior is unchanged.
 */
function nodeSerialBackend(
  path: string,
  baudRate: number,
  delimiter: string,
  handlers: BackendHandlers,
): SerialBackend {
  // CH340 / many USB-UARTs want RTS/DTR deasserted so we don't auto-reset the
  // MCU on open.
  const port = new SerialPort({ path, baudRate, autoOpen: false, rtscts: false });
  const parser = port.pipe(new ReadlineParser({ delimiter }));
  parser.on("data", (line: string) => handlers.onLine(line));
  port.on("close", () => handlers.onClose());
  port.on("error", (err) => handlers.onError(err));
  return {
    get isOpen() {
      return port.isOpen === true;
    },
    open() {
      return new Promise<void>((resolve, reject) => {
        port.open((err) => (err ? reject(err) : resolve()));
      }).then(
        () =>
          new Promise<void>((resolve, reject) => {
            port.set({ rts: false, dtr: false }, (err) => (err ? reject(err) : resolve()));
          }),
      );
    },
    close() {
      return new Promise<void>((resolve) => {
        if (!port.isOpen) return resolve();
        port.close(() => resolve());
      });
    },
    write(data: string) {
      return new Promise<void>((resolve, reject) => {
        port.write(data, (err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

/**
 * A serial open fails with a cryptic OS-level error ("Cannot lock port" /
 * "Resource temporarily unavailable" / EBUSY / "Access denied") when the port is
 * already held by another process — almost always another Plotterbench window or
 * the dev server, since the plotter can only be opened by one process at a time.
 * Translate that specific case into a message the UI can show as-is; pass any
 * other open error through unchanged.
 */
function friendlyOpenError(err: Error): Error {
  const m = (err.message || "").toLowerCase();
  const inUse =
    m.includes("cannot lock port") ||
    m.includes("resource temporarily unavailable") ||
    m.includes("ebusy") ||
    m.includes("access denied") ||
    m.includes("access is denied");
  if (!inUse) return err;
  return new Error(
    "Plotter is in use by another app — likely another Plotterbench window or the dev " +
      "server. Close it (or disconnect there), then try again.",
  );
}

interface PendingCommand {
  command: string;
  resolve: (reply: string[]) => void;
  reject: (err: Error) => void;
  lines: string[];
  expectOk: boolean;
  timer: NodeJS.Timeout;
}

/**
 * Serial command-queue plumbing shared by all line-oriented drivers. It opens
 * the port, serializes commands, waits for each command's reply, and times out
 * if the firmware goes quiet. Nothing here is specific to a particular plotter
 * protocol — the reply *classification* (what counts as an ack, an error, or a
 * data-only line) is delegated to protected hooks. The defaults implement
 * GRBL-style semantics (`ok` / `error:<n>` / `ALARM:`), which DrawCore uses
 * as-is; a future EBB/AxiDraw driver can override `isOk` / `parseError` /
 * `expectsOk` without touching the queue mechanics.
 */
export abstract class SerialTransport {
  private backend: SerialBackend | null = null;
  private backendFactory: BackendFactory = nodeSerialBackend;
  private queue: PendingCommand[] = [];
  private current: PendingCommand | null = null;

  /** Serial baud rate for this device. */
  protected abstract readonly baudRate: number;
  /** Line delimiter the firmware uses to frame replies. */
  protected readonly delimiter: string = "\r\n";
  /** String appended to each command on the wire. */
  protected readonly lineTerminator: string = "\r";
  /** Command heads whose reply is a single data line, not terminated by "ok". */
  protected noOkCommands: Set<string> = new Set();

  constructor(private readonly logTag: string) {}

  /**
   * Test seam (headless capture harness): swap the serial backend before open().
   * Production code never calls this — the default is the node-serialport backend.
   * Used by server/src/testing/virtual-device.ts to capture the command stream.
   */
  setBackendFactory(factory: BackendFactory) {
    this.backendFactory = factory;
  }

  protected log(...args: unknown[]) {
    if (DEBUG) console.log(`[${this.logTag}]`, ...args);
  }

  /** True if this driver recognizes the port (used to flag likely plotters). */
  protected abstract matchesPort(port: PortInfo): boolean;

  // ---- Reply classification (override for non-GRBL protocols) ----

  /** Does `command` expect an "ok" ack, or only a data line? */
  protected expectsOk(command: string): boolean {
    const head = command.split(/[\s,]/)[0].toLowerCase();
    return !this.noOkCommands.has(head);
  }

  /** Is this line the success ack that completes the current command? */
  protected isOk(line: string): boolean {
    return line.trim().toLowerCase() === "ok";
  }

  /** If this line signals an error, return a short description; otherwise null. */
  protected parseError(line: string): string | null {
    const lower = line.trim().toLowerCase();
    return lower.startsWith("error") || lower.startsWith("alarm") ? line.trim() : null;
  }

  // ---- Port lifecycle ----

  async listPorts(): Promise<PortInfo[]> {
    const ports = await SerialPort.list();
    return ports.map((p) => {
      const info: PortInfo = {
        path: p.path,
        manufacturer: p.manufacturer,
        serialNumber: p.serialNumber,
        productId: p.productId,
        vendorId: p.vendorId,
      };
      info.likelyPlotter = this.matchesPort(info);
      return info;
    });
  }

  isOpen(): boolean {
    return this.backend?.isOpen === true;
  }

  async open(path: string): Promise<void> {
    if (this.backend?.isOpen) await this.close();

    this.backend = this.backendFactory(path, this.baudRate, this.delimiter, {
      onLine: (line) => this.onLine(line),
      onClose: () => this.onClose(),
      onError: (err) => this.onError(err),
    });

    try {
      await this.backend.open();
    } catch (err) {
      this.backend = null;
      throw friendlyOpenError(err as Error);
    }
    this.log(`opened ${path} @ ${this.baudRate}`);
  }

  async close(): Promise<void> {
    if (!this.backend) return;
    const b = this.backend;
    this.backend = null;
    await b.close();
    this.flushPending(new Error("Serial port closed"));
    this.log("closed");
  }

  // ---- Command queue ----

  send(command: string, opts: SendOptions = {}): Promise<string[]> {
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const expectOk = opts.expectOk ?? this.expectsOk(command);
    return new Promise<string[]>((resolve, reject) => {
      if (!this.backend?.isOpen) return reject(new Error("Not connected"));
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

  protected writeRaw(data: string): Promise<void> {
    if (!this.backend?.isOpen) return Promise.reject(new Error("Not connected"));
    this.log("TX →", JSON.stringify(data));
    return this.backend.write(data);
  }

  protected drain(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private pump() {
    if (this.current || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    this.current = next;
    this.log("TX →", next.command);
    this.backend!.write(next.command + this.lineTerminator).catch((err: Error) => {
      if (this.current !== next) return;
      clearTimeout(next.timer);
      this.current = null;
      next.reject(err);
      this.pump();
    });
  }

  private onLine(raw: string) {
    const line = raw.replace(/[\r\n]+$/, "");
    this.log("RX ←", JSON.stringify(line));
    if (!this.current) return;

    if (this.isOk(line)) {
      const done = this.current;
      this.current = null;
      clearTimeout(done.timer);
      done.resolve(done.lines);
      this.pump();
      return;
    }
    const errText = this.parseError(line);
    if (errText) {
      const done = this.current;
      this.current = null;
      clearTimeout(done.timer);
      done.reject(new Error(`Plotter ${errText} (after "${done.command}")`));
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
    this.log(msg);
    pending.reject(new Error(msg));
  }

  private onClose() {
    this.flushPending(new Error("Serial port closed"));
  }

  private onError(err: Error) {
    this.log("serial error", err.message);
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
}

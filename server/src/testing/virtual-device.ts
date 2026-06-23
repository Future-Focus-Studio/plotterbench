// Headless capture harness — the "virtual plotter" half (backlog task 31).
//
// A VirtualDevice is NOT a re-implementation of a driver. It is a real driver
// (DrawCoreDriver / EBBDriver / …) whose serial backend has been swapped for an
// in-memory one that (a) records every byte the driver writes and (b) replies
// with canned firmware responses so the command queue and handshake complete.
// Because the real driver's command *formatting* runs untouched, golden-file
// tests assert the behaviour of the actual emitter, not a mock of it.
//
// The seam is SerialTransport.setBackendFactory (see drivers/transport.ts).

import { BackendFactory, SerialTransport } from "../drivers/transport.js";

/** Collects the canonical command strings a driver emits, in order. */
export class CommandCapture {
  readonly commands: string[] = [];
  /** Newline-delimited stream — the on-disk golden-file format. */
  toText(): string {
    return this.commands.join("\n") + "\n";
  }
}

export interface VirtualFirmwareOptions {
  /**
   * Firmware version line the device reports to the version query. Drivers
   * validate the prefix (DrawCore expects "DrawCore…", EBB expects "EBB…"), so
   * this must match. Vary it to exercise version-gated code paths — e.g. an EBB
   * v2.x vs v3.x string for the plotink-style v2/v3 split (backlog task 24).
   */
  version: string;
  /**
   * Recognises the version query whose reply is the version line (rather than a
   * bare "ok" ack). Defaults to the single-letter "v"/"V" both protocols use.
   */
  isVersionQuery?: (command: string) => boolean;
}

const DEFAULT_IS_VERSION_QUERY = (command: string) => command.trim().toLowerCase() === "v";

/**
 * Build a backend factory that records every write into `capture` and answers
 * with canned firmware replies. The version query gets the configured version
 * line; everything else gets a generic "ok" (matched case-insensitively by the
 * transport's isOk, so it satisfies both GRBL "ok" and EBB "OK" expectations).
 * Replies are delivered on a microtask so the transport has registered the
 * pending command before its reply arrives.
 */
function capturingBackend(capture: CommandCapture, fw: VirtualFirmwareOptions): BackendFactory {
  const isVersionQuery = fw.isVersionQuery ?? DEFAULT_IS_VERSION_QUERY;
  return (_path, _baudRate, _delimiter, handlers) => {
    let open = false;
    return {
      get isOpen() {
        return open;
      },
      async open() {
        open = true;
      },
      async close() {
        open = false;
      },
      async write(data: string) {
        // Strip the line terminator(s) the transport appends; record the bare
        // canonical command (e.g. "SP,1,400", "G90 G1 X1.000 Y2.000 F4800").
        const command = data.replace(/[\r\n]+$/, "");
        if (command.length > 0) capture.commands.push(command);
        const reply = isVersionQuery(command) ? fw.version : "ok";
        queueMicrotask(() => {
          if (open) handlers.onLine(reply);
        });
      },
    };
  };
}

/**
 * Attach a capturing backend to a driver instance and return the capture log.
 * Call before `driver.open()`. The driver is otherwise untouched — its real
 * formatting, command queue, and reply classification all run.
 */
export function attachCapture(driver: SerialTransport, fw: VirtualFirmwareOptions): CommandCapture {
  const capture = new CommandCapture();
  driver.setBackendFactory(capturingBackend(capture, fw));
  return capture;
}

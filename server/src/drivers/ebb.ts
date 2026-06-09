import { PenSettings, PlotterDriver, PortInfo } from "./types.js";
import { SerialTransport } from "./transport.js";

// EBB (EiBotBoard) driver — the AxiDraw family: AxiDraw V2/V3, V3/A3, SE/A1–A3,
// MiniKit, and EBB-compatible NextDraw units. Implemented clean-room from the
// public EBB serial-protocol reference (https://evil-mad.github.io/EggBot/ebb.html);
// command semantics were cross-checked against the MIT-licensed `plotink` library.
// No code or copyrightable expression from the GPL-licensed AxiDraw Inkscape
// extension was used. See NOTICES.md for the full provenance statement.
//
// The EBB is fundamentally unlike the DrawCore/Grbl protocol:
//   - It is a USB-CDC device (VID/PID 04D8:FD92); the baud rate is ignored.
//   - There is no G-code and no firmware coordinate system. The HOST tracks the
//     absolute position; every move is a *relative* stepper move.
//   - The two motors are wired as an H-bot (CoreXY): a move of (dx, dy) inches
//     turns Motor 1 by (dx + dy) and Motor 2 by (dx - dy), both scaled by the
//     microstepping resolution. We send these as the `SM` move command.
//   - The pen is lifted by an RC servo (`SP` command), not a Z axis.
//
// Replies are framed "...\r\n"; commands are terminated by "\r" (the
// SerialTransport defaults). Most commands ack with "OK"; a handful of queries
// (v, a, i, mr, pi, qm, qg) return only a data line.

const EBB_VENDOR_ID = "04d8";
const EBB_PRODUCT_ID = "fd92";

// Microstepping resolution sent with the EM command. 1 = 16X microstepping
// ("High Resolution"). STEP_SCALE must match: at 16X the AxiDraw moves 2032
// motor steps per inch along each native (45°) axis — a published AxiDraw
// hardware figure (EBB command reference / AxiDraw documentation).
const EM_RESOLUTION_16X = 1;
const STEP_SCALE = 2032; // steps per inch along a native motor axis, at 16X.
const MM_PER_INCH = 25.4;

// The EBB step generator's hard ceiling is 25 kHz (documented EBB hardware
// limit); above it the board loses position. We cap a hair below (in steps per
// millisecond) and stretch a move's duration to stay under it.
const MAX_STEP_RATE = 24.995;

// The AxiDraw mechanism tops out around 220 mm/s in 16X mode. We hard-cap a
// little under that: it physically cannot move faster, and asking for more only
// pins the steppers at their limit. IMPORTANT: this is the *top* speed, reachable
// only with acceleration ramping — which this driver does not yet do. Until it
// does, sustained speeds anywhere near this cap from a standstill will stall the
// motors. Real-world speeds should stay well below it (draw ≲75, travel ≲150
// mm/s). The cap exists to stop a fat-fingered value from endangering hardware,
// NOT as a usable operating speed.
const MAX_XY_SPEED_MM_PER_MIN = 200 * 60; // 200 mm/s

// Pen-lift servo endpoints, in the EBB's servo-position units of 83.3 ns
// (1/12 MHz) — see the public EBB `SC` command reference. These correspond to
// servo pulse widths of ~0.82 ms (down) and ~2.32 ms (up), spanning the travel
// of a standard AxiDraw pen-lift servo. A height percentage maps linearly
// between them.
const SERVO_MIN = 9855;  // ~0.82 ms pulse — pen fully lowered (0%)
const SERVO_MAX = 27831; // ~2.32 ms pulse — pen fully raised (100%)

// Servo sweep model: a standard RC servo crosses its full travel in ~200 ms at
// full command rate, and the EBB refreshes the servo signal about every 24 ms
// (EBB `SC` reference). Used only to size the SC,11/SC,12 sweep-rate values.
const SERVO_SWEEP_MS = 200;
const SERVO_UPDATE_MS = 24;

// Pen-settle delay model — independent and deliberately conservative. The SP
// delay holds the next motion command until the pen has physically finished
// moving: too short causes ghost lead-ins / drag marks, too long merely slows
// the plot. Servo settle time scales with how far the servo travels, so we use a
// fixed base plus a per-percent term. These coefficients are chosen to be
// *generous* — at the 60/30 default they yield ~150 ms (the value validated safe
// on hardware was 126 ms) and they stay ≥ that safe baseline across the whole
// 0–100% range, so the delay can only ever be longer, never under-settled.
const SERVO_SETTLE_BASE_MS = 60;
const SERVO_SETTLE_PER_PERCENT_MS = 3;

// Servo sweep rate as a fraction of full speed: raise a little faster than we
// lower. Conservative, non-critical defaults (they only affect lift/drop speed).
const PEN_RAISE_RATE = 0.75;
const PEN_LOWER_RATE = 0.5;

// Keep a "hardware pause" (SM,ms,0,0) chunked so a future pause-button poll
// stays responsive — the same chunking approach as plotink's (MIT) doTimedPause.
const MAX_PAUSE_CHUNK_MS = 750;

export class EBBDriver extends SerialTransport implements PlotterDriver {
  static readonly id = "ebb";
  static readonly displayName = "AxiDraw (EBB)";

  /** USB VID/PID detection used by the registry. */
  static matches(port: PortInfo): boolean {
    const vid = (port.vendorId || "").toLowerCase();
    const pid = (port.productId || "").toLowerCase();
    return vid === EBB_VENDOR_ID && pid === EBB_PRODUCT_ID;
  }

  // The EBB is USB-CDC; the baud rate is nominal and not honored by the device.
  protected readonly baudRate = 9600;

  // Absolute motor positions, in steps, that the HOST maintains because the EBB
  // firmware has no coordinate system of its own. Motor1 follows X+Y, Motor2
  // follows X-Y. zeroPosition() resets these to 0.
  private motor1Steps = 0;
  private motor2Steps = 0;
  // Feed rate carried between setFeed() and moveTo(), in mm/min.
  private feedMmPerMin = 3000;
  // Last servo positions we pushed (in firmware units), so we can size the SP
  // delay to the actual distance the servo has to travel.
  private servoUpUnits = SERVO_MAX;
  private servoDownUnits = SERVO_MIN;

  constructor() {
    super(EBBDriver.id);
    // Queries that return a bare data line with no trailing "OK".
    this.noOkCommands = new Set(["v", "a", "i", "mr", "pi", "qm", "qg"]);
  }

  protected matchesPort(port: PortInfo): boolean {
    return EBBDriver.matches(port);
  }

  // ---- Reply classification ----
  // "OK" is matched case-insensitively by the base isOk(). EBB errors are
  // reported as a line containing "Err:" (or, for a few commands, a leading "!").
  protected parseError(line: string): string | null {
    const t = line.trim();
    if (t.includes("Err:") || /^!\d/.test(t)) return t;
    return null;
  }

  /**
   * Confirm the device is an EBB and put it in a known state. Queries the
   * firmware version ("V" → "EBB Firmware Version x.y.z"), then enables both
   * motors at 16X microstepping (so STEP_SCALE is correct) and configures the
   * servo timing. None of this moves the carriage or the pen.
   */
  async handshake(): Promise<string> {
    if (!this.isOpen()) throw new Error("Not connected");

    let version = "";
    // "V" replies with a single data line and no "OK"; retry once in case the
    // first read returns stale/empty data right after the port opens.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const reply = await this.send("V", { expectOk: false, timeoutMs: 2500 });
        const line = reply.join(" ").trim();
        if (line.toUpperCase().startsWith("EBB")) {
          version = line;
          break;
        }
        this.log("unexpected version reply:", JSON.stringify(line));
      } catch (err) {
        this.log("version query failed:", (err as Error).message);
      }
    }
    if (!version) {
      throw new Error(
        "No EBB firmware response. This port is probably not an AxiDraw / EiBotBoard."
      );
    }

    // Enable both motors at 16X microstepping (energizes them with holding
    // torque; no motion). This also locks the step resolution to STEP_SCALE.
    await this.send(`EM,${EM_RESOLUTION_16X},${EM_RESOLUTION_16X}`).catch((e) =>
      this.log("EM (enable motors) failed:", (e as Error).message)
    );
    // Configure how fast the pen-lift servo signal sweeps (SC,11 = raise rate,
    // SC,12 = lower rate). Tolerate failure on older firmware.
    await this.send(`SC,11,${this.servoRateUnits(PEN_RAISE_RATE)}`).catch(() => {});
    await this.send(`SC,12,${this.servoRateUnits(PEN_LOWER_RATE)}`).catch(() => {});

    return version;
  }

  // ---- Coordinate system ----
  // Absolute/incremental mode is a host-side concept for the EBB (we always
  // compute relative step deltas ourselves), so these are no-ops.
  async setAbsoluteMode() {}
  async setIncrementalMode() {}

  /** Define the current physical position as the origin. Moves nothing. */
  async zeroPosition() {
    this.motor1Steps = 0;
    this.motor2Steps = 0;
    // Also clear the EBB's own global step counter so a later QS agrees with us.
    // Harmless if unsupported; never moves the carriage.
    await this.send("CS").catch(() => {});
  }

  // ---- Pen (servo) ----

  async penUp(pen: PenSettings) {
    await this.movePen(true, pen.penUpPercent, pen.penDownPercent);
  }

  async penDown(pen: PenSettings) {
    await this.movePen(false, pen.penUpPercent, pen.penDownPercent);
  }

  /**
   * Raise or lower the pen with the SP command. We (re)assert the up/down servo
   * targets via SC,4 / SC,5 first so live slider changes take effect, then issue
   * SP with a delay sized to the servo's physical travel time — that delay makes
   * the firmware hold off the next motion command until the pen has settled,
   * which prevents skipped strokes regardless of the engine's own pen delays.
   */
  private async movePen(up: boolean, upPercent: number, downPercent: number) {
    this.servoUpUnits = this.percentToServo(upPercent);
    this.servoDownUnits = this.percentToServo(downPercent);
    await this.send(`SC,4,${this.servoUpUnits}`); // SC,4 = pen-up position
    await this.send(`SC,5,${this.servoDownUnits}`); // SC,5 = pen-down position

    const travelPercent = Math.abs(upPercent - downPercent);
    const delayMs = Math.round(SERVO_SETTLE_BASE_MS + SERVO_SETTLE_PER_PERCENT_MS * travelPercent);
    // SP,1 = pen up, SP,0 = pen down.
    await this.send(`SP,${up ? 1 : 0},${delayMs}`);
  }

  // ---- Motion ----

  /** Set the feed rate (mm/min) used by subsequent moves. No wire command.
   *  Clamped to the machine's physical top speed so an out-of-range value can't
   *  command an impossible speed (see MAX_XY_SPEED_MM_PER_MIN). */
  async setFeed(feedMmPerMin: number) {
    if (feedMmPerMin <= 0) return;
    const capped = Math.min(feedMmPerMin, MAX_XY_SPEED_MM_PER_MIN);
    if (capped < feedMmPerMin) {
      this.log(`feed ${Math.round(feedMmPerMin / 60)} mm/s exceeds the AxiDraw max; capping to ${MAX_XY_SPEED_MM_PER_MIN / 60} mm/s`);
    }
    this.feedMmPerMin = capped;
  }

  /**
   * Absolute linear move to (xMm, yMm). The EBB only does relative stepper
   * moves, so we convert the target to absolute motor steps, subtract our
   * tracked position to get the per-motor delta, size the move duration from the
   * feed rate (stretched if needed to stay under the step-rate ceiling), and
   * send a single SM command.
   */
  async moveTo(xMm: number, yMm: number, feedMmPerMin?: number) {
    const requested = feedMmPerMin && feedMmPerMin > 0 ? feedMmPerMin : this.feedMmPerMin;
    // Hard-cap at the machine's physical top speed regardless of what's asked.
    const feed = Math.min(requested, MAX_XY_SPEED_MM_PER_MIN);

    const xIn = xMm / MM_PER_INCH;
    const yIn = yMm / MM_PER_INCH;
    // H-bot transform: Motor1 follows X+Y, Motor2 follows X-Y.
    const targetM1 = Math.round(STEP_SCALE * (xIn + yIn));
    const targetM2 = Math.round(STEP_SCALE * (xIn - yIn));
    const dM1 = targetM1 - this.motor1Steps;
    const dM2 = targetM2 - this.motor2Steps;

    if (dM1 === 0 && dM2 === 0) return; // Sub-step move; nothing to do.

    // Actual XY distance implied by the (rounded) step deltas, for timing.
    const xDeltaIn = (dM1 + dM2) / (2 * STEP_SCALE);
    const yDeltaIn = (dM1 - dM2) / (2 * STEP_SCALE);
    const distMm = Math.hypot(xDeltaIn, yDeltaIn) * MM_PER_INCH;

    let durationMs = Math.round((distMm / feed) * 60_000);
    // Never below 1 ms, and never so fast it exceeds the step-rate ceiling.
    const maxSteps = Math.max(Math.abs(dM1), Math.abs(dM2));
    const minDurationMs = Math.ceil(maxSteps / MAX_STEP_RATE);
    durationMs = Math.max(durationMs, minDurationMs, 1);

    // SM,<duration_ms>,<motor1 steps>,<motor2 steps>
    await this.send(`SM,${durationMs},${dM1},${dM2}`);

    this.motor1Steps = targetM1;
    this.motor2Steps = targetM2;
  }

  async dwellSeconds(sec: number) {
    if (sec <= 0) return;
    let remainingMs = Math.round(sec * 1000);
    // A timed "move" of zero steps holds position for the duration. Chunk it so
    // long pauses don't monopolize the command pipeline.
    while (remainingMs > 0) {
      const chunk = Math.min(remainingMs, MAX_PAUSE_CHUNK_MS);
      await this.send(`SM,${Math.max(chunk, 1)},0,0`);
      remainingMs -= chunk;
    }
  }

  /** Return to the origin (0,0) with a pen-up travel move. */
  async home() {
    await this.send(`SP,1,0`).catch(() => {}); // Ensure pen is up.
    await this.moveTo(0, 0);
  }

  /** Disable both motors (lets the carriage be moved by hand). */
  async sleep() {
    await this.send("EM,0,0");
  }

  // ---- Helpers ----

  /** Map a 0–100% pen height to a firmware servo position (83.3 ns units). */
  private percentToServo(percent: number): number {
    const clamped = Math.max(0, Math.min(100, percent));
    return Math.round(SERVO_MIN + (clamped / 100) * (SERVO_MAX - SERVO_MIN));
  }

  /**
   * Convert a servo rate (fraction of full speed) into the SC,11/SC,12 units:
   * the servo position change applied per firmware update tick. At full rate the
   * servo sweeps its whole range in one SERVO_SWEEP_MS window.
   */
  private servoRateUnits(rateFraction: number): number {
    const updatesPerSweep = SERVO_SWEEP_MS / SERVO_UPDATE_MS;
    const fullRangePerUpdate = (SERVO_MAX - SERVO_MIN) / updatesPerSweep;
    return Math.max(1, Math.round(fullRangePerUpdate * rateFraction));
  }
}

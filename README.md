# Plotterbench

**Website:** [plotterbench.com](https://plotterbench.com)

A local web interface for plotting SVGs on a pen plotter. Drop an SVG, set page size, drag to position, and hit Plot. The browser talks to a small Node server over HTTP + WebSocket; the server drives the plotter directly over USB serial. Two plotter families are supported out of the box and auto-detected by USB VID/PID: **DrawCore** (UUNA TEK / iDraw) and the **AxiDraw / EiBotBoard** family.

## Prerequisites

- Node 20 LTS or newer (enforced; older versions are rejected at install and startup)
- A supported plotter plugged in via USB:
  - a **DrawCore** plotter (UUNA TEK / iDraw) — enumerates as a CH340 serial port, or
  - an **AxiDraw / EiBotBoard** plotter — enumerates as a USB-CDC modem port.

## Install & run

```bash
npm install
npm run dev
```

That single command starts **both** the Node server (`:49787`) and the Vite dev server (`:49173`). Open http://localhost:49173.

## Workflow

1. **Connect** to the plotter (Refresh → select port → Connect), or let auto-connect find it. The status line shows the detected machine (e.g. "DrawCore (Uunatek/iDraw)" or "AxiDraw (EBB)") and its firmware version.
2. Set **page** size in inches.
3. Load an SVG (drop or browse). Adjust width/height (aspect locked by default) and drag the dashed outline on the page to position. Per-layer labels and an **Optimization** preview (strokes, merged, reversed, travel saved) help you check the plan first.
4. Use **Orientation** toggles (flip X, flip Y, swap X/Y) if your plot comes out mirrored or rotated.
5. Use **Motors off** to release the steppers, **Go to origin** to return to 0,0.
6. Position your paper so the pen starts at the top-left corner of the page, then **Set origin** so the plotter treats the current position as (0,0).
7. Click **Plot**. Watch the progress bar; you can **Pause / Resume** between strokes or **Cancel** any time.

The plot treats the origin you set as the top-left of your page.

### Calibration test patterns

The **Test pattern** dropdown draws built-in diagnostic cards (instead of your SVG) to check a freshly-connected machine: corner-number orientation, an imperial size-measurement card, and a **metric calibration ruler** (per-axis mm rulers + a square/circle) for confirming steps-per-mm and that the X and Y scales agree.

## Architecture

```
┌──────────────────┐      HTTP/WS      ┌──────────────────┐    USB serial    ┌──────────────────────┐
│  React (Vite)    │  ───────────────▶ │  Node + Express  │  ──────────────▶ │  DrawCore plotter     │
│  SVG preview,    │                    │  serialport,     │      ──or──      │   (UUNA TEK/iDraw)     │
│  page setup,     │                    │  SVG flattener,  │                  │  AxiDraw (EiBotBoard)  │
│  plot controls   │                    │  plot engine     │                  └──────────────────────┘
└──────────────────┘                    └──────────────────┘
```

Everything lives in **one npm package** at the repo root. Source is split by area:

- `server/` — Node/TypeScript backend. Plotter drivers (`drivers/`), SVG flattening (`svg.ts`), path optimization (`optimize.ts`), plot engine (`plotter.ts`), HTTP/WS server (`index.ts`).
- `web/` — Vite + React frontend.

The plot engine talks to plotters through a `PlotterDriver` interface, never to a concrete protocol. Two drivers ship today:

- `drivers/drawcore.ts` — the **DrawCore** protocol (Grbl-derived G-code + `$`-commands), auto-detected at VID/PID `1A86:7523` / `1A86:8040`, confirmed by a `DrawCore` version response.
- `drivers/ebb.ts` — the **EBB** protocol (the AxiDraw family), auto-detected at VID/PID `04D8:FD92`, confirmed by an `EBB` version response.

On connect (and during auto-connect), the server picks the driver whose `matches()` recognizes the selected port, binds the engine to it, and the UI reports which machine it detected.

### Adding a plotter driver

Support for a new plotter (NextDraw, generic GRBL, EggBot, …) is an additive change — the plot engine and HTTP layer don't change:

1. Add `server/src/drivers/<name>.ts` with a class that implements `PlotterDriver` (`drivers/types.ts`). For a line-oriented serial protocol, extend `SerialTransport` (`drivers/transport.ts`) to reuse the command queue, and override the reply-classification hooks (`isOk` / `parseError` / `expectsOk`) if the firmware isn't GRBL-style. `drivers/drawcore.ts` (G-code) and `drivers/ebb.ts` (stepper/servo) are the two reference implementations.
2. Give the class a static `id`, `displayName`, and `matches(port)` (USB VID/PID detection).
3. Register it in `server/src/drivers/registry.ts` by adding it to `DRIVERS`.


## Notes

- **Pen lift is per-protocol.** DrawCore drives the pen with **Z-axis moves** (`G1 Z…`); the AxiDraw/EBB family drives it with a **servo** (`SP`). The settings follow suit: DrawCore exposes pen-up/down **Z** positions, the EBB family exposes pen-up/down **height %**. The UI grays out whichever set doesn't apply to the connected machine. Move speed and dwell delays are configurable for both.
- **Acceleration.** DrawCore acceleration is handled by its Grbl firmware planner. The EBB driver currently issues constant-velocity moves with **no host-side acceleration planning**, so keep AxiDraw speeds moderate (draw ≲ 75, travel ≲ 150 mm/s); it caps effective speed at the machine's physical limit (~221 mm/s in 16× mode) so an out-of-range value can't overdrive the motors. If you see overshoot or ringing, lower the **Draw** speed.
- Optional **path optimization** (toggle in the UI) reorders polylines for shorter pen-up travel, reverses them where it helps, and merges endpoints that meet. Leave it off to plot in document order.
- Long segments are subdivided to a max segment length so curves stay smooth; points are clamped to the page bounds.
- Units: the frontend converts `width`/`height` and `viewBox` to mm. If your SVG has no units, it's treated as px (96px = 1 in).
- The backend is local-only and enforces it: the server binds to `127.0.0.1` (not all interfaces), and both the API (CORS) and the WebSocket channel only accept loopback origins. There's no auth and "plot" runs hardware, so this is deliberate. To bind elsewhere anyway (at your own risk) set `HOST=0.0.0.0`.

### Supported SVG features

The server flattener (`server/src/svg.ts`) turns your SVG into pen polylines. It is not a full SVG renderer — it covers what plotter artwork actually uses.

**Supported:** `<path>` (all commands, including arcs and S/T smooth curves), `<line>`, `<polyline>`, `<polygon>`, `<rect>`, `<circle>`, `<ellipse>`; nested `transform`s (`matrix`/`translate`/`scale`/`rotate`/`skewX`/`skewY`); `<use>` references (incl. `xlink:href`, `x`/`y` offset, and `<symbol>` targets); `display:none` and `visibility:hidden` (as a presentation attribute *or* an inline `style="…"`); `<defs>`/`<clipPath>`/`<mask>`/etc. correctly treated as non-rendering.

**Not supported (yet) — outline or expand these in your editor first:**

- **`<text>`** — convert text to paths/outlines (Inkscape: *Path → Object to Path*; Illustrator: *Type → Create Outlines*).
- **`<image>`** and other raster content — there's nothing to draw.
- **`<style>` stylesheets / CSS selectors** — only inline `style="…"` and presentation attributes are honoured. Flatten styles to the elements (most exporters have an option for this).
- **`clipPath` / `mask` geometry** — the clip/mask shapes are ignored, so clipped artwork is drawn unclipped (full, uncut paths).
- **Nested `viewBox` / `preserveAspectRatio`** on inner `<svg>`/`<symbol>` — inner viewports aren't scaled.

When in doubt, outline text and expand clones/clips before plotting.

## Protocol command reference

### DrawCore (Grbl-derived)

Runs over a CH340 USB-UART at **115200 baud**; most commands reply with `ok`. A few queries reply with a single data line and no `ok`; errors come back as `error:<n>` or `ALARM:`.

| Command            | Purpose                                                  |
| ------------------ | -------------------------------------------------------- |
| `v`                | Firmware version (replies `DrawCore V… …`)               |
| `$B`               | Prime the link / drain boot chatter on connect           |
| `G90` / `G91`      | Absolute / incremental positioning mode                  |
| `G92 X0 Y0`        | Set current position as origin (X/Y only; Z = pen)       |
| `G1 X… Y… F…`      | Linear move to X/Y at feed rate F (mm/min)               |
| `G1 Z… F…`         | Pen up/down via Z-axis move                              |
| `G4 P…`            | Dwell for P seconds (pen settle delay)                   |
| `$H`               | Run limit-switch homing cycle (if configured)            |
| `$SLP`             | Sleep / release motors                                   |
| `$QP`              | Query pen state                                          |

### EBB / AxiDraw (EiBotBoard)

A USB-CDC device (baud rate is nominal). Commands are terminated by `\r`; most reply with `OK`, and errors contain `Err:`. The host tracks absolute position and emits relative stepper moves (there is no firmware coordinate system).

| Command                    | Purpose                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `V`                        | Firmware version (replies `EBB … Firmware Version …`)              |
| `EM,1,1`                   | Enable both motors at 16× microstepping (2032 steps/in)            |
| `EM,0,0`                   | Disable motors (sleep / release)                                   |
| `SM,<ms>,<m1>,<m2>`        | Timed move: motor1 by `m1`, motor2 by `m2` (H-bot: m1=X+Y, m2=X−Y) |
| `SP,1` / `SP,0`            | Pen up / pen down (servo)                                          |
| `SC,4` / `SC,5`            | Set pen-up / pen-down servo position                               |
| `SC,11` / `SC,12`          | Set servo raise / lower rate                                       |
| `CS`                       | Clear step position (used when setting origin)                     |

This driver implements the **v2-series** EBB firmware used by current AxiDraws; the class-based EBB **v3** protocol (NextDraw, minimum firmware 3.0.2) is not yet supported.

## Contributing

Forks, issues, and pull requests are welcome. Pull requests require agreeing to
the [Contributor License Agreement](CLA.md) — see [CONTRIBUTING.md](CONTRIBUTING.md)
for the workflow and what to know before contributing.

## Attribution

Plotterbench's plotter drivers are clean-room reimplementations built for
interoperability — see [NOTICES.md](NOTICES.md) for the third-party
acknowledgements (EBB protocol docs, the MIT-licensed `plotink` reference) and
the clean-room statement.

## License

Plotterbench is **source-available, not open source**. It is licensed under the
[PolyForm Shield License 1.0.0](LICENSE): you may use, modify, fork, and
contribute to it for free — including for your own commercial work — but you may
**not** use it to build a product or service that competes with Future Focus
Studio LLC's offerings (including the paid Plotterbench desktop build).

Copyright © 2026 Future Focus Studio LLC. All rights reserved except as granted
by the license.

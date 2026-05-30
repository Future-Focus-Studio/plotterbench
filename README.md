# Plotterbench

A local web interface for plotting SVGs on a plotter. Drop an SVG, set page size, drag to position, and hit Plot. The browser talks to a small Node server over HTTP + WebSocket; the server drives the plotter directly over USB serial using DrawCore G-code commands.

## Architecture

```
┌──────────────────┐      HTTP/WS      ┌──────────────────┐    USB serial    ┌──────────────────┐
│  React (Vite)    │  ───────────────▶ │  Node + Express  │  ──────────────▶ │  DrawCore plotter│
│  SVG preview,    │                    │  serialport,     │                  │  (Uunatek/iDraw, │
│  page setup,     │                    │  SVG flattener,  │                  │   CH340 @ 115200)│
│  plot controls   │                    │  plot engine     │                  └──────────────────┘
└──────────────────┘                    └──────────────────┘
```

Everything lives in **one npm package** at the repo root. Source is split by area:

- `server/` — Node/TypeScript backend. Plotter drivers (`drivers/`), SVG flattening (`svg.ts`), path optimization (`optimize.ts`), plot engine (`plotter.ts`), HTTP/WS server (`index.ts`).
- `web/` — Vite + React frontend.

The plot engine talks to plotters through a `PlotterDriver` interface, never to a concrete protocol. The bundled driver speaks the **DrawCore** protocol — a Grbl-derived G-code + `$`-command interface — and is auto-detected by USB VID/PID (`1A86:7523` or `1A86:8040`), confirming the firmware identifies itself as `DrawCore` on connect.

### Adding a plotter driver

Support for a new plotter (AxiDraw/EBB, NextDraw, generic GRBL, EggBot, …) is an additive change — the plot engine and HTTP layer don't change:

1. Add `server/src/drivers/<name>.ts` with a class that implements `PlotterDriver` (`drivers/types.ts`). For a line-oriented serial protocol, extend `SerialTransport` (`drivers/transport.ts`) to reuse the command queue, and override the reply-classification hooks (`isOk` / `parseError` / `expectsOk`) if the firmware isn't GRBL-style. `drivers/drawcore.ts` is the reference implementation.
2. Give the class a static `id`, `displayName`, and `matches(port)` (USB VID/PID detection).
3. Register it in `server/src/drivers/registry.ts` by adding it to `DRIVERS`.

On connect (and during auto-connect), the server picks the driver whose `matches()` recognizes the selected port and binds the engine to it.

## Prerequisites

- Node 18+
- A DrawCore plotter (Uunatek / iDraw) plugged in via USB. It enumerates as a CH340 serial port.

## Install & run

```bash
npm install
npm run dev
```

That single command starts **both** the Node server (`:49787`) and the Vite dev server (`:49173`). Open http://localhost:49173. Click **Refresh**, pick the plotter port (usually `/dev/tty.usbserial…` or `/dev/tty.wchusbserial…` on macOS), click **Connect**, then drop an SVG and hit **Plot**.

### Production build

```bash
npm run build
npm start
```

This builds the web app to `dist/web/` and the server to `server/dist/`, then serves both from a single process on http://localhost:49787.

## Workflow

1. **Connect** to the plotter (Refresh → select port → Connect). The server verifies the firmware reports `DrawCore`.
2. Set **page** size in inches. You can save named presets and reload them later (stored in your browser).
3. Load an SVG (drop or browse). Adjust width/height (aspect locked by default) and drag the dashed outline on the page to position. Per-layer labels and an **Optimization** preview (strokes, merged, reversed, travel saved) help you check the plan first.
4. Use **Orientation** toggles (flip X, flip Y, swap X/Y) if your plot comes out mirrored or rotated.
5. Use **Pen up / Pen down** to test the servo, **Motors off** to release the steppers, **Home** to return to 0,0.
6. Position your paper so the pen starts at the top-left corner of the page, then **Set origin** so the plotter treats the current position as (0,0).
7. Click **Plot**. Watch the progress bar; you can **Pause / Resume** between strokes or **Cancel** any time.

The plot treats the origin you set as the top-left of your page.

## Notes & caveats

- Pen up/down is driven by **Z-axis moves** (`G1 Z…`), not a dedicated servo command. The pen-up / pen-down Z positions, the move speed, and the dwell delays are all configurable in the UI.
- Acceleration is handled by the plotter's Grbl-derived firmware planner. If you see overshoot or ringing, lower the **Draw** speed.
- Optional **path optimization** (toggle in the UI) reorders polylines for shorter pen-up travel, reverses them where it helps, and merges endpoints that meet. Leave it off to plot in document order.
- Long segments are subdivided to a max segment length so curves stay smooth; points are clamped to the page bounds.
- Units: the frontend converts `width`/`height` and `viewBox` to mm. If your SVG has no units, it's treated as px (96px = 1 in).
- The backend is local-only. Don't expose port 49787 publicly — there's no auth, and "plot" runs hardware.

## DrawCore command reference

The DrawCore firmware is Grbl-derived: it runs over a CH340 USB-UART at **115200 baud**, and most commands reply with `ok`. A few queries reply with a single data line and no `ok`; errors come back as `error:<n>` or `ALARM:`. The commands this project uses:

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

## Contributing

Forks, issues, and pull requests are welcome. Pull requests require agreeing to
the [Contributor License Agreement](CLA.md) — see [CONTRIBUTING.md](CONTRIBUTING.md)
for the workflow and what to know before contributing.

## License

Plotterbench is **source-available, not open source**. It is licensed under the
[PolyForm Shield License 1.0.0](LICENSE): you may use, modify, fork, and
contribute to it for free — including for your own commercial work — but you may
**not** use it to build a product or service that competes with Future Focus
Studio LLC's offerings (including the paid Plotterbench desktop build).

Copyright © 2026 Future Focus Studio LLC. All rights reserved except as granted
by the license.
| `$QP`              | Query pen state                                          |
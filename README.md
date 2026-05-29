# Plotterbench

A local web interface for plotting SVGs on a plotter. Drop an SVG, set page size, drag to position, and hit Plot. The browser talks to a small Node server over HTTP + WebSocket; the server drives the plotter directly over USB serial using EBB commands.

## Architecture

```
┌──────────────────┐      HTTP/WS      ┌──────────────────┐    USB serial    ┌──────────────┐
│  React (Vite)    │  ───────────────▶ │  Node + Express  │  ──────────────▶ │  Plotter EBB │
│  SVG preview,    │                    │  serialport,     │                  │  (EiBotBoard)│
│  page setup,     │                    │  SVG flattener,  │                  └──────────────┘
│  plot controls   │                    │  plot engine     │
└──────────────────┘                    └──────────────────┘
```

Everything lives in **one npm package** at the repo root. Source is split by area:

- `server/` — Node/TypeScript backend. Serial I/O, SVG flattening, plot engine.
- `web/` — Vite + React frontend.

## Prerequisites

- Node 18+
- A plotter plugged in via USB (EiBotBoard shows up as a serial port)

## Install & run

```bash
npm install
npm run dev
```

That single command starts **both** the Node server (`:49787`) and the Vite dev server (`:49173`). Open http://localhost:49173. Click **Refresh**, pick the plotter port (usually `/dev/tty.usbmodem…` on macOS), click **Connect**, then drop an SVG and hit **Plot**.

### Production build

```bash
npm run build
npm start
```

This builds the web app to `dist/web/` and the server to `server/dist/`, then serves both from a single process on http://localhost:49787.

## Workflow

1. **Connect** to the plotter (Refresh → select port → Connect).
2. Set **page** size (presets: A4, Letter, A3; or Custom).
3. Load an SVG (drop or browse). Adjust width/height (aspect locked by default) and drag the dashed outline on the page to position.
4. Use **Pen up / Pen down** to test servo, **Home** to return to 0,0.
5. Position your paper so the pen starts at the top-left corner of the page.
6. Click **Plot**. Watch the progress bar; click **Cancel** any time.

The plot assumes the plotter's current position is (0,0) and treats that as the top-left of your page.

## Notes & caveats

- This is a v1. No acceleration planning — it uses constant-velocity EBB `XM` moves. Drop draw speed if you see overshoot or ringing.
- No path reordering / de-duplication / pen-lift optimization yet. Complex SVGs will plot in document order.
- Units: the frontend converts `width`/`height` and `viewBox` to mm. If your SVG has no units, it's treated as px (96px = 1 in).
- Servo min/max are left at EBB defaults. Tune via your plotter setup or add UI for `SC,4`/`SC,5`.
- The backend is local-only. Don't expose port 49787 publicly — there's no auth, and "plot" runs hardware.

## EBB command reference

The commands this project uses:

| Command              | Purpose                                        |
| -------------------- | ---------------------------------------------- |
| `V`                  | Firmware version                               |
| `EM,<m1>,<m2>`       | Enable/disable motors (1 = 1/16 microstep)     |
| `SP,<state>,<ms>`    | Servo: 0 = up, 1 = down; delay after move      |
| `XM,<ms>,<x>,<y>`    | Mixed-axis XY step move over `<ms>` ms         |
| `QS`                 | Query stepper positions                        |

Full reference: https://evil-mad.github.io/EggBot/ebb.html

## Roadmap

- Path optimization (reorder for shorter travel, remove duplicate overlaps)
- Rotation controls + keyboard nudging
- Servo range UI (`SC,4`/`SC,5`)
- Acceleration/deceleration planning
- Save/recall plot profiles per paper type

# Headless capture & re-render harness

A virtual plotter that runs the real SVG → driver pipeline with **no hardware**,
so two classes of compatibility QA run on every commit (backlog task 31):

1. **Protocol golden files** — *given this SVG, the driver emits exactly these
   commands.* Each `(protocol × card)` command stream is committed under
   `server/test/goldens/`. A diff means the emitter changed.
2. **Re-render fidelity** — *those commands re-rasterize to the input geometry
   within tolerance.* The captured stream is parsed back into machine-space
   polylines and compared to what the engine intended to plot.

## How it works

The trick is reuse, not mocking: a `VirtualDevice` is a **real** driver
(`DrawCoreDriver`, `EBBDriver`, …) whose serial backend has been swapped for an
in-memory one via `SerialTransport.setBackendFactory`. The driver's actual
command *formatting* runs untouched; the fake backend just records every byte and
replies with canned firmware responses so the command queue and handshake
complete. The version reply is configurable, so version-gated paths (e.g. the
EBB v2/v3 split, task 24) can be exercised by faking the firmware string.

| File | Role |
|------|------|
| `virtual-device.ts` | Capturing serial backend + `attachCapture`. |
| `harness.ts` | `PROTOCOLS` matrix; `captureHandshake` / `capturePlot`. |
| `rerender.ts` | Command stream → polylines, plus curve-aware Hausdorff compare. |

The tests live in `server/test/capture-harness.test.ts` (round-trip over the
vendored test-card suite in `server/test/cards/`) and `server/test/rerender.test.ts`
(focused inverse-parser coverage).

## Updating goldens

When an emitter change is intentional, review the captured diff, then re-record:

```sh
npm run test:bless     # rewrites server/test/goldens, then commit them
```

## Adding a protocol

Add the driver to `PROTOCOLS` in `harness.ts` with the firmware version its
virtual device should report, add a re-render case for it in
`capture-harness.test.ts` (the inverse of its emitter), then `npm run test:bless`.

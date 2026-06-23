# Release checklist

Plotterbench's release gate is built on the QA process in
[`docs/qa/README.md`](docs/qa/README.md), which splits "compatibility" into three
independent questions — **protocol correctness**, **SVG-pipeline fidelity**, and
**physical/mechanical reality**. The first two are tested in software with no
hardware (Layer A); the third needs a pen on paper (Layer B). A release is gated
on Layer A; Layer B runs per machine on acquisition and feeds the public
[compatibility matrix](README.md#compatibility).

## Layer A — software QA (required for every release)

These run with no plotter attached and gate the build in CI
(`.github/workflows/test.yml`). Run them locally before tagging:

- [ ] `npm ci`
- [ ] `npm run build` — server typecheck + web build are clean.
- [ ] `npm test` — the full vitest suite is green. This is the Layer-A gate; it
      bundles, via the headless capture harness
      ([`server/src/testing/README.md`](server/src/testing/README.md)):
  - **Protocol golden files** — each `(protocol × test card)` command stream
    matches its committed golden under `server/test/goldens/`. A diff means a
    driver emitter changed. If the change is intentional, review the diff, then
    re-record with `npm run test:bless` and commit the updated goldens **in the
    same PR** with a note on why.
  - **Re-render fidelity** — every captured stream re-rasterizes back to the input
    geometry within tolerance (50 µm), proving flatten → transform → optimize →
    emit preserved the geometry, independent of wire protocol.
  - **Parser-matrix assertion** — card 08 exercises every supported SVG construct
    (`server/test/svg-matrix.test.ts`); each cell must produce the expected
    geometry.
  - **Pathological inputs** — degenerate/empty paths, nested transforms, unit
    edge cases, out-of-bounds clamping (`server/test/svg-*.test.ts`,
    `optimize.test.ts`, `origin.test.ts`).
- [ ] If a driver emitter changed: goldens were re-blessed **and reviewed**, not
      blindly regenerated.

> **Adding a protocol** (e.g. EBB v3 / NextDraw, vanilla Grbl): add it to
> `PROTOCOLS` in `server/src/testing/harness.ts`, add a re-render case, then
> `npm run test:bless`. The version-gated firmware paths are exercised with a
> faked `V` reply, so the EBB v2/v3 split is covered before the hardware is in hand.

## Layer B — per-machine QA (when hardware is available, not per release)

Run once when a machine is first supported, and again after any driver change to
that protocol family. Full procedure and run order:
[`docs/qa/README.md`](docs/qa/README.md) → *Layer B*.

- [ ] Copy `docs/qa/machine-result-template.md` →
      `docs/qa/results/<machine-slug>-<yyyy-mm-dd>.md`.
- [ ] Regenerate the bed-specific card 07 for this machine's drawable area
      (`generate.py --only 07-bed-extent --page custom --width <w> --height <h>`).
- [ ] Run cards 00–10 in order; measure cards 01 / 05 / 06 with a ruler; capture
      the pause-resume clip.
- [ ] File the result log and roll its bottom-line row into the
      [compatibility matrix](README.md#compatibility).

## Ship

- [ ] `CHANGELOG` / release notes call out any blessed golden changes or new
      protocol support.
- [ ] Compatibility matrix in `README.md` reflects any new Layer-B results.
- [ ] Version bumped in `package.json`.

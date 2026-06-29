# Contributing to Plotterbench

Thanks for your interest in improving Plotterbench! Forks, bug reports, and pull
requests are welcome.

## License & what you should know up front

Plotterbench is **source-available, not open source**. It is licensed under the
[PolyForm Shield License 1.0.0](LICENSE): you may use, modify, fork, and
contribute to it for free — including for your own commercial work — but you may
**not** use it to build a product or service that competes with Future Focus
Studio LLC's offerings (such as the paid Plotterbench desktop build).

Please also be aware, before contributing:

- **Your contribution may be shipped in a commercial product.** Future Focus
  Studio LLC sells a paid desktop build of Plotterbench. Accepted contributions
  may be included in it.
- **The project may be sold or transferred.** The CLA below is written so that
  the Company can transfer the project and your contribution license to a future
  acquirer.

If you're not comfortable with that, that's completely fine — you're still free
to fork and use the code within the license terms; you just may not want to
submit a pull request.

## Contributor License Agreement (required for PRs)

Before a pull request can be merged, you must agree to the
[Contributor License Agreement](CLA.md). You keep ownership of your work; you are
granting Future Focus Studio LLC a broad license to it (including the right to
relicense it commercially and to transfer it). This is the same model used by
many open-core projects.

Signing is automated. When you open a pull request, the CLA bot checks whether
you've signed; if not, it comments with instructions and the **CLA Assistant**
check stays red until you do. To sign, post a single comment on your PR with
exactly this line:

```
I have read and agree to the Plotterbench CLA (CLA.md).
```

The bot records your signature (GitHub username, timestamp, and CLA version) and
turns the check green. You sign only once — future PRs are recognized
automatically, unless the CLA version changes, in which case you'll be asked to
sign again.

## Development

```bash
npm install
npm run dev      # server (:49787) + web UI (:49173)
npm test         # run the vitest suite
npm run build    # production build
```

- Keep changes focused; one concern per pull request.
- Add or update tests for logic changes — see `server/test/`.
- Run `npm test` and `npm run build` before opening a PR.

### QA gate

`npm test` is the software-QA gate (Layer A): on top of the unit tests it runs a
**headless capture harness** that drives the real plotter drivers against a
virtual device, then checks the emitted command stream against committed
**protocol golden files** and **re-renders** it back to the input geometry. If you
change a driver emitter, a golden will diff — that's expected; review it, and if
the change is intentional re-record with `npm run test:bless` and commit the
updated goldens **in the same PR**.

## Reporting bugs

Open an issue with steps to reproduce, your OS, the plotter/driver in use, and a
minimal SVG if the problem is render- or plot-related.

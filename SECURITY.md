# Security Policy

Plotterbench is a **local-first** application: a small Node server on your own
machine drives a USB-connected pen plotter, with a browser UI talking to it over
loopback. It has no accounts, no cloud, and no telemetry — your SVGs never leave
your computer.

## Design posture (by intent, not oversight)

- The server **binds to `127.0.0.1`** only — it is not reachable from your local
  network — and both the HTTP API (CORS) and the WebSocket channel reject any
  non-loopback origin.
- There is **no authentication**, deliberately: the only client is the local UI,
  and "plot" drives physical motors. The loopback binding *is* the security
  boundary.
- Setting `HOST=0.0.0.0` removes that boundary and exposes hardware control to
  your network. Don't, unless you fully understand and accept that risk.
- Input that reaches the motors/servo is bounds-checked server-side
  (`shared/schema.ts`) to reject values that could damage the plotter.

## Reporting a vulnerability

Please report security issues **privately**, not in a public issue or PR.

- Preferred: GitHub's **"Report a vulnerability"** (this repo's **Security** tab
  → *Report a vulnerability*), which opens a private advisory.
- If that's unavailable, open a minimal public issue asking for a private contact
  and we'll follow up — without including any exploit details.

Please include the affected version/commit, a description, and steps to
reproduce. We'll acknowledge the report and work with you on a fix and
coordinated disclosure.

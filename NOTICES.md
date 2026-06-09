# Third-Party Notices & Clean-Room Statement

Plotterbench is original work by Future Focus Studio LLC. Its plotter drivers
were written to **interoperate** with existing plotter firmware, not by copying
any third-party source. This file records the references consulted and the
third-party materials acknowledged.

## Clean-room statement

Plotterbench speaks two plotter protocols, each implemented clean-room from
public protocol documentation and the observable behavior of the hardware:

- **DrawCore** (`server/src/drivers/drawcore.ts`) — the UUNA TEK iDraw / DrawCore
  Grbl-derived G-code interface, reimplemented for interoperability from the
  public Grbl G-code reference and the documented behavior of the UUNA TEK
  Inkscape extensions.
- **EBB / EiBotBoard** (`server/src/drivers/ebb.ts`) — the AxiDraw-family serial
  protocol, reimplemented from Evil Mad Scientist's **public EBB command
  reference** (<https://evil-mad.github.io/EggBot/ebb.html>).

No source code from any third-party project was copied or transliterated into
Plotterbench. Reimplementing a published protocol for interoperability is the
express intent of these protocols' public documentation. Protocol *facts* — the
command names and argument formats (`SM`, `SP`, `SC`, `EM`, `V`, `CS`), USB
VID/PID identifiers, the H-bot/CoreXY step relationship, microstepping step
counts, and the EBB's servo-position time units — are not copyrightable; their
use is what interoperability requires.

## Provenance of numeric calibration values

The EBB driver uses a small set of scalar hardware constants — pen-lift servo
endpoints, the 25 kHz step-rate ceiling, the high-resolution top speed, and
microstepping step scale. These are **functional facts** about Evil Mad
Scientist's hardware, grounded in the public EBB `SC`/`EM` command reference,
the standard RC-servo pulse range, and published AxiDraw hardware figures. They
necessarily match the values Evil Mad Scientist's own software uses, because
they describe the same physical machine. The pen-settle timing model and servo
sweep-rate defaults in `ebb.ts` are Plotterbench's own conservative choices, not
taken from any third-party source.

## Note on the GPL-licensed AxiDraw Inkscape extension

Evil Mad Scientist's AxiDraw Inkscape extension (`axidrawinternal`:
`motion.py`, `axidraw_conf.py`, `pen_handling.py`, etc.) is licensed under the
**GNU GPL v2-or-later**. It was reviewed only to understand the publicly
documented protocol and hardware behavior. **No code, and no copyrightable
expression, from those GPL files was copied or translated into Plotterbench.**
In particular, the AxiDraw extension's trapezoidal acceleration/deceleration
planner, its `LM`/`LT` accumulator math, its dripfeed command queue, and its
pen-handling state machine were **deliberately not used** — Plotterbench's
motion and pen logic are independent and substantially simpler. The reference
materials themselves are kept out of version control (`reference_drivers/` is
git-ignored) and are not redistributed.

## Acknowledgements

### plotink — Evil Mad Scientist Laboratories (MIT License)

<https://github.com/evil-mad/plotink>

`plotink` is Evil Mad Scientist's MIT-licensed Python library for the EiBotBoard.
We consulted it (notably `ebb_serial.py` and `ebb_motion.py`) to **cross-check
command semantics** — argument order of the `SM` move command, the set of query
commands that return no `OK` acknowledgement, and the chunking approach for a
timed hardware pause. Plotterbench's EBB driver is an independent TypeScript
implementation; no `plotink` code was copied.

```
The MIT License (MIT)

Copyright (c) Windell H. Oskay, Evil Mad Scientist Laboratories

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### EBB command reference — Evil Mad Scientist Laboratories

<https://evil-mad.github.io/EggBot/ebb.html>

The public EiBotBoard command-set documentation, used as the authoritative
specification for Plotterbench's EBB driver.

---

*"AxiDraw", "EggBot", and "NextDraw" are trademarks of their respective owners.
Plotterbench is an independent, unaffiliated tool that interoperates with these
machines; references to them describe compatibility only.*

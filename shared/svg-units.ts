// Single source of truth for SVG length → millimetre conversion. Shared so the
// client (display sizing) and server (flattener fallbacks) can never drift on
// how a length like "210mm" or "8.5in" maps to physical millimetres.
//
// Keep this file free of runtime dependencies so it can be pulled into either
// bundle without side effects (see the note in types.ts).

/** CSS pixels per inch — the reference the absolute units are derived from. */
const PX_PER_IN = 96;
const MM_PER_IN = 25.4;

/** Split a length string into its numeric value and unit (e.g. "10.5mm"). */
export function parseLength(v: string | null | undefined): { n: number; unit: string } | null {
  if (!v) return null;
  const m = v.trim().match(/^([-\d.eE+]+)\s*([a-z%]*)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  return { n, unit: m[2] || "" };
}

/**
 * Convert an SVG length to millimetres. Returns null for percentages or unknown
 * units (the caller decides the fallback). Unitless values are treated as CSS
 * pixels, matching browser behaviour (96px = 1in).
 */
export function lengthToMm(v: string | null | undefined): number | null {
  const parsed = parseLength(v);
  if (!parsed) return null;
  const { n, unit } = parsed;
  switch (unit) {
    case "mm":
      return n;
    case "cm":
      return n * 10;
    case "in":
      return n * MM_PER_IN;
    case "pt":
      return (n / 72) * MM_PER_IN;
    case "pc":
      return ((n * 12) / 72) * MM_PER_IN;
    case "":
    case "px":
      return (n / PX_PER_IN) * MM_PER_IN;
    default:
      return null;
  }
}

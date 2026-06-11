import { useEffect, useRef, useState } from "react";

type Props = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "type"
> & {
  value: number;
  onCommit: (n: number) => void;
  /** Decimals used when formatting the committed value back into the field. */
  decimals?: number;
  /** If true, also fire onCommit on every keystroke that parses to a number. */
  live?: boolean;
};

/**
 * Number input that keeps a local draft string while focused. The parent's
 * value only re-formats the field on blur/Enter, so typing into a fully
 * selected field doesn't fight the caret with re-renders like "1" → "1.00".
 */
export default function NumberInput({
  value,
  onCommit,
  decimals,
  live,
  onBlur,
  onKeyDown,
  onFocus,
  ...rest
}: Props) {
  const format = (n: number) =>
    decimals != null ? n.toFixed(decimals) : String(n);

  const [draft, setDraft] = useState(() => format(value));
  const editing = useRef(false);

  useEffect(() => {
    if (!editing.current) setDraft(format(value));
  }, [value, decimals]);

  const commit = () => {
    editing.current = false;
    const n = parseFloat(draft);
    if (Number.isFinite(n)) {
      onCommit(n);
      setDraft(format(n));
    } else {
      setDraft(format(value));
    }
  };

  return (
    <input
      type="number"
      {...rest}
      value={draft}
      onChange={(e) => {
        editing.current = true;
        const v = e.target.value;
        setDraft(v);
        if (live) {
          const n = parseFloat(v);
          if (Number.isFinite(n)) onCommit(n);
        }
      }}
      onFocus={(e) => {
        editing.current = true;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        commit();
        onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          (e.currentTarget as HTMLInputElement).blur();
        } else if (e.key === "Escape") {
          editing.current = false;
          setDraft(format(value));
          (e.currentTarget as HTMLInputElement).blur();
        } else if (
          e.shiftKey &&
          (e.key === "ArrowUp" || e.key === "ArrowDown")
        ) {
          // Hold Shift to step by 10x the normal increment. The native input
          // only steps by `step`, so we take over for the shifted case.
          e.preventDefault();
          const step = Number(rest.step) || 1;
          const delta = (e.key === "ArrowUp" ? 1 : -1) * step * 10;
          const base = parseFloat(draft);
          let next = (Number.isFinite(base) ? base : value) + delta;
          const min = rest.min != null ? Number(rest.min) : -Infinity;
          const max = rest.max != null ? Number(rest.max) : Infinity;
          next = Math.min(max, Math.max(min, next));
          // Avoid float dust like 0.30000000000000004 from repeated steps.
          next = Number(next.toFixed(12));
          editing.current = true;
          setDraft(format(next));
          onCommit(next);
        }
        onKeyDown?.(e);
      }}
    />
  );
}

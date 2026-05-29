import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

interface Props {
  polylines: { x: number; y: number }[][] | null;
  /** Index of the polyline currently drawing (or stopped at). */
  currentIndex: number;
  /** True while a plot is actively running. */
  drawing: boolean;
  hoveredIndex: number | null;
  onHover: (i: number | null) => void;
  /** Re-issue the plot starting from this index. */
  onRewind: (i: number) => void;
  /** Disable click-to-rewind (e.g. mid-plot or not connected). */
  rewindDisabled: boolean;
}

const ROW_H = 26;
const OVERSCAN = 8;

function polylineLengthMm(pl: { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < pl.length; i++) {
    const dx = pl[i].x - pl[i - 1].x;
    const dy = pl[i].y - pl[i - 1].y;
    len += Math.hypot(dx, dy);
  }
  return len;
}

export default function InstructionList({
  polylines,
  currentIndex,
  drawing,
  hoveredIndex,
  onHover,
  onRewind,
  rewindDisabled,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setViewH(el.clientHeight);
    const ro = new ResizeObserver((entries) => setViewH(entries[0].contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-scroll the current row into view as the plot progresses. Only force
  // scroll when the user isn't actively browsing — i.e. when the current row
  // would otherwise be out of view.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !drawing) return;
    const top = currentIndex * ROW_H;
    const margin = ROW_H * 2;
    if (top < el.scrollTop + margin) {
      el.scrollTop = Math.max(0, top - margin);
    } else if (top + ROW_H > el.scrollTop + viewH - margin) {
      el.scrollTop = top - viewH + ROW_H + margin;
    }
  }, [currentIndex, drawing, viewH]);

  const lengths = useMemo(() => polylines?.map(polylineLengthMm) ?? [], [polylines]);

  const total = polylines?.length ?? 0;
  const totalH = total * ROW_H;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

  const rows: JSX.Element[] = [];
  if (polylines) {
    for (let i = first; i < last; i++) {
      const pl = polylines[i];
      const status =
        i < currentIndex ? "drawn" :
        i === currentIndex && drawing ? "drawing" :
        "pending";
      const isHover = hoveredIndex === i;
      const cls = `instr-row instr-${status}${isHover ? " instr-hover" : ""}`;
      rows.push(
        <div
          key={i}
          className={cls}
          style={{ top: i * ROW_H, height: ROW_H }}
          onMouseEnter={() => onHover(i)}
          onClick={() => { if (!rewindDisabled) onRewind(i); }}
          title={rewindDisabled ? `#${i + 1}` : `Plot from #${i + 1}`}
        >
          <span className="instr-status-dot" />
          <span className="instr-num">#{i + 1}</span>
          <span className="instr-meta">{pl.length} pt · {lengths[i].toFixed(1)} mm</span>
        </div>
      );
    }
  }

  return (
    <div
      ref={containerRef}
      className="instr-list"
      onScroll={(e) => setScrollTop((e.currentTarget as HTMLDivElement).scrollTop)}
      onMouseLeave={() => onHover(null)}
    >
      {total === 0 ? (
        <div className="instr-empty">Run Plot to view instructions.</div>
      ) : (
        <div className="instr-spacer" style={{ height: totalH }}>
          {rows}
        </div>
      )}
    </div>
  );
}

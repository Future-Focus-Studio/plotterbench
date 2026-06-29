import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  pageWidthMm: number;
  pageHeightMm: number;
  svg: string | null;
  svgViewBoxWidth: number;
  svgViewBoxHeight: number;
  svgWidthMm: number;
  svgHeightMm: number;
  offsetXMm: number;
  offsetYMm: number;
  /** If set, corner-drag resizing preserves this width/height ratio. */
  lockedAspect: number | null;
  onOffsetChange: (x: number, y: number) => void;
  onSizeChange: (widthMm: number, heightMm: number, offsetXMm: number, offsetYMm: number) => void;
  /** Page-mm polylines the server is drawing; null when no active plot. */
  plotPolylines?: { x: number; y: number }[][] | null;
  plotPolylineIndex?: number;
  plotSegmentIndex?: number;
  plotPhase?: "preparing" | "drawing" | "paused" | "done" | "error" | "cancelled" | null;
  /** When set, renders this polyline in a distinctive highlight on top of the overlay. */
  hoveredPolylineIndex?: number | null;
  /** When true, override all SVG styling to render every element as thin black lines. */
  thinLinePreview?: boolean;
  /** Background color of the page rect — visual only, never plotted. */
  pageBackground?: string;
}

const PADDING = 32;
const MIN_SIZE_MM = 1;
/** Above this many SVG elements, the preview is rasterized to one <image>
 *  instead of injecting every node as live DOM (which freezes the UI). */
const RASTER_NODE_THRESHOLD = 5000;
/** Handle size in screen pixels — converted to page-mm using current scale. */
const HANDLE_PX = 10;

type Corner = "nw" | "ne" | "sw" | "se";

interface DragStart {
  px: number;       // client-space origin
  py: number;
  ox: number;       // original offset / size in page-mm
  oy: number;
  w: number;
  h: number;
}

export default function PageCanvas({
  pageWidthMm,
  pageHeightMm,
  svg,
  svgViewBoxWidth,
  svgViewBoxHeight,
  svgWidthMm,
  svgHeightMm,
  offsetXMm,
  offsetYMm,
  lockedAspect,
  onOffsetChange,
  onSizeChange,
  plotPolylines,
  plotPolylineIndex = 0,
  plotSegmentIndex = 0,
  plotPhase,
  hoveredPolylineIndex = null,
  thinLinePreview = true,
  pageBackground = "white",
}: Props) {
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState<Corner | null>(null);
  const dragStart = useRef<DragStart | null>(null);
  const wrapperRef = useRef<SVGGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 800, h: 600 });
  const scaleRef = useRef(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setContainerSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const availW = containerSize.w - PADDING * 2;
  const availH = containerSize.h - PADDING * 2;
  const scale = Math.min(availW / pageWidthMm, availH / pageHeightMm);
  scaleRef.current = scale;
  const displayW = pageWidthMm * scale;
  const displayH = pageHeightMm * scale;

  // ---- Move drag (body of the SVG bounding box) ----
  const onMoveDown = useCallback(
    (e: React.PointerEvent) => {
      if (!svg) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setDragging(true);
      dragStart.current = {
        px: e.clientX, py: e.clientY,
        ox: offsetXMm, oy: offsetYMm,
        w: svgWidthMm, h: svgHeightMm,
      };
    },
    [svg, offsetXMm, offsetYMm, svgWidthMm, svgHeightMm]
  );

  const onMoveMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging || !dragStart.current) return;
      const dx = (e.clientX - dragStart.current.px) / scaleRef.current;
      const dy = (e.clientY - dragStart.current.py) / scaleRef.current;
      onOffsetChange(dragStart.current.ox + dx, dragStart.current.oy + dy);
    },
    [dragging, onOffsetChange]
  );

  const onMoveUp = useCallback(() => {
    setDragging(false);
    dragStart.current = null;
  }, []);

  // ---- Corner-handle resize ----
  const onHandleDown = useCallback(
    (corner: Corner) => (e: React.PointerEvent) => {
      if (!svg) return;
      e.stopPropagation();
      (e.target as Element).setPointerCapture?.(e.pointerId);
      setResizing(corner);
      dragStart.current = {
        px: e.clientX, py: e.clientY,
        ox: offsetXMm, oy: offsetYMm,
        w: svgWidthMm, h: svgHeightMm,
      };
    },
    [svg, offsetXMm, offsetYMm, svgWidthMm, svgHeightMm]
  );

  const onHandleMove = useCallback(
    (e: React.PointerEvent) => {
      if (!resizing || !dragStart.current) return;
      const init = dragStart.current;
      const dx = (e.clientX - init.px) / scaleRef.current;
      const dy = (e.clientY - init.py) / scaleRef.current;

      // Anchor = the corner opposite to the one being dragged. It stays put.
      const anchorX = (resizing === "nw" || resizing === "sw") ? init.ox + init.w : init.ox;
      const anchorY = (resizing === "nw" || resizing === "ne") ? init.oy + init.h : init.oy;

      // Starting position of the dragged corner.
      const initCornerX = (resizing === "nw" || resizing === "sw") ? init.ox : init.ox + init.w;
      const initCornerY = (resizing === "nw" || resizing === "ne") ? init.oy : init.oy + init.h;

      const cornerX = initCornerX + dx;
      const cornerY = initCornerY + dy;

      // Sign tracks whether the cursor is currently on the positive or
      // negative side of the anchor. This lets the box follow the cursor
      // cleanly even if the user drags past the anchor ("flipping" the box).
      const signX = cornerX >= anchorX ? 1 : -1;
      const signY = cornerY >= anchorY ? 1 : -1;

      let newW = Math.max(MIN_SIZE_MM, Math.abs(cornerX - anchorX));
      let newH = Math.max(MIN_SIZE_MM, Math.abs(cornerY - anchorY));

      if (lockedAspect != null && lockedAspect > 0) {
        // Use whichever axis moved proportionally more as the driver so the
        // cursor tracks naturally regardless of drag direction.
        const wRatio = newW / init.w;
        const hRatio = newH / init.h;
        if (wRatio >= hRatio) newH = newW / lockedAspect;
        else newW = newH * lockedAspect;
      }

      // The anchor corner stays pinned; the box extends from it in whichever
      // direction the cursor currently is.
      const newOx = signX === 1 ? anchorX : anchorX - newW;
      const newOy = signY === 1 ? anchorY : anchorY - newH;

      onSizeChange(newW, newH, newOx, newOy);
    },
    [resizing, lockedAspect, onSizeChange]
  );

  const onHandleUp = useCallback(() => {
    setResizing(null);
    dragStart.current = null;
  }, []);

  // ---- Render SVG content inside the page ----
  useEffect(() => {
    const wrap = wrapperRef.current;
    if (!wrap) return;
    if (!svg) {
      wrap.innerHTML = "";
      return;
    }
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = doc.querySelector("svg");
    if (!root) {
      wrap.innerHTML = "";
      return;
    }

    // Very large SVGs (e.g. dithered output with 100k+ <line>s) would freeze the
    // main thread if injected as live DOM and restyled node-by-node — and the
    // node mass keeps every later interaction sluggish. Past a threshold,
    // rasterize the whole thing into one <image> the browser paints off the
    // critical path; the thin-line look is applied with a single <style> rule
    // instead of mutating every element.
    const nodeCount = root.getElementsByTagName("*").length;
    if (nodeCount > RASTER_NODE_THRESHOLD) {
      if (thinLinePreview) {
        const style = doc.createElementNS("http://www.w3.org/2000/svg", "style");
        style.textContent =
          "*{fill:none!important;stroke:#222!important;stroke-width:0.3!important;" +
          "opacity:1!important;visibility:visible!important;display:inline!important}";
        root.insertBefore(style, root.firstChild);
      }
      const serialized = new XMLSerializer().serializeToString(root);
      const url = URL.createObjectURL(new Blob([serialized], { type: "image/svg+xml" }));
      wrap.innerHTML =
        `<image href="${url}" x="0" y="0" width="${svgViewBoxWidth}" height="${svgViewBoxHeight}" preserveAspectRatio="none"></image>`;
      return () => URL.revokeObjectURL(url);
    }

    wrap.innerHTML = root.innerHTML;
    if (thinLinePreview) {
      const all = wrap.querySelectorAll<SVGElement>("*");
      for (const el of all) {
        el.removeAttribute("display");
        el.removeAttribute("visibility");
        el.style.display = "";
        el.style.visibility = "visible";
        el.style.opacity = "1";
        el.style.fill = "none";
        el.style.stroke = "#222";
        el.style.strokeWidth = "0.3";
        el.removeAttribute("opacity");
        el.removeAttribute("fill-opacity");
        el.removeAttribute("stroke-opacity");
      }
    }
  }, [svg, thinLinePreview, svgViewBoxWidth, svgViewBoxHeight]);

  const sx = svgViewBoxWidth > 0 ? svgWidthMm / svgViewBoxWidth : 1;
  const sy = svgViewBoxHeight > 0 ? svgHeightMm / svgViewBoxHeight : 1;

  // Corner handle geometry in page-mm units, so it renders at ~HANDLE_PX px.
  const handleSize = scale > 0 ? HANDLE_PX / scale : 2;
  const handleHalf = handleSize / 2;

  const plotOverlay = (() => {
    if (!plotPolylines || plotPolylines.length === 0) return null;
    const showAll = plotPhase === "done";
    const fullCount = showAll
      ? plotPolylines.length
      : Math.max(0, Math.min(plotPolylineIndex, plotPolylines.length));
    const toPoints = (pts: { x: number; y: number }[]) =>
      pts.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(" ");
    const strokeW = 0.5;
    const full: JSX.Element[] = [];
    for (let i = 0; i < fullCount; i++) {
      const pl = plotPolylines[i];
      if (pl.length < 2) continue;
      full.push(
        <polyline
          key={`d-${i}`}
          points={toPoints(pl)}
          fill="none"
          stroke="#e33"
          strokeWidth={strokeW}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    }
    let partial: JSX.Element | null = null;
    if (!showAll && fullCount < plotPolylines.length) {
      const pl = plotPolylines[fullCount];
      if (pl && pl.length >= 2 && plotSegmentIndex > 0) {
        const upto = Math.min(plotSegmentIndex + 1, pl.length);
        partial = (
          <polyline
            key={`d-partial`}
            points={toPoints(pl.slice(0, upto))}
            fill="none"
            stroke="#e33"
            strokeWidth={strokeW}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      }
    }
    return (
      <g style={{ pointerEvents: "none" }}>
        {full}
        {partial}
      </g>
    );
  })();

  const hoverOverlay = (() => {
    if (hoveredPolylineIndex == null) return null;
    if (!plotPolylines || plotPolylines.length === 0) return null;
    const pl = plotPolylines[hoveredPolylineIndex];
    if (!pl || pl.length < 2) return null;
    const points = pl.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(" ");
    const haloW = 1.6;
    const coreW = 0.6;
    return (
      <g style={{ pointerEvents: "none" }}>
        <polyline
          points={points}
          fill="none"
          stroke="#000"
          strokeOpacity={0.35}
          strokeWidth={haloW}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline
          points={points}
          fill="none"
          stroke="#ffd84a"
          strokeWidth={coreW}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    );
  })();

  const cornerPoints: Record<Corner, { x: number; y: number; cursor: string }> = {
    nw: { x: offsetXMm,                 y: offsetYMm,                 cursor: "nwse-resize" },
    ne: { x: offsetXMm + svgWidthMm,    y: offsetYMm,                 cursor: "nesw-resize" },
    sw: { x: offsetXMm,                 y: offsetYMm + svgHeightMm,   cursor: "nesw-resize" },
    se: { x: offsetXMm + svgWidthMm,    y: offsetYMm + svgHeightMm,   cursor: "nwse-resize" },
  };

  return (
    <div ref={containerRef} className="canvas-container">
      <div className="page-wrap">
        <svg
          className="page-svg"
          width={displayW}
          height={displayH}
          viewBox={`0 0 ${pageWidthMm} ${pageHeightMm}`}
        >
          <rect x={0} y={0} width={pageWidthMm} height={pageHeightMm} fill={pageBackground} />
          <g
            ref={wrapperRef}
            className={`content-group${dragging ? " dragging" : ""}`}
            transform={`translate(${offsetXMm},${offsetYMm}) scale(${sx},${sy})`}
            style={{ pointerEvents: "none" }}
          />
          {plotOverlay}
          {hoverOverlay}
          {svg && (
            <>
              {/* Move handle: the whole bounding box interior */}
              <rect
                x={offsetXMm}
                y={offsetYMm}
                width={svgWidthMm}
                height={svgHeightMm}
                fill="transparent"
                stroke="#2a6"
                strokeWidth={0.3}
                strokeDasharray="1 1"
                onPointerDown={onMoveDown}
                onPointerMove={onMoveMove}
                onPointerUp={onMoveUp}
                onPointerCancel={onMoveUp}
                style={{ cursor: dragging ? "grabbing" : "grab" }}
              />
              {/* Corner resize handles */}
              {(Object.keys(cornerPoints) as Corner[]).map((corner) => {
                const c = cornerPoints[corner];
                return (
                  <rect
                    key={corner}
                    x={c.x - handleHalf}
                    y={c.y - handleHalf}
                    width={handleSize}
                    height={handleSize}
                    fill="#fff"
                    stroke="#2a6"
                    strokeWidth={0.4}
                    onPointerDown={onHandleDown(corner)}
                    onPointerMove={onHandleMove}
                    onPointerUp={onHandleUp}
                    onPointerCancel={onHandleUp}
                    style={{ cursor: c.cursor }}
                  />
                );
              })}
            </>
          )}
        </svg>
        {!svg && (
          <div className="page-placeholder">
            Drop an SVG here or pick a calibration pattern
          </div>
        )}
      </div>
    </div>
  );
}

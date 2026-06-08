import { useEffect, useRef, useState } from "react";

export interface SvgTreeNode {
  key: string;      // dot-separated child-index path, e.g. "1", "1-2-0"
  tag: string;
  label: string;
  children: SvgTreeNode[];
}

const SKIP_TAGS = new Set([
  "defs","style","title","desc","metadata","symbol",
  "clippath","mask","filter","lineargradient","radialgradient","pattern","script",
]);

const DRAWABLE_TAGS = new Set([
  "g","path","rect","circle","ellipse","line","polyline","polygon","text","image","use",
]);

export function buildSvgTree(svgText: string): SvgTreeNode[] {
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = doc.querySelector("svg");
  if (!root) return [];

  function build(el: Element, path: number[]): SvgTreeNode | null {
    const tag = el.tagName.toLowerCase().replace(/^.*:/, "");
    if (SKIP_TAGS.has(tag)) return null;

    const children: SvgTreeNode[] = [];
    let ci = 0;
    for (const child of el.children) {
      const n = build(child, [...path, ci]);
      if (n) children.push(n);
      ci++;
    }

    if (!DRAWABLE_TAGS.has(tag) && children.length === 0) return null;

    const key = path.join("-");
    const label =
      el.getAttribute("inkscape:label") ??
      el.getAttribute("id") ??
      (el.getAttribute("class")
        ? `${tag}.${el.getAttribute("class")!.trim().split(/\s+/)[0]}`
        : tag);

    return { key, tag, label, children };
  }

  const result: SvgTreeNode[] = [];
  let i = 0;
  for (const child of root.children) {
    const n = build(child, [i]);
    if (n) result.push(n);
    i++;
  }
  return result;
}

// Strip a set of CSS properties from an element's inline `style` attribute.
function stripStyleProps(el: Element, props: readonly string[]) {
  const style = el.getAttribute("style");
  if (!style) return;
  const kept = style.split(";")
    .map((s) => s.trim())
    .filter((s) => s && !props.some((p) => s.startsWith(p + ":") || s.startsWith(p + " :")));
  if (kept.length) el.setAttribute("style", kept.join("; "));
  else el.removeAttribute("style");
}

// Apply per-layer color overrides. When a layer key has an override, the color
// cascades to every drawable descendant (stroke is always set; fill is set when
// the existing fill is not "none"). Visual only — doesn't affect plot geometry.
export function applyLayerColors(
  svgText: string,
  colors: Readonly<Record<string, string>>,
): string {
  if (Object.keys(colors).length === 0) return svgText;
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = doc.querySelector("svg");
  if (!root) return svgText;

  function styleProp(el: Element, prop: string): string | null {
    const style = el.getAttribute("style");
    if (!style) return null;
    for (const part of style.split(";")) {
      const [k, v] = part.split(":").map((s) => s.trim());
      if (k === prop) return v ?? null;
    }
    return null;
  }

  function applyColor(el: Element, color: string) {
    const tag = el.tagName.toLowerCase().replace(/^.*:/, "");
    if (DRAWABLE_TAGS.has(tag) && tag !== "g") {
      el.setAttribute("stroke", color);
      const fill = el.getAttribute("fill") ?? styleProp(el, "fill");
      if (fill && fill !== "none") el.setAttribute("fill", color);
      stripStyleProps(el, ["stroke", "fill"]);
    } else if (tag === "g") {
      el.setAttribute("stroke", color);
      stripStyleProps(el, ["stroke"]);
    }
  }

  function walk(el: Element, path: number[], inherited: string | null) {
    const key = path.join("-");
    const color = colors[key] ?? inherited;
    if (color) applyColor(el, color);
    let i = 0;
    for (const child of el.children) {
      walk(child, [...path, i], color);
      i++;
    }
  }

  let i = 0;
  for (const child of root.children) {
    walk(child, [i], null);
    i++;
  }
  return new XMLSerializer().serializeToString(root);
}

// Remove elements whose tree key is in hiddenKeys, then serialize back to SVG text.
export function filterSvgByHidden(svgText: string, hiddenKeys: ReadonlySet<string>): string {
  if (hiddenKeys.size === 0) return svgText;
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const root = doc.querySelector("svg");
  if (!root) return svgText;

  function prune(el: Element, path: number[]) {
    if (hiddenKeys.has(path.join("-"))) {
      el.parentNode!.removeChild(el);
      return;
    }
    let i = 0;
    for (const child of Array.from(el.children)) {
      prune(child, [...path, i]);
      i++;
    }
  }

  let i = 0;
  for (const child of Array.from(root.children)) {
    prune(child, [i]);
    i++;
  }
  return new XMLSerializer().serializeToString(root);
}

// ---- Icons ----
function EyeOpen() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M1 7c1.5-3 9.5-3 12 0-2.5 3-10.5 3-12 0z"/>
      <circle cx="7" cy="7" r="1.8" fill="currentColor" stroke="none"/>
    </svg>
  );
}

function EyeClosed() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
      <path d="M1 7c1.5-3 9.5-3 12 0-2.5 3-10.5 3-12 0z" strokeOpacity="0.35"/>
      <line x1="3" y1="4" x2="11" y2="10"/>
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12 L4 11.5 L11 4.5 L9.5 3 L2.5 10 Z"/>
      <path d="M9.5 3 L11 4.5"/>
    </svg>
  );
}

// ---- Node row ----
interface RowProps {
  node: SvgTreeNode;
  depth: number;
  expanded: ReadonlySet<string>;
  hidden: ReadonlySet<string>;
  labels: Readonly<Record<string, string>>;
  colors: Readonly<Record<string, string>>;
  onExpand: (key: string) => void;
  onHide: (key: string) => void;
  onRename: (key: string, label: string) => void;
  onColor: (key: string, color: string) => void;
}

function NodeRow({ node, depth, expanded, hidden, labels, colors, onExpand, onHide, onRename, onColor }: RowProps) {
  const isExpanded = expanded.has(node.key);
  const isHidden = hidden.has(node.key);
  const hasChildren = node.children.length > 0;
  const displayLabel = labels[node.key] ?? node.label;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayLabel);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const colorInputRef = useRef<HTMLInputElement | null>(null);
  const colorOverride = colors[node.key];

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startRename = () => {
    setDraft(displayLabel);
    setEditing(true);
  };

  const commitRename = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== node.label) onRename(node.key, trimmed);
    else if (!trimmed) onRename(node.key, ""); // clear override → fall back to default
    setEditing(false);
  };

  return (
    <>
      <div
        className={`tree-row${isHidden ? " tree-hidden" : ""}${hasChildren ? " tree-row-toggle" : ""}`}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
        onClick={() => { if (hasChildren && !editing) onExpand(node.key); }}
      >
        <span
          className="tree-chevron"
          style={{ visibility: hasChildren ? "visible" : "hidden" }}
        >
          {isExpanded ? "▾" : "▸"}
        </span>
        <span className="tree-tag">{node.tag}</span>
        {editing ? (
          <input
            ref={inputRef}
            className="tree-rename"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <span className="tree-label">{displayLabel}</span>
        )}
        <button
          className="tree-icon-btn"
          onClick={(e) => { e.stopPropagation(); startRename(); }}
          title="Rename"
        >
          <PencilIcon />
        </button>
        <input
          ref={colorInputRef}
          type="color"
          value={colorOverride ?? "#000000"}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onColor(node.key, e.target.value)}
          style={{ display: "none" }}
        />
        <button
          className={`tree-icon-btn tree-color-swatch${colorOverride ? " is-active" : ""}`}
          onClick={(e) => { e.stopPropagation(); colorInputRef.current?.click(); }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (colorOverride) onColor(node.key, "");
          }}
          title={colorOverride
            ? `Color override: ${colorOverride} — right-click to clear`
            : "Set color override (right-click to clear)"}
          style={colorOverride ? { background: colorOverride } : undefined}
        >
          {!colorOverride && (
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
              <circle cx="7" cy="7" r="4.5"/>
              <line x1="3.8" y1="10.2" x2="10.2" y2="3.8"/>
            </svg>
          )}
        </button>
        <button
          className="tree-icon-btn tree-eye"
          onClick={(e) => { e.stopPropagation(); onHide(node.key); }}
          title={isHidden ? "Show" : "Hide"}
        >
          {isHidden ? <EyeClosed /> : <EyeOpen />}
        </button>
      </div>
      {hasChildren && isExpanded && node.children.map((child) => (
        <NodeRow key={child.key} node={child} depth={depth + 1}
          expanded={expanded} hidden={hidden} labels={labels} colors={colors}
          onExpand={onExpand} onHide={onHide} onRename={onRename} onColor={onColor} />
      ))}
    </>
  );
}

// ---- Public component ----
interface Props {
  nodes: SvgTreeNode[];
  expanded: ReadonlySet<string>;
  hidden: ReadonlySet<string>;
  labels: Readonly<Record<string, string>>;
  colors: Readonly<Record<string, string>>;
  onExpand: (key: string) => void;
  onHide: (key: string) => void;
  onRename: (key: string, label: string) => void;
  onColor: (key: string, color: string) => void;
}

export default function SvgTree({ nodes, expanded, hidden, labels, colors, onExpand, onHide, onRename, onColor }: Props) {
  if (nodes.length === 0) return null;
  return (
    <div className="svg-tree">
      {nodes.map((node) => (
        <NodeRow key={node.key} node={node} depth={0}
          expanded={expanded} hidden={hidden} labels={labels} colors={colors}
          onExpand={onExpand} onHide={onHide} onRename={onRename} onColor={onColor} />
      ))}
    </div>
  );
}

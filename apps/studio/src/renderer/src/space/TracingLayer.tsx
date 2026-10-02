/**
 * Drawing building areas directly on the photo ("Areas" step):
 *   Rectangle   drag a box (most windows and doors)
 *   Outline     click corners; click the first point, double-click or press Enter to finish
 *   Edge        click along a roofline or edge; double-click or Enter to finish
 *   Cut a hole  outline a hole inside the selected area (e.g. a window in a wall)
 *   Select      click an area; drag its corner squares, drag a "+" edge handle to move that edge
 *               (click it to add a point), drag inside the area to move it; Alt-click a corner or
 *               select it and press Delete to remove it; Ctrl+D duplicates
 * Points snap to nearby corners of other areas; hold Shift to keep lines straight. Areas are shared
 * by every scene: editing them here updates every scene that uses them.
 */
import { type PathData, type Region, regionHoles, type Vec2 } from "@be/core";
import { useEffect, useRef, useState } from "react";
import { pathD } from "../preview/overlays.tsx";
import { activeVenue, useStudio } from "../studio/store.ts";
import { addRegion, deleteRegions } from "./actions.ts";
import { addHole, duplicateAreas, insertPoint, moveArea, moveEdge, removePoint } from "./areaEdit.ts";
import { KIND_CHOICES, useTrace } from "./traceStore.ts";

const rectPath = (a: Vec2, b: Vec2): PathData => {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  return { closed: true, vertices: [{ p: [x0, y0] }, { p: [x1, y0] }, { p: [x1, y1] }, { p: [x0, y1] }] };
};

/** Pointer capture keeps drags working outside the outline; synthetic (test) events have no active pointer. */
const capture = (e: React.PointerEvent) => {
  try {
    (e.target as Element).setPointerCapture(e.pointerId);
  } catch {
    /* no active pointer */
  }
};

/** Finish the shape being drawn (double-clicks add repeated points, which are dropped). */
const finishDraft = (closed: boolean) => {
  const t = useTrace.getState();
  const raw = t.draft;
  const pts = raw.filter((p, i) => i === 0 || Math.hypot(p[0] - raw[i - 1]![0], p[1] - raw[i - 1]![1]) > 0.5);
  if (pts.length < (closed ? 3 : 2)) return;
  const path: PathData = { closed, vertices: pts.map((p) => ({ p })) };
  if (t.tool === "hole") {
    const s = useStudio.getState();
    const v = s.project ? activeVenue({ project: s.project }) : undefined;
    const target = s.selection.regionIds.length === 1 ? v?.regions[s.selection.regionIds[0]!] : undefined;
    t.set({ draft: [] });
    if (!target || !target.path.closed) {
      s.toast({ kind: "info", text: "Select the area to cut the hole from first (Select tool), then draw the hole." });
      return;
    }
    addHole(target, path);
    return;
  }
  t.set({ pending: { path, at: pts[pts.length - 1]! }, draft: [] });
};

type Drag =
  | { kind: "vertex"; regionId: string; index: number }
  | { kind: "edge"; regionId: string; index: number; from: Vec2; base: PathData; moved: boolean; key: string }
  | { kind: "area"; regionId: string; from: Vec2; base: { path: PathData; holes?: readonly PathData[] }; key: string };

export const TracingLayer = ({ size }: { size: { w: number; h: number } }) => {
  const project = useStudio((s) => s.project)!;
  const selection = useStudio((s) => s.selection.regionIds);
  const venue = activeVenue({ project });
  const { tool, draft, pending, suggestions, vertex } = useTrace();
  const svgRef = useRef<SVGSVGElement>(null);
  const [cursor, setCursor] = useState<Vec2 | null>(null);
  // Drag state lives in refs so very fast input (or scripted events) never reads a stale value.
  const rectStart = useRef<Vec2 | null>(null);
  const drag = useRef<Drag | null>(null);
  const [, redraw] = useState(0);
  // Keyboard: Enter finishes, Esc cancels, Delete removes a selected corner or the selected areas, Ctrl+D duplicates.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = useTrace.getState();
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      const s = useStudio.getState();
      if (e.key === "Escape") {
        if (t.draft.length || t.pending || t.vertex) {
          e.stopPropagation();
          t.set({ draft: [], pending: null, vertex: null });
        }
      } else if (e.key === "Enter" && t.draft.length) {
        finishDraft(t.tool !== "edge");
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d" && s.selection.regionIds.length) {
        e.preventDefault();
        e.stopPropagation();
        duplicateAreas(s.selection.regionIds);
      } else if ((e.key === "Delete" || e.key === "Backspace") && t.tool === "select" && !s.selection.recipeId) {
        const v = s.project ? activeVenue({ project: s.project }) : undefined;
        const r = t.vertex ? v?.regions[t.vertex.regionId] : undefined;
        if (r && t.vertex) {
          e.stopPropagation();
          if (removePoint(r, t.vertex.index)) t.set({ vertex: null });
        } else if (s.selection.regionIds.length) deleteRegions(s.selection.regionIds);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  if (!venue) return null;
  const W = venue.canvas.width;
  const H = venue.canvas.height;
  const px = W / size.w; // canvas units per screen pixel

  const toCanvas = (e: { clientX: number; clientY: number }): Vec2 => {
    const r = svgRef.current!.getBoundingClientRect();
    return [Math.max(0, Math.min(W, ((e.clientX - r.left) / r.width) * W)), Math.max(0, Math.min(H, ((e.clientY - r.top) / r.height) * H))];
  };

  /** `skip` excludes the corner being dragged, so small corrections don't snap back to where it was. */
  const snap = (p: Vec2, shift: boolean, from?: Vec2, skip?: { regionId: string; index: number }): Vec2 => {
    let q = p;
    if (shift && from) {
      const dx = q[0] - from[0];
      const dy = q[1] - from[1];
      const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      q = [from[0] + Math.cos(ang) * len, from[1] + Math.sin(ang) * len];
    }
    // Snap to existing corners within ~10 screen pixels.
    let best: Vec2 | null = null;
    let bestD = 10 * px;
    for (const id of venue.regionOrder) {
      for (const [vi, v] of venue.regions[id]!.path.vertices.entries()) {
        if (skip && skip.regionId === id && skip.index === vi) continue;
        const d = Math.hypot(v.p[0] - q[0], v.p[1] - q[1]);
        if (d < bestD) {
          bestD = d;
          best = v.p;
        }
      }
    }
    for (const v of draft) {
      const d = Math.hypot(v[0] - q[0], v[1] - q[1]);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best ? [best[0], best[1]] : [Math.round(q[0]), Math.round(q[1])];
  };

  const drawing = tool !== "select";
  const selected: Region | undefined = selection.length === 1 ? venue.regions[selection[0]!] : undefined;
  const regionNow = (id: string) => {
    const p = useStudio.getState().project;
    return p ? activeVenue({ project: p })?.regions[id] : undefined;
  };

  const onMove = (e: React.PointerEvent) => {
    const p = toCanvas(e);
    const d = drag.current;
    if (d) {
      const r = regionNow(d.regionId);
      if (!r) return;
      if (d.kind === "vertex") {
        const q = snap(p, e.shiftKey, undefined, d);
        const vertices = r.path.vertices.map((v, i) => (i === d.index ? { ...v, p: q } : v));
        useStudio.getState().apply(
          { type: "region.update", args: { venueId: venue.id, regionId: r.id, changes: { path: { closed: r.path.closed, vertices } } } },
          { label: "Adjust outline", coalesceKey: `vtx-${r.id}-${d.index}`, quiet: true },
        );
      } else if (d.kind === "edge") {
        const delta: Vec2 = [p[0] - d.from[0], p[1] - d.from[1]];
        if (Math.hypot(delta[0], delta[1]) > 2 * px) d.moved = true;
        if (d.moved) moveEdge(r, d.base, d.index, delta, d.key);
      } else {
        moveArea(r, d.base, [p[0] - d.from[0], p[1] - d.from[1]], d.key);
      }
      return;
    }
    if (drawing) setCursor(snap(p, e.shiftKey, draft.at(-1)));
  };

  return (
    <>
      <svg
        ref={svgRef}
        className={`overlay trace ${drawing ? "drawing" : ""}`}
        viewBox={`0 0 ${W} ${H}`}
        width={size.w}
        height={size.h}
        style={{ pointerEvents: drawing || drag.current ? "all" : "none" }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => {
          if (!drawing || pending) return;
          const p = snap(toCanvas(e), e.shiftKey, draft.at(-1));
          if (tool === "rect") {
            capture(e);
            rectStart.current = p;
            redraw((n) => n + 1);
          }
        }}
        onPointerMove={onMove}
        onPointerUp={(e) => {
          const d = drag.current;
          if (d) {
            drag.current = null;
            // A click (no drag) on an edge handle adds a point there.
            if (d.kind === "edge" && !d.moved) {
              const r = regionNow(d.regionId);
              if (r) {
                const a = r.path.vertices[d.index]!.p;
                const b = r.path.vertices[(d.index + 1) % r.path.vertices.length]!.p;
                insertPoint(r, d.index, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
                useTrace.getState().set({ vertex: { regionId: r.id, index: d.index + 1 } });
              }
            }
            redraw((n) => n + 1);
            return;
          }
          const start = rectStart.current;
          if (tool === "rect" && start) {
            const end = snap(toCanvas(e), false);
            rectStart.current = null;
            redraw((n) => n + 1);
            if (Math.abs(end[0] - start[0]) > 4 * px && Math.abs(end[1] - start[1]) > 4 * px) {
              useTrace.getState().set({ pending: { path: rectPath(start, end), at: end } });
            }
            return;
          }
          const t = useTrace.getState();
          if ((tool === "polygon" || tool === "edge" || tool === "hole") && !t.pending) {
            const cur = t.draft;
            const p = snap(toCanvas(e), e.shiftKey, cur.at(-1));
            const first = cur[0];
            if (tool !== "edge" && first && cur.length >= 3 && Math.hypot(first[0] - p[0], first[1] - p[1]) < 12 * px) {
              finishDraft(true);
              return;
            }
            t.set({ draft: [...cur, p] });
          }
        }}
        onDoubleClick={() => {
          if (tool === "polygon" || tool === "edge" || tool === "hole") finishDraft(tool !== "edge");
        }}
      >
        {/* Suggestions: dashed until accepted; click to keep or drop each one. */}
        {suggestions?.items.map((sg) => (
          <path
            key={sg.id}
            d={pathD(sg.path)}
            className={`suggestion ${sg.accepted ? "keep" : "drop"}`}
            style={{ pointerEvents: "all" }}
            onClick={(e) => {
              e.stopPropagation();
              useTrace.getState().set({ suggestions: { ...suggestions, items: suggestions.items.map((i) => (i.id === sg.id ? { ...i, accepted: !i.accepted } : i)) } });
            }}
          />
        ))}
        {/* Holes of the selected area. */}
        {selected && venue && regionHoles(selected, venue).map((h, i) => <path key={`hole${i}`} d={pathD(h)} className="hole-outline" />)}
        {/* The selected area's body: drag to move the whole area. */}
        {!drawing && selected && selected.path.closed && (
          <path
            d={pathD(selected.path)}
            className="area-body"
            style={{ pointerEvents: "all" }}
            aria-label={`Move ${selected.name}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              capture(e);
              drag.current = { kind: "area", regionId: selected.id, from: toCanvas(e), base: { path: selected.path, ...(selected.holes ? { holes: selected.holes } : {}) }, key: `move-${selected.id}-${Date.now()}` };
              useTrace.getState().set({ vertex: null });
              redraw((n) => n + 1);
            }}
          />
        )}
        {/* Shape being drawn. */}
        {rectStart.current && cursor && <path d={pathD(rectPath(rectStart.current, cursor))} className="draft" />}
        {draft.length > 0 && <path d={pathD({ closed: false, vertices: [...draft, ...(cursor ? [cursor] : [])].map((p) => ({ p })) })} className={`draft ${tool === "hole" ? "hole-draft" : ""}`} />}
        {draft.map((p, i) => (
          <circle key={i} cx={p[0]} cy={p[1]} r={4 * px} className="draft-point" />
        ))}
        {pending && <path d={pathD(pending.path)} className="draft pending" />}
        {/* Edge handles: drag to move the edge, click to add a point. */}
        {!drawing &&
          selected?.path.vertices.map((v, i) => {
            const n = selected.path.vertices.length;
            if (!selected.path.closed && i === n - 1) return null;
            const b = selected.path.vertices[(i + 1) % n]!;
            const m: Vec2 = [(v.p[0] + b.p[0]) / 2, (v.p[1] + b.p[1]) / 2];
            return (
              <g
                key={`e${i}`}
                className="edge-handle"
                transform={`translate(${m[0]},${m[1]})`}
                style={{ pointerEvents: "all" }}
                role="button"
                aria-label={`Edge ${i + 1}: drag to move, click to add a point`}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  capture(e);
                  drag.current = { kind: "edge", regionId: selected.id, index: i, from: toCanvas(e), base: selected.path, moved: false, key: `edge-${selected.id}-${i}-${Date.now()}` };
                  redraw((n) => n + 1);
                }}
              >
                <circle r={6 * px} />
                <path d={`M${-3 * px},0 H${3 * px} M0,${-3 * px} V${3 * px}`} />
              </g>
            );
          })}
        {/* Corner handles: drag to move, click to select (Delete removes), Alt-click removes. */}
        {!drawing &&
          selected?.path.vertices.map((v, i) => (
            <rect
              key={i}
              x={v.p[0] - 6 * px}
              y={v.p[1] - 6 * px}
              width={12 * px}
              height={12 * px}
              className={`vertex-handle ${vertex?.regionId === selected.id && vertex.index === i ? "chosen" : ""}`}
              style={{ pointerEvents: "all" }}
              role="button"
              aria-label={`Corner ${i + 1}`}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (e.altKey) {
                  removePoint(selected, i);
                  useTrace.getState().set({ vertex: null });
                  return;
                }
                capture(e);
                drag.current = { kind: "vertex", regionId: selected.id, index: i };
                useTrace.getState().set({ vertex: { regionId: selected.id, index: i } });
                redraw((n) => n + 1);
              }}
            />
          ))}
      </svg>
      {pending && <KindChooser at={pending.at} scale={1 / px} />}
    </>
  );
};

/** "What is this?" — names the shape just drawn. */
const KindChooser = ({ at, scale }: { at: Vec2; scale: number }) => {
  const pending = useTrace((s) => s.pending)!;
  const options = KIND_CHOICES.filter((k) => (pending.path.closed ? !k.open : k.open || k.kind === "edge"));
  return (
    <div className="kind-chooser" style={{ left: Math.max(4, at[0] * scale - 140), top: at[1] * scale + 12 }} role="dialog" aria-label="What is this area?" onClick={(e) => e.stopPropagation()}>
      <strong>What is this?</strong>
      <div className="kind-options">
        {options.map((k) => (
          <button
            key={k.kind}
            className="chip"
            onClick={() => {
              addRegion(pending.path, k.kind);
              useTrace.getState().set({ pending: null });
            }}
          >
            {k.label}
          </button>
        ))}
      </div>
      <button className="link" onClick={() => useTrace.getState().set({ pending: null })}>
        Cancel
      </button>
    </div>
  );
};

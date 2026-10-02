/**
 * Interactive overlays drawn above the preview (never rendered into exports):
 *   - region outlines and selection (click to select, shift-click to add), with the outcome action bar
 *   - safe-area guides
 *   - projector alignment points (projector view)
 */
import type { PathData, Region } from "@be/core";
import { useMemo, useRef, useState } from "react";
import { applyEffect, applyRecipeToSelection, KIND_LABEL, previewRecipe, similarRegions, suggestedRecipes } from "../studio/actions.ts";
import { activeVenue, useStudio } from "../studio/store.ts";
import { usePreview } from "./settings.ts";

export const pathD = (p: PathData): string => {
  const v = p.vertices;
  if (v.length === 0) return "";
  let d = `M${v[0]!.p[0]},${v[0]!.p[1]}`;
  const n = v.length;
  const count = p.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = v[i]!;
    const b = v[(i + 1) % n]!;
    const ao = a.out ?? [0, 0];
    const bi = b.in ?? [0, 0];
    d += ao[0] || ao[1] || bi[0] || bi[1] ? ` C${a.p[0] + ao[0]},${a.p[1] + ao[1]} ${b.p[0] + bi[0]},${b.p[1] + bi[1]} ${b.p[0]},${b.p[1]}` : ` L${b.p[0]},${b.p[1]}`;
  }
  return p.closed ? `${d} Z` : d;
};

const KIND_ORDER: Record<Region["kind"], number> = { wall: 0, roof: 0, exclusion: 1, column: 2, window: 3, door: 3, garage: 3, vent: 4, light: 4, custom: 4, edge: 5, roofline: 5 };

/** Region outlines + selection for the Show view. `interactive` is false in follower windows. */
export const RegionOverlay = ({ size, interactive }: { size: { w: number; h: number }; interactive: boolean }) => {
  const project = useStudio((s) => s.project);
  const selection = useStudio((s) => s.selection);
  const hover = useStudio((s) => s.hoverRegionId);
  const step = useStudio((s) => s.step);
  const overlays = usePreview((s) => s.overlays);
  const venue = project ? activeVenue({ project }) : undefined;
  const regions = useMemo(
    () => (venue ? venue.regionOrder.map((id) => venue.regions[id]!).filter(Boolean).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]) : []),
    [venue],
  );
  if (!venue) return null;
  const W = venue.canvas.width;
  const H = venue.canvas.height;
  return (
    <svg className="overlay" viewBox={`0 0 ${W} ${H}`} width={size.w} height={size.h} role="group" aria-label="Parts of the building" style={{ pointerEvents: interactive ? undefined : "none" }}>
      {overlays.guides && (
        <g className="guides" aria-hidden="true">
          <rect x={W * 0.05} y={H * 0.05} width={W * 0.9} height={H * 0.9} />
          <line x1={W / 2 - 30} y1={H / 2} x2={W / 2 + 30} y2={H / 2} />
          <line x1={W / 2} y1={H / 2 - 30} x2={W / 2} y2={H / 2 + 30} />
        </g>
      )}
      {regions.map((r) => {
        const sel = overlays.selection && selection.regionIds.includes(r.id);
        const hov = hover === r.id;
        const edge = !r.path.closed;
        const showOutline = overlays.outlines && (sel || hov || step === "space" || !!r.proposal);
        return (
          <path
            key={r.id}
            d={pathD(r.path)}
            className={`region ${edge ? "edge" : "area"} kind-${r.kind} ${sel ? "selected" : ""} ${hov && overlays.outlines ? "hover" : ""} ${showOutline ? "outlined" : ""} ${r.proposal ? "proposed" : ""} ${r.proposal?.uncertain ? "uncertain" : ""}`}
            onPointerEnter={() => interactive && useStudio.getState().setHover(r.id)}
            onPointerLeave={() => interactive && useStudio.getState().setHover(null)}
            onClick={(e) => {
              if (!interactive) return;
              e.stopPropagation();
              useStudio.getState().selectRegions([r.id], e.shiftKey || e.ctrlKey || e.metaKey);
            }}
            tabIndex={interactive ? 0 : -1}
            role="button"
            aria-pressed={sel}
            aria-label={`${r.name}${r.proposal ? (r.proposal.uncertain ? ", found automatically, check it" : ", found automatically") : ""}${sel ? ", selected" : ""}`}
            onKeyDown={(e) => {
              if (interactive && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                useStudio.getState().selectRegions([r.id], e.shiftKey);
              }
            }}
          />
        );
      })}
      {overlays.outlines && <ProposalLabels regions={regions} scale={W / size.w} />}
      {hover && venue.regions[hover] && overlays.outlines && <HoverLabel region={venue.regions[hover]!} scale={W / size.w} />}
    </svg>
  );
};

/** Names on areas found automatically (with "?" on the ones to check), until they're accepted. */
const ProposalLabels = ({ regions, scale }: { regions: readonly Region[]; scale: number }) => (
  <g aria-hidden="true">
    {regions
      .filter((r) => r.proposal)
      .map((r) => {
        const b = r.path.vertices.reduce((m, v) => ({ x: Math.min(m.x, v.p[0]), y: Math.min(m.y, v.p[1]) }), { x: Infinity, y: Infinity });
        return (
          <text key={r.id} x={b.x + 4 * scale} y={b.y + 15 * scale} className={`proposal-label ${r.proposal!.uncertain ? "uncertain" : ""}`} style={{ fontSize: 12 * scale }}>
            {r.name}
            {r.proposal!.uncertain ? " ?" : ""}
          </text>
        );
      })}
  </g>
);

const HoverLabel = ({ region, scale }: { region: Region; scale: number }) => {
  const b = region.path.vertices.reduce((m, v) => ({ x: Math.min(m.x, v.p[0]), y: Math.min(m.y, v.p[1]) }), { x: Infinity, y: Infinity });
  return (
    <text x={b.x} y={b.y - 10 * scale} className="hover-label" style={{ fontSize: 13 * scale }}>
      {region.name}
    </text>
  );
};

/** Outcome-first action bar next to the selection: suited effects, “select all similar”, more. */
export const ActionBar = ({ size }: { size: { w: number; h: number } }) => {
  const project = useStudio((s) => s.project)!;
  const selection = useStudio((s) => s.selection);
  const venue = activeVenue({ project });
  if (!venue || selection.recipeId) return null;
  const s = size.w / venue.canvas.width;
  const regs = selection.regionIds.map((id) => venue.regions[id]).filter((r): r is Region => !!r);
  if (regs.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  for (const r of regs)
    for (const v of r.path.vertices) {
      x0 = Math.min(x0, v.p[0]);
      y0 = Math.min(y0, v.p[1]);
      x1 = Math.max(x1, v.p[0]);
    }
  const suggestions = suggestedRecipes(project, selection.regionIds).slice(0, 4);
  const similar = regs.length === 1 ? similarRegions(project, regs[0]!.id) : [];
  const kind = regs[0]!.kind;
  const sameKind = regs.every((r) => r.kind === kind);
  const label = regs.length === 1 ? regs[0]!.name : sameKind ? `${regs.length} ${KIND_LABEL[kind][1]}` : `${regs.length} parts`;
  const top = Math.max(110, y0 * s - 10);
  const left = Math.min(Math.max(4, ((x0 + x1) / 2) * s - 260), Math.max(4, size.w - 524));
  return (
    <div className="action-bar" style={{ top, left }} onClick={(e) => e.stopPropagation()} role="toolbar" aria-label={`Effects for ${label}`}>
      <span className="action-bar-label">{label}</span>
      {suggestions.map((r) => (
        <button
          key={r.id}
          className="action"
          onClick={() => void applyEffect(r.id)}
          onPointerEnter={() => previewRecipe(r.id)}
          onPointerLeave={() => previewRecipe(null)}
          onFocus={() => previewRecipe(r.id)}
          onBlur={() => previewRecipe(null)}
          title={r.description}
        >
          {r.title}
        </button>
      ))}
      {similar.length > 1 && (
        <button className="chip" onClick={() => useStudio.getState().selectRegions(similar)}>
          Select all {similar.length} {KIND_LABEL[kind][1]}
        </button>
      )}
      <button className="action ghost" onClick={() => document.getElementById("library-search")?.focus()}>
        More…
      </button>
    </div>
  );
};

/** Projector view: numbered alignment points the person drags onto the matching physical corners. */
export const CalibrationOverlay = ({ size }: { size: { w: number; h: number } }) => {
  const project = useStudio((s) => s.project)!;
  const venue = activeVenue({ project });
  const projector = venue?.projectorOrder[0] ? venue.projectors[venue.projectorOrder[0]] : undefined;
  const [drag, setDrag] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  if (!venue || !projector) return null;
  const cal = projector.calibration;
  const s = size.w / projector.output.width;
  const toOutput = (e: React.PointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    const k = projector.output.width / r.width;
    return [Math.round((e.clientX - r.left) * k), Math.round((e.clientY - r.top) * k)];
  };
  return (
    <svg
      ref={svgRef}
      className="overlay calibration"
      viewBox={`0 0 ${projector.output.width} ${projector.output.height}`}
      width={size.w}
      height={size.h}
      onPointerMove={(e) => {
        if (!drag) return;
        useStudio.getState().apply(
          { type: "calibration.movePoint", args: { venueId: venue.id, projectorId: projector.id, pointId: drag, output: toOutput(e) } },
          { label: "Move alignment point", coalesceKey: `cal-${drag}`, quiet: true },
        );
      }}
      onPointerUp={() => setDrag(null)}
      onPointerLeave={() => setDrag(null)}
      onClick={(e) => e.stopPropagation()}
    >
      <polygon className="cal-quad" points={cal.points.map((p) => p.output.join(",")).join(" ")} />
      {cal.points.map((p) => (
        <g
          key={p.id}
          className={`cal-point ${cal.locked ? "locked" : ""} ${drag === p.id ? "dragging" : ""}`}
          transform={`translate(${p.output[0]},${p.output[1]})`}
          onPointerDown={(e) => {
            if (cal.locked) {
              useStudio.getState().toast({ kind: "info", text: "The alignment is locked. Unlock it on the right to move points." });
              return;
            }
            (e.target as Element).setPointerCapture?.(e.pointerId);
            setDrag(p.id);
          }}
          role="button"
          aria-label={`Alignment point ${p.label}`}
        >
          <circle r={17 / s} />
          <text dy={6 / s} style={{ fontSize: 16 / s }}>
            {p.label}
          </text>
        </g>
      ))}
    </svg>
  );
};

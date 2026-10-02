/**
 * Left panel for the "Areas" step: drawing tools, the building areas (by group and kind) and the
 * projector. Areas are shared by every scene — tracing a window once makes it available
 * throughout the show.
 */
import { PhotoPlacementPanel } from "./PhotoPlacementPanel.tsx";
import { type RegionKind } from "@be/core";
import { useState } from "react";
import { usePreview } from "../preview/settings.ts";
import { KIND_LABEL } from "../studio/actions.ts";
import { activeVenue, useStudio } from "../studio/store.ts";
import { acceptSuggestions, suggestSimilar } from "./actions.ts";
import { duplicateAreas, groupAreas, renameGroup, ungroup } from "./areaEdit.ts";
import { type TraceTool, useTrace } from "./traceStore.ts";

const KIND_ORDER: RegionKind[] = ["roofline", "roof", "edge", "window", "door", "garage", "column", "vent", "light", "wall", "custom", "exclusion"];

const TOOLS: Array<{ id: TraceTool; label: string; how: string }> = [
  { id: "select", label: "Select", how: "Click an area. Drag a corner or a + edge handle to reshape it (click + to add a point), drag inside to move it. Alt-click a corner, or select it and press Delete, to remove it. Ctrl+D duplicates." },
  { id: "rect", label: "Rectangle", how: "Drag a box around a window, door or panel." },
  { id: "polygon", label: "Outline", how: "Click each corner. Click the first point (or double-click, or press Enter) to finish." },
  { id: "edge", label: "Edge", how: "Click along a roofline or edge. Double-click or press Enter to finish." },
  { id: "hole", label: "Cut a hole", how: "Select an area first, then outline the hole to cut out of it (e.g. a window inside a wall)." },
];

/** Click to select (Shift adds); double-click the name to rename it. */
const AreaRow = ({ id }: { id: string }) => {
  const project = useStudio((s) => s.project)!;
  const sel = useStudio((s) => s.selection.regionIds);
  const venue = activeVenue({ project })!;
  const r = venue.regions[id]!;
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <input
        className="text-input area-rename"
        autoFocus
        defaultValue={r.name}
        aria-label={`Rename ${r.name}`}
        onBlur={(e) => {
          setEditing(false);
          const name = e.target.value.trim();
          if (name && name !== r.name) useStudio.getState().apply({ type: "region.update", args: { venueId: venue.id, regionId: id, changes: { name } } }, { label: "Rename area" });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  return (
    <button className={`list-item ${sel.includes(id) ? "on" : ""}`} onClick={(e) => useStudio.getState().selectRegions([id], e.shiftKey || e.ctrlKey)} onDoubleClick={() => setEditing(true)} title="Double-click to rename">
      {r.name}
      {r.holes?.length ? <span className="muted small"> · {r.holes.length} hole{r.holes.length > 1 ? "s" : ""}</span> : null}
    </button>
  );
};

const GroupBox = () => {
  const project = useStudio((s) => s.project)!;
  const sel = useStudio((s) => s.selection.regionIds);
  const venue = activeVenue({ project })!;
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const groups = Object.values(venue.groups);
  return (
    <section className="lib-group">
      <h3>Groups</h3>
      {groups.length === 0 && <p className="muted small">Name a set of areas, e.g. “Upstairs windows”, to use them together.</p>}
      {groups.map((g) => (
        <div key={g.id} className="group-row">
          {renaming === g.id ? (
            <input
              className="text-input grow"
              autoFocus
              defaultValue={g.name}
              aria-label={`Rename ${g.name}`}
              onBlur={(e) => {
                setRenaming(null);
                if (e.target.value.trim() && e.target.value.trim() !== g.name) renameGroup(g.id, e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setRenaming(null);
              }}
            />
          ) : (
            <button className="list-item grow" onClick={() => useStudio.getState().selectRegions(g.regionIds.filter((id) => venue.regions[id]))} onDoubleClick={() => setRenaming(g.id)} title="Click to select, double-click to rename">
              {g.name} <span className="muted small">· {g.regionIds.filter((id) => venue.regions[id]).length}</span>
            </button>
          )}
          <button className="icon small" title="Rename" aria-label={`Rename ${g.name}`} onClick={() => setRenaming(g.id)}>
            ✎
          </button>
          <button className="icon small" title="Ungroup (the areas stay)" aria-label={`Ungroup ${g.name}`} onClick={() => ungroup(g.id)}>
            ✕
          </button>
        </div>
      ))}
      {sel.length > 0 && (
        <form
          className="row gap"
          onSubmit={(e) => {
            e.preventDefault();
            if (groupAreas(sel, name || "Group")) setName("");
          }}
        >
          <input className="text-input grow" value={name} placeholder={`Name the ${sel.length} selected…`} onChange={(e) => setName(e.target.value)} aria-label="Group name" />
          <button className="ghost" type="submit">
            Group
          </button>
        </form>
      )}
    </section>
  );
};

export const SpacePanel = () => {
  const project = useStudio((s) => s.project)!;
  const sel = useStudio((s) => s.selection.regionIds);
  const { tool, photoOpacity, suggestions } = useTrace();
  const venue = activeVenue({ project });
  if (!venue) return <aside className="panel">No building set up yet.</aside>;
  const byKind = KIND_ORDER.map((k) => [k, venue.regionOrder.filter((id) => venue.regions[id]?.kind === k)] as const).filter(([, ids]) => ids.length > 0);
  const howTo = TOOLS.find((t) => t.id === tool)!.how;
  const selectedOne = sel.length === 1 ? venue.regions[sel[0]!] : undefined;

  return (
    <aside className="panel" aria-label="Building areas">
      <div className="panel-head">
        <h2>{venue.name}</h2>
      </div>
      <p className="muted small">Trace the areas of the building once — windows, doors, walls. Every scene can use them. The photo is a guide for drawing, not a 3D measurement.</p>
      <div className="segmented tools" role="radiogroup" aria-label="Drawing tool">
        {TOOLS.map((t) => (
          <button key={t.id} role="radio" aria-checked={tool === t.id} className={tool === t.id ? "on" : ""} onClick={() => useTrace.getState().set({ tool: t.id, draft: [], pending: null })}>
            {t.label}
          </button>
        ))}
      </div>
      <p className="howto small">{howTo} Hold Shift for straight lines; points snap to nearby corners. Ctrl+wheel zooms the picture.</p>
      {usePreview.getState().view !== "show" && (
        <button className="link small" onClick={() => usePreview.getState().set({ view: "show" })}>
          Switch to Show preview to trace
        </button>
      )}
      <label className="row-field">
        <span>Photo</span>
        <input type="range" min={0} max={1} step={0.05} value={photoOpacity} onChange={(e) => useTrace.getState().set({ photoOpacity: Number(e.target.value) })} aria-label="Photo visibility" />
      </label>
      <PhotoPlacementPanel />

      {suggestions && (
        <div className="suggest-box" role="region" aria-label="Suggested areas">
          <strong>
            Found {suggestions.items.length} similar {suggestions.baseName.toLowerCase()}
            {suggestions.items.length === 1 ? "" : "s"}
          </strong>
          <p className="muted small">Dashed outlines are suggestions. Click one to drop or keep it.</p>
          <div className="row gap">
            <button className="primary" onClick={acceptSuggestions} disabled={!suggestions.items.some((i) => i.accepted)}>
              Add {suggestions.items.filter((i) => i.accepted).length}
            </button>
            <button className="ghost" onClick={() => useTrace.getState().set({ suggestions: null })}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      <div className="row gap wrap">
        {selectedOne && (selectedOne.kind === "window" || selectedOne.kind === "door" || selectedOne.kind === "garage" || selectedOne.kind === "column" || selectedOne.kind === "vent" || selectedOne.kind === "light") && !suggestions && (
          <button className="ghost" onClick={() => void suggestSimilar(selectedOne.id)}>
            Find similar {KIND_LABEL[selectedOne.kind][1]}
          </button>
        )}
        {sel.length > 0 && (
          <button className="ghost" onClick={() => duplicateAreas(sel)} title="Ctrl+D">
            Duplicate {sel.length > 1 ? `${sel.length} areas` : "area"}
          </button>
        )}
      </div>

      {byKind.length === 0 && <p className="empty small">No areas yet. Pick Rectangle and drag around a window to begin.</p>}
      {byKind.length > 0 && <GroupBox />}
      {byKind.map(([k, ids]) => (
        <section key={k} className="lib-group">
          <h3>
            {ids.length} {KIND_LABEL[k][ids.length === 1 ? 0 : 1]}
          </h3>
          {ids.length > 1 && (
            <button className="chip" onClick={() => useStudio.getState().selectRegions(ids)}>
              Select all {KIND_LABEL[k][1]}
            </button>
          )}
          {ids.map((id) => (
            <AreaRow key={id} id={id} />
          ))}
        </section>
      ))}
      <section className="lib-group">
        <h3>Projector</h3>
        {venue.projectorOrder.map((pid) => {
          const p = venue.projectors[pid]!;
          return (
            <button key={pid} className="list-item" onClick={() => usePreview.getState().set({ view: "projector" })}>
              {p.name} · {p.output.width}×{p.output.height} · {p.calibration.locked ? "aligned & locked" : "line it up →"}
            </button>
          );
        })}
        <p className="muted small">Lining up the projector never moves your content, and placing content never changes the alignment.</p>
      </section>
    </aside>
  );
};

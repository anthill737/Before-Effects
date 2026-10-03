/**
 * "Content": put pictures, videos and animations into the building areas of the current scene.
 * Drag a card onto an area — in the picture or in the list below — and it appears there at once,
 * clipped to the area. The areas are shared by every scene; what you put in them belongs to this
 * scene only.
 */
import { type Asset, getRecipe, newId } from "@be/core";
import { useState } from "react";
import { applyEffect, applyRecipeToSelection } from "./actions.ts";
import { contentForArea, dropOnArea, isContentDrag, readDragPayload, setDragPayload } from "./assign.ts";
import { addParticles, BLOCK_EFFECTS, BREAK_EFFECTS, effect3dFor, makeArea3D, PARTICLE_EFFECTS } from "./actions3d.ts";
import { MELT_EFFECT, meltAreas } from "./melt.ts";
import { addAssetLayer, importMediaFiles } from "./media.ts";
import { findMissingInFolder, findOne } from "./relink.ts";
import { activeVenue, currentComp, useStudio } from "./store.ts";
import { useThumb } from "./thumbs.ts";

const KIND_ICON: Record<string, string> = { image: "🖼", video: "🎞", audio: "♪", font: "A", model: "⬚", lut: "◐" };

/** Which effects simulate something, and how: real physics, or a look made procedurally. */
const SIM_KIND: Record<string, string> = {
  "collapse-3d": "physical: rigid pieces simulated with Rapier",
  "explode-3d": "physical: rigid pieces simulated with Rapier",
  "crumble-3d": "physical: rigid pieces simulated with Rapier",
  "shatter-3d": "physical: glass shards simulated with Rapier",
  "blocks-pulse": "procedural: blocks moved by rule (a pattern in time), not simulated",
  "blocks-ripple": "procedural: blocks moved by rule (rings from a point), not simulated",
  "blocks-wave": "procedural: blocks moved by rule (a wave across), not simulated",
  "blocks-columns": "procedural: columns moved by rule (a wave across), not simulated",
  "blocks-slats": "procedural: slats turned by rule (a wave across), not simulated",
  "melt-area": "procedural: the picture is warped downward by rule, not simulated",
  "particles-sparks": "procedural: particles placed by rule (drag, gravity, wind), not simulated — they don't hit the house",
  "particles-embers": "procedural: particles placed by rule (rise, sway, flicker), not simulated",
  "particles-snow": "procedural: flakes placed by rule (fall, sway, wind), not simulated — they don't settle",
  "particles-confetti": "procedural: particles placed by rule (air drag, gravity, flutter), not simulated",
  "smoke-rising": "procedural: a smoke look, not a fluid simulation — for real smoke use Smoke (Blender) on an area",
  "water-fill": "procedural: a water look, not a fluid simulation — for real water use Water pouring (Blender)",
  "crack-rebuild": "procedural: drawn cracks — for real breaking use Collapse & rebuild (3D)",
};

const ANIMATIONS = ["edge-trace", "sequence-light-up", "pulse", "neon-outline", "color-wash", "move-with-beat", "smoke-rising", "water-fill", "crack-rebuild", "text-on-surface"];

const fmt = (a: Asset) => {
  const parts: string[] = [];
  if (a.meta.width && a.meta.height) parts.push(`${a.meta.width}×${a.meta.height}`);
  if (a.meta.duration) parts.push(`${(a.meta.duration / 705_600_000).toFixed(1)} s`);
  if (a.analysis) parts.push(`${Math.round(a.analysis.bpm)} BPM`);
  return parts.join(" · ");
};

/** The file's picture once it's made; the kind's symbol until then (and for sound). */
const MediaThumb = ({ a }: { a: Asset }) => {
  const url = useThumb(a);
  return url ? (
    <img className="media-thumb" src={url} alt={`${a.name} thumbnail`} draggable={false} />
  ) : (
    <span className="media-icon" aria-hidden="true">
      {KIND_ICON[a.kind] ?? "•"}
    </span>
  );
};

/** An area as a drop target, with what this scene puts in it. */
const AreaDropRow = ({ id }: { id: string }) => {
  const project = useStudio((s) => s.project)!;
  const sel = useStudio((s) => s.selection);
  useStudio((s) => s.version);
  const venue = activeVenue({ project })!;
  const r = venue.regions[id]!;
  const [over, setOver] = useState(false);
  const items = contentForArea(id);
  return (
    <div
      className={`area-drop ${over ? "over" : ""} ${sel.regionIds.includes(id) ? "on" : ""}`}
      onDragOver={(e) => {
        if (!isContentDrag(e.dataTransfer)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const p = readDragPayload(e.dataTransfer);
        if (!p) return;
        e.preventDefault();
        void dropOnArea(p, id, { x: e.clientX, y: e.clientY });
      }}
    >
      <button className="list-item area-name" onClick={(e) => useStudio.getState().selectRegions([id], e.shiftKey || e.ctrlKey)} aria-label={`${r.name}: ${items.length} item${items.length === 1 ? "" : "s"} in this scene`}>
        {r.name}
        <span className="muted small"> {items.length ? `· ${items.length}` : "· empty"}</span>
      </button>
      {items.length > 0 && (
        <div className="area-items">
          {items.map((inst) => (
            <button key={inst.id} className={`chip ${sel.recipeId === inst.id ? "on" : ""}`} onClick={() => useStudio.getState().selectRecipe(inst.id)} title="Select to adjust">
              {inst.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const ContentPanel = () => {
  const project = useStudio((s) => s.project)!;
  const sel = useStudio((s) => s.selection);
  const comp = currentComp(useStudio.getState());
  if (!comp) return null;
  const venue = activeVenue({ project });
  // The building photo and its placed copy are the tracing guide, not content.
  const assets = Object.values(project.assets).filter((a) => a.id !== venue?.referenceAssetId && a.id !== venue?.photo?.assetId && a.purpose !== "venue-reference");
  const areas = venue ? venue.regionOrder.filter((id) => venue.regions[id]?.path.closed && venue.regions[id]?.kind !== "exclusion") : [];
  const groups = venue ? Object.values(venue.groups) : [];

  const addText = () => {
    if (sel.regionIds.length) {
      void applyEffect("text-on-surface");
      return;
    }
    const id = newId("layer");
    useStudio.getState().apply(
      {
        type: "layer.add",
        args: {
          compId: comp.id,
          layer: {
            id,
            name: "Text",
            source: { kind: "text", doc: { text: "Your text", font: "Segoe UI", weight: 700, size: { value: Math.round(comp.height / 8) }, color: { value: [1, 1, 1, 1] }, align: "center", lineHeight: 1.15, tracking: 0 } },
            startTime: useStudio.getState().time,
            inPoint: useStudio.getState().time,
            outPoint: Math.min(comp.duration, useStudio.getState().time + 705_600_000 * 8),
            stretch: 1,
            enabled: true,
            solo: false,
            locked: false,
            audioEnabled: false,
            is3D: false,
            blendMode: "normal",
            transform: { anchor: { value: [0, 0, 0] }, position: { value: [comp.width / 2, comp.height / 2, 0], spatial: true }, scale: { value: [100, 100, 100] }, rotation: { value: [0, 0, 0] }, opacity: { value: 100 } },
            masks: [],
            effects: [],
          },
        },
      },
      { label: "Add text" },
    );
    useStudio.getState().selectLayer(id);
  };

  return (
    <aside className="panel content-panel" aria-label="Content">
      <div className="panel-head">
        <h2>Content</h2>
        <span className="muted small">in “{comp.name}”</span>
      </div>
      <p className="muted small">Drag a picture, video or animation onto an area — in the picture or in the list below. The areas are shared by every scene; what you put in them belongs to this scene.</p>

      <h3 className="subhead">Your media</h3>
      <div className="row gap wrap">
        <button className="primary" onClick={() => void importMediaFiles()}>
          Import pictures, video or music…
        </button>
        <button className="ghost" onClick={addText}>
          {sel.regionIds.length ? "Add text to the selection" : "Add text"}
        </button>
      </div>
      {assets.some((a) => a.missing) && (
        <div className="missing-box">
          <span className="small">
            {assets.filter((a) => a.missing).length} file{assets.filter((a) => a.missing).length > 1 ? "s are" : " is"} missing (moved, renamed or on another computer).
          </span>
          <button className="ghost small-btn" onClick={() => void findMissingInFolder()}>
            Find missing files…
          </button>
        </div>
      )}
      {assets.length === 0 && <p className="empty small">Nothing imported yet.</p>}
      <div className="media-list">
        {assets.map((a) => (
          <div
            key={a.id}
            className={`media-item ${a.kind !== "audio" ? "draggable" : ""}`}
            draggable={a.kind !== "audio" && !a.missing}
            onDragStart={(e) => setDragPayload(e, { kind: "asset", id: a.id })}
            title={a.kind !== "audio" ? "Drag onto an area" : undefined}
          >
            <MediaThumb a={a} />
            <span className="media-text">
              <strong>{a.name}</strong>
              <span className={a.missing ? "warn small" : "muted small"}>{a.missing ? "Missing — not found on this computer" : fmt(a)}</span>
            </span>
            <span className="media-actions">
              {a.missing && (
                <button className="chip" onClick={() => void findOne(a)}>
                  Find…
                </button>
              )}
              {(a.kind === "image" || a.kind === "video") && sel.regionIds.length > 0 && !a.missing && (
                <button className="chip" onClick={() => void dropOnArea({ kind: "asset", id: a.id }, sel.regionIds[0]!, { x: 320, y: 260 })}>
                  Put in selection
                </button>
              )}
              {a.kind === "audio" && (
                <button className="chip" onClick={() => addAssetLayer(a)}>
                  Add to the show
                </button>
              )}
            </span>
          </div>
        ))}
      </div>

      <h3 className="subhead">Animations</h3>
      <div className="anim-cards">
        {[...ANIMATIONS.map((id) => getRecipe(id)).filter((r): r is NonNullable<typeof r> => !!r), ...BREAK_EFFECTS, ...BLOCK_EFFECTS, ...PARTICLE_EFFECTS, MELT_EFFECT]
          .map((r) => (
            <div
              key={r.id}
              className="chip anim-card"
              draggable
              onDragStart={(e) => setDragPayload(e, { kind: "effect", id: r.id })}
              onClick={() => {
                const e3 = effect3dFor(r.id);
                // Snow can fall over the whole picture; everything else starts from areas.
                if (e3 && "particles" in e3 && e3.particles === "snow") return void addParticles("snow", sel.regionIds);
                if (!sel.regionIds.length) return useStudio.getState().toast({ kind: "info", text: `Drag “${r.title}” onto an area, or select areas and click it.` });
                if (r.id === MELT_EFFECT.id) return void meltAreas(sel.regionIds);
                if (!e3) return void applyEffect(r.id);
                return "break" in e3 ? void makeArea3D(sel.regionIds, true, e3.break) : "blocks" in e3 ? void makeArea3D(sel.regionIds, false, "collapse", e3.blocks) : void addParticles(e3.particles, sel.regionIds);
              }}
              title={`${r.description}${SIM_KIND[r.id] ? ` (${SIM_KIND[r.id]})` : ""}`}
              role="button"
              tabIndex={0}
            >
              {r.title}
              {SIM_KIND[r.id] && <span className="badge">{SIM_KIND[r.id]!.startsWith("physical") ? "physical" : "procedural"}</span>}
            </div>
          ))}
      </div>

      <h3 className="subhead">Areas in this scene</h3>
      {!areas.length && <p className="empty small">No areas yet. Trace some in step 1 (Areas).</p>}
      {groups.length > 0 && (
        <div className="row gap wrap">
          {groups.map((g) => (
            <button key={g.id} className="chip" onClick={() => useStudio.getState().selectRegions(g.regionIds.filter((id) => venue?.regions[id]))} title="Select this group">
              {g.name} · {g.regionIds.filter((id) => venue?.regions[id]).length}
            </button>
          ))}
        </div>
      )}
      <div className="area-list">
        {areas.map((id) => (
          <AreaDropRow key={id} id={id} />
        ))}
      </div>
      {sel.regionIds.length > 1 && <p className="muted small">With {sel.regionIds.length} areas selected, dropping onto one of them asks whether to repeat the content in each area or span it across them.</p>}

      <h3 className="subhead">Layers in this scene</h3>
      <p className="muted small">Top layer first. Everything you add appears here as ordinary, editable layers.</p>
      {comp.layerOrder.map((id) => {
        const l = comp.layers[id]!;
        const rid = l.generatedBy?.recipeInstanceId;
        return (
          <div key={id} className="layer-row">
            <button
              className="icon small"
              aria-label={l.enabled ? `Hide ${l.name}` : `Show ${l.name}`}
              title={l.enabled ? "Hide" : "Show"}
              onClick={() => useStudio.getState().apply({ type: "layer.update", args: { compId: comp.id, layerId: id, changes: { enabled: !l.enabled } } }, { label: l.enabled ? "Hide layer" : "Show layer" })}
            >
              {l.enabled ? "◉" : "○"}
            </button>
            <button className={`list-item grow ${sel.layerId === id ? "on" : ""}`} onClick={() => (rid ? useStudio.getState().selectRecipe(rid) : useStudio.getState().selectLayer(id))}>
              {l.name}
              {rid && <span className="muted small"> · from “{project.recipes[rid]?.label}”</span>}
            </button>
          </div>
        );
      })}
    </aside>
  );
};

// Keep the click-to-apply helper available for keyboard users of the cards.
void applyRecipeToSelection;

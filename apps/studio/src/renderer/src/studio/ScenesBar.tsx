/**
 * Scenes and the show. Every scene uses the same building areas; each has its own content.
 *   Tabs        switch scene · double-click to rename · ✕ deletes (click twice)
 *   + Scene     a copy of the current scene (swap its content without retracing) or an empty one
 *   ▶ Show      the scenes in order with cuts or crossfades — what plays and exports as the show
 */
import { type Composition, newComposition, newId, sceneIds, type ShowEntry, timeToSeconds } from "@be/core";
import { useState } from "react";
import { useStudio } from "./store.ts";

const pickScene = (compId: string) => {
  const s = useStudio.getState();
  const c = s.project?.compositions[compId];
  if (!c) return;
  useStudio.setState({ compId, selection: { regionIds: [], recipeId: null, layerId: null }, time: Math.min(s.time, c.duration - 1) });
};

export const newSceneCopy = (): string | null => {
  const s = useStudio.getState();
  const cur = s.project && s.compId ? s.project.compositions[s.compId] : undefined;
  if (!s.project || !cur || cur.show) return null;
  const id = newId("comp");
  const n = sceneIds(s.project).length + 1;
  const tx = s.apply({ type: "scene.duplicate", args: { compId: cur.id, newCompId: id, name: `Scene ${n}` } }, { label: "Duplicate scene" });
  if (!tx) return null;
  pickScene(id);
  s.toast({ kind: "success", text: `“Scene ${n}” is a copy using the same areas. Swap its content — “${cur.name}” won't change.` });
  return id;
};

const newEmptyScene = (): string | null => {
  const s = useStudio.getState();
  const cur = s.project && s.compId ? s.project.compositions[s.compId] : undefined;
  if (!s.project || !cur) return null;
  const n = sceneIds(s.project).length + 1;
  const comp: Composition = { ...newComposition({ name: `Scene ${n}`, width: cur.width, height: cur.height, frameRate: cur.frameRate, durationSeconds: timeToSeconds(cur.show ? 20 * 705_600_000 : cur.duration), ...(cur.venueId ? { venueId: cur.venueId } : {}) }) };
  const tx = s.apply({ type: "comp.add", args: { comp } }, { label: "New scene" });
  if (!tx) return null;
  pickScene(comp.id);
  return comp.id;
};

export const showComp = (): Composition | undefined => {
  const p = useStudio.getState().project;
  return p ? p.compositionOrder.map((id) => p.compositions[id]!).find((c) => c?.show) : undefined;
};

/** Create (or open) the show: every scene in order, crossfading. */
export const openShow = () => {
  const s = useStudio.getState();
  if (!s.project) return;
  const existing = showComp();
  if (existing) return pickScene(existing.id);
  const entries: ShowEntry[] = sceneIds(s.project).map((id, i) => ({ sceneId: id, seconds: Math.max(1, Math.round(timeToSeconds(s.project!.compositions[id]!.duration))), transition: i === 0 ? "cut" : "fade", fadeSeconds: 1 }));
  const showId = newId("show");
  if (s.apply({ type: "show.set", args: { showId, name: "Show", entries, makeMain: true } }, { label: "Arrange the show" })) pickScene(showId);
};

export const ScenesBar = () => {
  const project = useStudio((s) => s.project);
  const compId = useStudio((s) => s.compId);
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  if (!project) return null;
  const scenes = sceneIds(project);
  const show = showComp();
  return (
    <div className="scenes-bar" role="tablist" aria-label="Scenes">
      {scenes.map((id) => {
        const c = project.compositions[id]!;
        return renaming === id ? (
          <input
            key={id}
            className="text-input scene-rename"
            autoFocus
            defaultValue={c.name}
            aria-label={`Rename ${c.name}`}
            onBlur={(e) => {
              setRenaming(null);
              const name = e.target.value.trim();
              if (name && name !== c.name) useStudio.getState().apply({ type: "comp.update", args: { compId: id, changes: { name } } }, { label: "Rename scene" });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(null);
            }}
          />
        ) : (
          <span key={id} className={`scene-tab ${compId === id ? "on" : ""}`}>
            <button role="tab" aria-selected={compId === id} onClick={() => pickScene(id)} onDoubleClick={() => setRenaming(id)} title="Double-click to rename">
              {c.name}
            </button>
            {scenes.length > 1 && (
              <button
                className={`scene-del ${confirm === id ? "confirm" : ""}`}
                aria-label={confirm === id ? `Click again to delete ${c.name}` : `Delete ${c.name}`}
                title={confirm === id ? "Click again to delete" : "Delete scene"}
                onClick={() => {
                  if (confirm !== id) {
                    setConfirm(id);
                    setTimeout(() => setConfirm((x) => (x === id ? null : x)), 2500);
                    return;
                  }
                  const next = scenes.find((x) => x !== id)!;
                  pickScene(next);
                  useStudio.getState().apply({ type: "comp.remove", args: { compId: id } }, { label: `Delete ${c.name}` });
                  setConfirm(null);
                }}
              >
                {confirm === id ? "Delete?" : "✕"}
              </button>
            )}
          </span>
        );
      })}
      <span className="tool-pop">
        <button className="ghost scene-add" onClick={() => setMenu(!menu)} aria-expanded={menu}>
          + Scene
        </button>
        {menu && (
          <div className="popover scene-menu" role="menu">
            <button
              role="menuitem"
              className="list-item"
              disabled={!!project.compositions[compId ?? ""]?.show}
              onClick={() => {
                setMenu(false);
                newSceneCopy();
              }}
            >
              Copy of “{project.compositions[compId ?? ""]?.name ?? "this scene"}” — same areas, swap the content
            </button>
            <button
              role="menuitem"
              className="list-item"
              onClick={() => {
                setMenu(false);
                newEmptyScene();
              }}
            >
              Empty scene — same areas, nothing in them yet
            </button>
          </div>
        )}
      </span>
      <button role="tab" aria-selected={!!show && compId === show.id} className={`scene-tab show-tab ${show && compId === show.id ? "on" : ""}`} onClick={openShow} title="Play the scenes in order, with cuts or crossfades">
        ▶ Show{show ? ` · ${show.show?.entries.length ?? 0} scenes` : ""}
      </button>
    </div>
  );
};

/** The show's running order: scenes as blocks with duration and how each one arrives. */
export const ShowArranger = ({ comp }: { comp: Composition }) => {
  const project = useStudio((s) => s.project)!;
  const plan = comp.show!;
  const scenes = sceneIds(project);
  const set = (entries: ShowEntry[], label: string) => useStudio.getState().apply({ type: "show.set", args: { showId: comp.id, entries } }, { label });
  const total = Math.max(1, timeToSeconds(comp.duration));
  return (
    <div className="show-arranger" aria-label="Show running order">
      <div className="show-blocks">
        {plan.entries.map((e, i) => {
          const sc = project.compositions[e.sceneId];
          return (
            <div key={i} className="show-block" style={{ flexGrow: e.seconds / total }}>
              <div className="row gap">
                <strong className="grow ellipsis">{sc?.name ?? "Missing scene"}</strong>
                <button className="icon small" disabled={i === 0} aria-label="Earlier" onClick={() => set(plan.entries.map((x, j) => (j === i - 1 ? plan.entries[i]! : j === i ? plan.entries[i - 1]! : x)), "Reorder the show")}>
                  ←
                </button>
                <button className="icon small" disabled={i === plan.entries.length - 1} aria-label="Later" onClick={() => set(plan.entries.map((x, j) => (j === i + 1 ? plan.entries[i]! : j === i ? plan.entries[i + 1]! : x)), "Reorder the show")}>
                  →
                </button>
                <button className="icon small" disabled={plan.entries.length === 1} aria-label={`Remove ${sc?.name} from the show`} onClick={() => set(plan.entries.filter((_, j) => j !== i), "Remove from the show")}>
                  ✕
                </button>
              </div>
              <label className="small">
                Plays for{" "}
                <input
                  className="text-input num"
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={e.seconds}
                  aria-label={`${sc?.name} duration in the show`}
                  onChange={(ev) => set(plan.entries.map((x, j) => (j === i ? { ...x, seconds: Math.max(0.5, Number(ev.target.value) || 0.5) } : x)), "Change scene length")}
                />{" "}
                s
              </label>
              {i > 0 && (
                <label className="small">
                  Arrives with{" "}
                  <select
                    value={e.transition}
                    aria-label={`${sc?.name} transition`}
                    onChange={(ev) => set(plan.entries.map((x, j) => (j === i ? { ...x, transition: ev.target.value as "cut" | "fade" } : x)), "Change transition")}
                  >
                    <option value="cut">a cut</option>
                    <option value="fade">a crossfade</option>
                  </select>
                  {e.transition === "fade" && (
                    <>
                      {" "}
                      <input
                        className="text-input num"
                        type="number"
                        min={0.1}
                        step={0.1}
                        value={e.fadeSeconds}
                        aria-label={`${sc?.name} crossfade seconds`}
                        onChange={(ev) => set(plan.entries.map((x, j) => (j === i ? { ...x, fadeSeconds: Math.max(0.1, Number(ev.target.value) || 0.1) } : x)), "Change crossfade")}
                      />{" "}
                      s
                    </>
                  )}
                </label>
              )}
            </div>
          );
        })}
      </div>
      <div className="row gap">
        <select
          value=""
          aria-label="Add a scene to the show"
          onChange={(ev) => ev.target.value && set([...plan.entries, { sceneId: ev.target.value, seconds: Math.round(timeToSeconds(project.compositions[ev.target.value]!.duration)), transition: "fade", fadeSeconds: 1 }], "Add to the show")}
        >
          <option value="">+ Add a scene to the show…</option>
          {scenes.map((id) => (
            <option key={id} value={id}>
              {project.compositions[id]!.name}
            </option>
          ))}
        </select>
        <span className="muted small">The show is {total.toFixed(1)} s. Export it from “Export or play” while the Show tab is open.</span>
      </div>
    </div>
  );
};

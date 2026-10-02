/**
 * Timeline editing beyond moving bars:
 *   BarEdges     drag a bar's end to change how long it lasts (and a layer's start to trim it).
 *   Scene3DMarks a 3D layer's collapse and rebuild times as draggable flags, and the keyframes of
 *                its objects as diamonds: drag to retime, click for easing (smooth, steady, start
 *                slowly, arrive slowly, jump) or to delete.
 */
import {
  type AnimProp,
  type Composition,
  EASE_PRESETS,
  type EasePreset,
  type Flicks,
  FLICKS_PER_SECOND,
  getRecipe,
  keyEase,
  type Layer,
  moveKey,
  type Object3D,
  type RecipeInstance,
  setKeyEase,
  snapToFrame,
} from "@be/core";
import { useState } from "react";
import { updateObject, use3D } from "./actions3d.ts";
import { useStudio } from "./store.ts";

type TimeAt = (clientX: number) => Flicks;
type Pct = (t: Flicks) => string;

const drag = (e: React.PointerEvent, move: (ev: PointerEvent) => void, onUp?: (moved: boolean) => void) => {
  e.stopPropagation();
  e.preventDefault();
  const el = e.currentTarget as HTMLElement;
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    /* synthetic events */
  }
  const x0 = e.clientX;
  let moved = false;
  const mv = (ev: PointerEvent) => {
    if (Math.abs(ev.clientX - x0) > 2) moved = true;
    if (moved) move(ev);
  };
  const up = () => {
    el.removeEventListener("pointermove", mv);
    el.removeEventListener("pointerup", up);
    onUp?.(moved);
  };
  el.addEventListener("pointermove", mv);
  el.addEventListener("pointerup", up);
};

/** Handles on a bar's ends: change duration (effects and layers) or trim a layer's start. */
export const BarEdges = ({ comp, inst, layer, timeAt }: { comp: Composition; inst?: RecipeInstance | undefined; layer?: Layer | undefined; timeAt: TimeAt }) => {
  const frame = Math.round((FLICKS_PER_SECOND * comp.frameRate.den) / comp.frameRate.num);
  const hasSeconds = inst ? !!getRecipe(inst.recipeId)?.params.some((p) => p.key === "seconds") : false;
  const end = (e: React.PointerEvent) =>
    drag(e, (ev) => {
      const t = snapToFrame(Math.min(comp.duration, Math.max(0, timeAt(ev.clientX))), comp.frameRate);
      const s = useStudio.getState();
      if (inst && hasSeconds) {
        const seconds = Math.max(0.5, (t - inst.startTime) / FLICKS_PER_SECOND);
        s.apply({ type: "recipe.update", args: { instanceId: inst.id, params: { seconds: Math.round(seconds * 100) / 100 } } }, { label: "Change how long it lasts", coalesceKey: `len-${inst.id}`, quiet: true });
      } else if (layer && !layer.locked) {
        s.apply({ type: "layer.update", args: { compId: comp.id, layerId: layer.id, changes: { outPoint: Math.max(layer.inPoint + frame, t) } } }, { label: "Change how long it lasts", coalesceKey: `out-${layer.id}`, quiet: true });
      }
    });
  const start = (e: React.PointerEvent) =>
    drag(e, (ev) => {
      if (!layer || layer.locked) return;
      const t = snapToFrame(Math.max(0, timeAt(ev.clientX)), comp.frameRate);
      useStudio.getState().apply({ type: "layer.update", args: { compId: comp.id, layerId: layer.id, changes: { inPoint: Math.min(layer.outPoint - frame, t) } } }, { label: "Trim the start", coalesceKey: `in-${layer.id}`, quiet: true });
    });
  return (
    <>
      {layer && <span className="bar-edge left" role="slider" aria-label={`${layer.name}: start (drag to trim)`} aria-valuenow={layer.inPoint} onPointerDown={start} />}
      {(layer || hasSeconds) && <span className="bar-edge right" role="slider" aria-label={`${inst?.label ?? layer?.name}: end (drag to change how long it lasts)`} aria-valuenow={inst ? inst.startTime : layer!.outPoint} onPointerDown={end} />}
    </>
  );
};

/** Animatable values of a 3D object, by path. */
const PROPS: Array<{ path: string; label: string; get: (o: Object3D) => AnimProp | undefined; set: (o: Object3D, p: AnimProp) => Partial<Record<keyof Object3D, unknown>> }> = [
  { path: "position", label: "position", get: (o) => o.position, set: (_o, p) => ({ position: p }) },
  { path: "rotation", label: "turn", get: (o) => o.rotation, set: (_o, p) => ({ rotation: p }) },
  { path: "scale", label: "size", get: (o) => o.scale, set: (_o, p) => ({ scale: p }) },
  { path: "material.color", label: "colour", get: (o) => o.material?.color, set: (o, p) => ({ material: { ...o.material!, color: p } }) },
  { path: "material.glow", label: "glow", get: (o) => o.material?.glow, set: (o, p) => ({ material: { ...o.material!, glow: p } }) },
  { path: "light.intensity", label: "brightness", get: (o) => o.light?.intensity, set: (o, p) => ({ light: { ...o.light!, intensity: p } }) },
];

interface KeyMenu {
  readonly objectId: string;
  readonly path: string;
  readonly keyId: string;
  /** Where to show the menu (window coordinates, above the diamond). */
  readonly x: number;
  readonly y: number;
}

export const Scene3DMarks = ({ comp, layer, pct, timeAt }: { comp: Composition; layer: Layer; pct: Pct; timeAt: TimeAt }) => {
  const project = useStudio((s) => s.project)!;
  const [menu, setMenu] = useState<KeyMenu | null>(null);
  const scene = layer.source.kind === "scene3d" ? project.scenes3d?.[layer.source.sceneId] : undefined;
  if (!scene) return null;
  const toComp = (localSeconds: number): Flicks => layer.startTime + Math.round((localSeconds * FLICKS_PER_SECOND) / layer.stretch);
  const toLocal = (t: Flicks) => ((t - layer.startTime) * layer.stretch) / FLICKS_PER_SECOND;
  const fps = comp.frameRate.num / comp.frameRate.den;
  const snapS = (s: number) => Math.max(0, Math.round(s * fps) / fps);
  const select = (objectId: string) => {
    useStudio.getState().selectLayer(layer.id);
    use3D.setState({ objectId });
  };
  const marks: React.ReactNode[] = [];
  for (const id of scene.objectOrder) {
    const o = scene.objects[id]!;
    const fr = o.fracture;
    if (fr) {
      const collapse = toComp(fr.collapseAt);
      marks.push(
        <span
          key={`${id}-c`}
          className="mark collapse"
          style={{ left: pct(collapse) }}
          role="slider"
          aria-label={`${o.name}: collapse time`}
          aria-valuenow={fr.collapseAt}
          title={`${o.name} collapses at ${fr.collapseAt.toFixed(2)} s — drag to change`}
          onPointerDown={(e) => {
            select(id);
            drag(e, (ev) => {
              const s = snapS(toLocal(timeAt(ev.clientX)));
              const cur = useStudio.getState().project!.scenes3d![scene.id]!.objects[id]!;
              const f = cur.fracture!;
              updateObject(scene.id, id, { fracture: { ...f, collapseAt: s, ...(f.rebuildAt !== null && f.rebuildAt <= s ? { rebuildAt: s + 0.5 } : {}) } }, "Change collapse time", `${id}:collapse-drag`);
            });
          }}
        >
          ▼
        </span>,
      );
      if (fr.rebuildAt !== null) {
        const rb = toComp(fr.rebuildAt);
        const rbEnd = toComp(fr.rebuildAt + fr.rebuildSeconds);
        marks.push(<span key={`${id}-band`} className="mark-band" style={{ left: pct(rb), width: pct(rbEnd - rb) }} aria-hidden="true" />);
        marks.push(
          <span
            key={`${id}-r`}
            className="mark rebuild"
            style={{ left: pct(rb) }}
            role="slider"
            aria-label={`${o.name}: rebuild time`}
            aria-valuenow={fr.rebuildAt}
            title={`${o.name} rebuilds at ${fr.rebuildAt.toFixed(2)} s for ${fr.rebuildSeconds.toFixed(1)} s — drag to change`}
            onPointerDown={(e) => {
              select(id);
              drag(e, (ev) => {
                const cur = useStudio.getState().project!.scenes3d![scene.id]!.objects[id]!;
                const f = cur.fracture!;
                const s = Math.max(f.collapseAt + 1 / fps, snapS(toLocal(timeAt(ev.clientX))));
                updateObject(scene.id, id, { fracture: { ...f, rebuildAt: s } }, "Change rebuild time", `${id}:rebuild-drag`);
              });
            }}
          >
            ▲
          </span>,
        );
      }
    }
    for (const P of PROPS) {
      const prop = P.get(o);
      for (const k of prop?.keyframes ?? []) {
        const left = pct(toComp(k.t / FLICKS_PER_SECOND));
        marks.push(
          <span
            key={`${id}-${P.path}-${k.id}`}
            className={`key-diamond ${menu?.keyId === k.id ? "on" : ""}`}
            style={{ left }}
            role="button"
            aria-label={`${o.name} ${P.label} keyframe at ${(k.t / FLICKS_PER_SECOND).toFixed(2)} s`}
            title={`${o.name}: ${P.label} — drag to retime, click for easing`}
            onPointerDown={(e) => {
              select(id);
              drag(
                e,
                (ev) => {
                  const cur = useStudio.getState().project!.scenes3d![scene.id]!.objects[id]!;
                  const p = P.get(cur);
                  if (!p) return;
                  const t = Math.round(snapS(toLocal(timeAt(ev.clientX))) * FLICKS_PER_SECOND);
                  updateObject(scene.id, id, P.set(cur, moveKey(p, k.id, t)), "Move keyframe", `${id}:${k.id}:move`);
                },
                (moved) => {
                  const r = (e.target as HTMLElement).getBoundingClientRect();
                  if (!moved) setMenu(menu?.keyId === k.id ? null : { objectId: id, path: P.path, keyId: k.id, x: r.left + r.width / 2, y: r.top });
                },
              );
            }}
          />,
        );
      }
    }
  }
  const mo = menu ? scene.objects[menu.objectId] : undefined;
  const mp = menu && mo ? PROPS.find((x) => x.path === menu.path) : undefined;
  const mprop = mo && mp ? mp.get(mo) : undefined;
  return (
    <>
      {marks}
      {menu && mo && mp && mprop && (
        <div className="popover key-menu" style={{ left: menu.x, top: menu.y }} role="menu" aria-label="Keyframe easing">
          <strong className="small">How it moves from here</strong>
          {EASE_PRESETS.map((e) => (
            <button
              key={e.id}
              role="menuitemradio"
              aria-checked={keyEase(mprop, menu.keyId) === e.id}
              className={`list-item ${keyEase(mprop, menu.keyId) === e.id ? "on" : ""}`}
              onClick={() => {
                updateObject(scene.id, mo.id, mp.set(mo, setKeyEase(mprop, menu.keyId, e.id as EasePreset)), "Change easing");
                setMenu(null);
              }}
            >
              {e.label}
            </button>
          ))}
          <button
            role="menuitem"
            className="list-item danger"
            onClick={() => {
              const rest = mprop.keyframes!.filter((k) => k.id !== menu.keyId);
              const next: AnimProp = rest.length ? { ...mprop, keyframes: rest } : { value: mprop.keyframes!.find((k) => k.id === menu.keyId)!.v, ...(mprop.spatial ? { spatial: true } : {}) };
              updateObject(scene.id, mo.id, mp.set(mo, next), "Delete keyframe");
              setMenu(null);
            }}
          >
            Delete keyframe
          </button>
        </div>
      )}
    </>
  );
};

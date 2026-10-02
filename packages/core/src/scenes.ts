/**
 * Scenes and the show.
 *
 * A scene is a composition built on the shared building areas. Duplicating a scene copies its
 * content assignments (as new, independent effects), so swapping the content in the copy never
 * touches the original — while both keep using the same traced areas.
 *
 * The show is a composition that plays scenes one after another, with cuts or crossfades. Its
 * plan (which scenes, how long, which transition) is stored on it, and its layers are rebuilt from
 * the plan, so arranging the show is one simple, undoable step.
 */
import { type Draft } from "immer";
import { z } from "zod";
import { EASY_EASE, type Keyframe, staticProp } from "./anim.ts";
import { type Composition, defaultTransform, type Id, type Layer, type Project, type RecipeInstance } from "./model.ts";
import { defineOp, OpError } from "./ops.ts";
import { generatedLayerId } from "./recipes.ts";
import { secondsToTime } from "./time.ts";
import type { Scene3D } from "./world3d.ts";

export interface ShowEntry {
  readonly sceneId: Id;
  readonly seconds: number;
  /** How this scene arrives: a cut, or a crossfade over `fadeSeconds`. */
  readonly transition: "cut" | "fade";
  readonly fadeSeconds: number;
}

export interface ShowPlan {
  readonly entries: readonly ShowEntry[];
}

/** Scenes in the project (everything except the show itself). */
export const sceneIds = (p: Project): Id[] => p.compositionOrder.filter((id) => !p.compositions[id]?.show);

/** Ids for a duplicated scene are derived from the new scene id, so the operation replays exactly. */
const dupId = (old: Id, newCompId: Id) => `${old}~${newCompId.replace(/[^\w]/g, "").slice(-8)}`;

export const sceneDuplicate = defineOp({
  type: "scene.duplicate",
  title: "Duplicate scene",
  description: "Copy a scene with all its content assignments and effects as a new, independent scene that uses the same building areas.",
  args: z.object({ compId: z.string().min(1), newCompId: z.string().min(1), name: z.string().min(1) }),
  apply: (d, a) => {
    const src = d.compositions[a.compId];
    if (!src) throw new OpError("That scene no longer exists.");
    if (d.compositions[a.newCompId]) throw new OpError("A scene with that id already exists.");
    if (src.show) throw new OpError("The show itself can't be duplicated as a scene.");
    const instMap = new Map<Id, Id>();
    for (const inst of Object.values(d.recipes)) if (inst.compId === a.compId) instMap.set(inst.id, dupId(inst.id, a.newCompId));
    // Generated layers are named after their effect; other layers get derived ids.
    const layerMap = new Map<Id, Id>();
    for (const id of src.layerOrder) {
      const l = src.layers[id]!;
      const gen = l.generatedBy;
      layerMap.set(id, gen && instMap.has(gen.recipeInstanceId) ? generatedLayerId(instMap.get(gen.recipeInstanceId)!, gen.role) : dupId(id, a.newCompId));
    }
    const layers: Record<Id, Layer> = {};
    for (const id of src.layerOrder) {
      const l = JSON.parse(JSON.stringify(src.layers[id])) as Layer & { parentId?: Id; trackMatte?: { layerId: Id; mode: string }; generatedBy?: { recipeInstanceId: Id; role: string } };
      const nid = layerMap.get(id)!;
      const copy: Record<string, unknown> = { ...l, id: nid };
      if (l.parentId) copy.parentId = layerMap.get(l.parentId) ?? l.parentId;
      if (l.trackMatte) copy.trackMatte = { ...l.trackMatte, layerId: layerMap.get(l.trackMatte.layerId) ?? l.trackMatte.layerId };
      if (l.generatedBy && instMap.has(l.generatedBy.recipeInstanceId)) copy.generatedBy = { ...l.generatedBy, recipeInstanceId: instMap.get(l.generatedBy.recipeInstanceId)! };
      // A 3D scene shown in this scene gets its own copy, so editing the copy leaves the original alone.
      if (l.source.kind === "scene3d" && d.scenes3d?.[l.source.sceneId]) {
        const sid = dupId(l.source.sceneId, a.newCompId);
        if (!d.scenes3d[sid]) d.scenes3d[sid] = { ...(JSON.parse(JSON.stringify(d.scenes3d[l.source.sceneId])) as Scene3D), id: sid } as Draft<Scene3D>;
        copy.source = { kind: "scene3d", sceneId: sid };
      }
      layers[nid] = copy as unknown as Layer;
    }
    const comp: Composition = { ...(JSON.parse(JSON.stringify(src)) as Composition), id: a.newCompId, name: a.name, layers, layerOrder: src.layerOrder.map((id) => layerMap.get(id)!) };
    d.compositions[a.newCompId] = comp as Draft<Composition>;
    const at = d.compositionOrder.indexOf(a.compId);
    d.compositionOrder.splice(at < 0 ? d.compositionOrder.length : at + 1, 0, a.newCompId);
    for (const [old, nid] of instMap) {
      const inst = JSON.parse(JSON.stringify(d.recipes[old])) as RecipeInstance;
      const overrides: Record<Id, readonly string[]> = {};
      for (const [lid, paths] of Object.entries(inst.overrides)) overrides[layerMap.get(lid) ?? lid] = paths;
      const generated: Record<string, Id> = {};
      for (const [role, lid] of Object.entries(inst.generated)) generated[role] = layerMap.get(lid) ?? lid;
      d.recipes[nid] = { ...inst, id: nid, compId: a.newCompId, generated, overrides } as Draft<RecipeInstance>;
    }
  },
  summarize: (a, p) => `Duplicated "${p.compositions[a.compId]?.name ?? "scene"}" as "${a.name}".`,
});

const showEntry = z.object({ sceneId: z.string().min(1), seconds: z.number().min(0.5).max(36000), transition: z.enum(["cut", "fade"]), fadeSeconds: z.number().min(0).max(60) });

/** Layers that play the plan's scenes in order; a fade overlaps the previous scene and fades in. */
export const showLayers = (p: Project, showId: Id, plan: ShowPlan): { layers: Record<Id, Layer>; order: Id[]; duration: number } => {
  const layers: Record<Id, Layer> = {};
  const order: Id[] = [];
  let t = 0;
  plan.entries.forEach((e, i) => {
    const scene = p.compositions[e.sceneId];
    if (!scene) return;
    const fade = i > 0 && e.transition === "fade" ? Math.min(e.fadeSeconds, e.seconds / 2) : 0;
    const start = Math.max(0, t - fade);
    const inP = secondsToTime(start);
    const outP = secondsToTime(start + e.seconds);
    const id = `${showId}_s${i}`;
    const opacityKeys: Keyframe<number>[] = fade > 0 ? [{ id: `${id}_f0`, t: inP, v: 0, in: "linear", out: "bezier", easeOut: [EASY_EASE] }, { id: `${id}_f1`, t: secondsToTime(start + fade), v: 100, in: "bezier", out: "linear", easeIn: [EASY_EASE] }] : [];
    layers[id] = {
      id,
      name: scene.name,
      source: { kind: "comp", compId: scene.id },
      startTime: inP,
      inPoint: inP,
      outPoint: outP,
      stretch: 1,
      enabled: true,
      solo: false,
      locked: false,
      audioEnabled: true,
      is3D: false,
      blendMode: "normal",
      transform: { ...defaultTransform(0, 0), opacity: opacityKeys.length ? { value: 100, keyframes: opacityKeys } : staticProp(100) },
      masks: [],
      effects: [],
    };
    // Later scenes sit on top so a crossfade reveals them over the previous one.
    order.unshift(id);
    t = start + e.seconds;
  });
  return { layers, order, duration: Math.max(1, t) };
};

export const showSet = defineOp({
  type: "show.set",
  title: "Arrange the show",
  description: "Set which scenes the show plays, in order, for how long, and how each one arrives (cut or crossfade). Creates the show if needed.",
  args: z.object({ showId: z.string().min(1), name: z.string().min(1).optional(), entries: z.array(showEntry), makeMain: z.boolean().optional() }),
  apply: (d, a) => {
    const plan: ShowPlan = { entries: a.entries };
    for (const e of a.entries) if (!d.compositions[e.sceneId] || d.compositions[e.sceneId]!.show) throw new OpError("A scene in the show no longer exists.");
    const first = d.compositions[a.entries[0]?.sceneId ?? ""];
    let show = d.compositions[a.showId];
    if (!show) {
      if (!first) throw new OpError("Add at least one scene to the show.");
      d.compositions[a.showId] = {
        id: a.showId,
        name: a.name ?? "Show",
        width: first.width,
        height: first.height,
        frameRate: first.frameRate,
        duration: first.duration,
        background: [0, 0, 0, 1],
        layerOrder: [],
        layers: {},
        markers: [],
        ...(first.venueId ? { venueId: first.venueId } : {}),
        show: plan,
      } as unknown as Draft<Composition>;
      d.compositionOrder.push(a.showId);
      show = d.compositions[a.showId]!;
    }
    const built = showLayers(d as unknown as Project, a.showId, plan);
    show.layers = built.layers as Draft<Composition["layers"]>;
    show.layerOrder = built.order;
    show.duration = secondsToTime(built.duration);
    show.show = plan as Draft<ShowPlan>;
    if (a.name) show.name = a.name;
    if (a.makeMain) d.mainCompId = a.showId;
  },
  summarize: (a) => `Arranged the show: ${a.entries.length} scene${a.entries.length === 1 ? "" : "s"}.`,
});

export const sceneOps = [sceneDuplicate, showSet];

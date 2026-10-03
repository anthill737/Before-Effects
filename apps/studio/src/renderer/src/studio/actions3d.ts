/**
 * 3D in the studio: give building areas thickness, make them collapse and rebuild, add objects and
 * lights, and edit them. Everything is an ordinary undoable operation on the project's 3D scenes;
 * the presets only fill in sensible starting values.
 */
import {
  type AnimProp,
  areaScene,
  ballObject,
  boxObject,
  DEFAULT_FRACTURE,
  DEFAULT_PHYSICS,
  type Flicks,
  FRACTURE_PRESETS,
  type Layer,
  lightObject,
  type Mask,
  newId,
  type Object3D,
  PARTICLE_PRESETS,
  type ParticleKind,
  type PropValue,
  type RegionRef,
  type Scene3D,
  secondsToTime,
  setPropAt,
  snapToFrame,
  staticProp,
  toggleKeyAt,
  type Vec3,
} from "@be/core";
import { create } from "zustand";
import { activeVenue, currentComp, useStudio } from "./store.ts";

/** Which object of the selected 3D layer's scene is being edited. */
export const use3D = create<{ objectId: string | null }>(() => ({ objectId: null }));

export const COLLAPSE_EFFECT = { id: "collapse-3d", title: FRACTURE_PRESETS.collapse.title, description: FRACTURE_PRESETS.collapse.description };
export type BreakPreset = keyof typeof FRACTURE_PRESETS;
/** Breaking apart with real physics: collapse & rebuild, explode, crumble, shatter (cards in the effects list). */
export const BREAK_EFFECTS = (Object.keys(FRACTURE_PRESETS) as BreakPreset[]).map((k) => ({ id: k === "collapse" ? COLLAPSE_EFFECT.id : `${k}-3d`, preset: k, title: FRACTURE_PRESETS[k].title, description: FRACTURE_PRESETS[k].description }));
/** Particles drawn by rule in 3D (cards in the effects list). */
export const PARTICLE_EFFECTS = (Object.keys(PARTICLE_PRESETS) as ParticleKind[]).map((k) => ({ id: `particles-${k}`, kind: k, title: PARTICLE_PRESETS[k].title, description: PARTICLE_PRESETS[k].description }));
/** Card id → what it makes. */
export const effect3dFor = (id: string): { break: BreakPreset } | { particles: ParticleKind } | null => {
  const b = BREAK_EFFECTS.find((e) => e.id === id);
  if (b) return { break: b.preset };
  const p = PARTICLE_EFFECTS.find((e) => e.id === id);
  return p ? { particles: p.kind } : null;
};

export const sceneForLayer = (layer: Layer | undefined): Scene3D | undefined => {
  const p = useStudio.getState().project;
  return layer?.source.kind === "scene3d" ? p?.scenes3d?.[layer.source.sceneId] : undefined;
};

/** The selected 3D layer, if the selection is one. */
export const selected3DLayer = (): Layer | undefined => {
  const s = useStudio.getState();
  const l = s.selection.layerId ? currentComp(s)?.layers[s.selection.layerId] : undefined;
  return l?.source.kind === "scene3d" ? l : undefined;
};

/** Layer-local time (what 3D keyframes and collapse timing use) for a composition time. */
export const layerTime = (layer: Layer, t: Flicks): Flicks => Math.round((t - layer.startTime) * layer.stretch);

/** A reference to the chosen areas: a group when the selection is exactly a group, else the areas. */
const refFor = (regionIds: readonly string[]): RegionRef => {
  const s = useStudio.getState();
  const venue = activeVenue(s)!;
  const g = Object.values(venue.groups).find((x) => x.regionIds.length === regionIds.length && x.regionIds.every((id) => regionIds.includes(id)));
  return g ? { role: g.name, groupId: g.id } : { role: "areas", regionIds: [...regionIds] };
};

/** Give areas thickness as a 3D solid (optionally breaking apart), shown by a new 3D layer. */
export const makeArea3D = (regionIds: readonly string[], collapse: boolean, preset: BreakPreset = "collapse"): string | null => {
  const s = useStudio.getState();
  const comp = currentComp(s);
  const venue = activeVenue(s);
  if (!s.project || !comp || !venue || !regionIds.length) return null;
  const names = regionIds.map((id) => venue.regions[id]?.name).filter(Boolean);
  const sceneId = newId("s3d");
  const name = `${names.length > 2 ? `${names.length} areas` : names.join(" + ")} in 3D`;
  const fracture = FRACTURE_PRESETS[preset].fracture;
  const scene = areaScene(s.project, { sceneId, idPrefix: sceneId, name, ref: refFor(regionIds), venueId: venue.id, canvas: venue.canvas, collapse, fracture });
  const layerId = newId("layer");
  const start = snapToFrame(Math.min(s.time, Math.max(0, comp.duration - secondsToTime(2))), comp.frameRate);
  const layer: Layer = {
    id: layerId,
    name,
    source: { kind: "scene3d", sceneId },
    startTime: start,
    inPoint: start,
    outPoint: Math.min(comp.duration, start + secondsToTime(8)),
    stretch: 1,
    enabled: true,
    solo: false,
    locked: false,
    audioEnabled: false,
    is3D: false,
    blendMode: "normal",
    transform: { anchor: staticProp<Vec3>([0, 0, 0]), position: staticProp<Vec3>([0, 0, 0], true), scale: staticProp<Vec3>([100, 100, 100]), rotation: staticProp<Vec3>([0, 0, 0]), opacity: staticProp(100) },
    masks: [],
    effects: [],
  };
  const tx = s.apply(
    [
      { type: "scene3d.add", args: { scene } },
      { type: "layer.add", args: { compId: comp.id, layer } },
    ],
    { label: collapse ? FRACTURE_PRESETS[preset].title.replace(" (3D)", " in 3D") : "Give the area thickness" },
  );
  if (!tx) return null;
  // Show the result: the Areas step covers the picture with the tracing photo.
  if (s.step === "space") useStudio.setState({ step: "animate" });
  s.selectLayer(layerId);
  use3D.setState({ objectId: `${sceneId}-area` });
  s.toast({
    kind: "success",
    text: collapse
      ? preset === "collapse"
        ? `“${name}”: the area breaks apart ${DEFAULT_FRACTURE.collapseAt} s in and flies back at ${DEFAULT_FRACTURE.rebuildAt} s. Adjust it on the right; look around it in “3D projection”.`
        : `“${name}”: the area ${preset === "explode" ? "explodes" : preset === "shatter" ? "shatters like glass" : "crumbles"} ${fracture.collapseAt} s in, with real physics. Adjust it on the right; look around it in “3D projection”.`
      : `“${name}” is now a 3D solid ${Math.round(0.3 * 100)} cm thick. Adjust it on the right; look around it in “3D projection”.`,
  });
  return layerId;
};

/**
 * Particles (sparks, embers, snow, confetti) from the selected areas — snow can fall over the whole
 * picture — as a 3D layer on top of the scene at the playhead. Returns the layer id.
 */
export const addParticles = (kind: ParticleKind, regionIds: readonly string[]): string | null => {
  const s = useStudio.getState();
  const comp = currentComp(s);
  const venue = activeVenue(s);
  if (!s.project || !comp) return null;
  if (!regionIds.length && kind !== "snow") return null;
  const preset = PARTICLE_PRESETS[kind];
  const names = regionIds.map((id) => venue?.regions[id]?.name).filter(Boolean);
  const title = preset.title.replace(" (3D)", "");
  const name = names.length ? `${title} — ${names.length > 2 ? `${names.length} areas` : names.join(" + ")}` : title;
  const sceneId = newId("s3d");
  const objectId = `${sceneId}-particles`;
  const object: Object3D = {
    id: objectId,
    name: title,
    kind: "particles",
    visible: true,
    position: staticProp<Vec3>([0, 0, 0], true),
    rotation: staticProp<Vec3>([0, 0, 0]),
    scale: staticProp<Vec3>([100, 100, 100]),
    particles: { ...preset.settings, from: regionIds.length ? refFor(regionIds) : null, seed: Math.floor(Math.random() * 1e6) },
  };
  const scene: Scene3D = { id: sceneId, name, objectOrder: [objectId], objects: { [objectId]: object }, gravity: [0, -9.81, 0], cameraDistance: 1.6 };
  const seconds = { sparks: 5, embers: 8, snow: 12, confetti: 6 }[kind];
  const start = snapToFrame(Math.min(s.time, Math.max(0, comp.duration - secondsToTime(2))), comp.frameRate);
  const layerId = newId("layer");
  const layer: Layer = {
    id: layerId,
    name,
    source: { kind: "scene3d", sceneId },
    startTime: start,
    inPoint: start,
    outPoint: Math.min(comp.duration, start + secondsToTime(seconds)),
    stretch: 1,
    enabled: true,
    solo: false,
    locked: false,
    audioEnabled: false,
    is3D: false,
    blendMode: preset.glow ? "add" : "normal",
    transform: { anchor: staticProp<Vec3>([0, 0, 0]), position: staticProp<Vec3>([0, 0, 0], true), scale: staticProp<Vec3>([100, 100, 100]), rotation: staticProp<Vec3>([0, 0, 0]), opacity: staticProp(100) },
    masks: [],
    effects: [],
  };
  const tx = s.apply(
    [
      { type: "scene3d.add", args: { scene } },
      // On top: particles fly in front of everything.
      { type: "layer.add", args: { compId: comp.id, layer, index: 0 } },
    ],
    { label: `Add ${title.toLowerCase()}` },
  );
  if (!tx) return null;
  if (s.step === "space") useStudio.setState({ step: "animate" });
  s.selectLayer(layerId);
  use3D.setState({ objectId });
  s.toast({ kind: "success", text: `${title}: ${preset.description} Adjust amount, size and colour on the right.` });
  return layerId;
};

export const updateObject = (sceneId: string, objectId: string, changes: Partial<Record<keyof Object3D, unknown>>, label: string, coalesceKey?: string) =>
  useStudio.getState().apply({ type: "object3d.update", args: { sceneId, objectId, changes } }, { label, ...(coalesceKey ? { coalesceKey } : {}) });

/** Change an animatable value at the playhead (a keyframe there if it's animated). */
export const setPropNow = <V extends PropValue>(layer: Layer, p: AnimProp<V>, v: V): AnimProp<V> => setPropAt(p, layerTime(layer, useStudio.getState().time), v);
export const toggleKeyNow = <V extends PropValue>(layer: Layer, p: AnimProp<V>): AnimProp<V> => toggleKeyAt(p, layerTime(layer, useStudio.getState().time));

export const addObject = (layer: Layer, kind: "box" | "ball" | "light" | "ledge") => {
  const scene = sceneForLayer(layer);
  const s = useStudio.getState();
  const venue = activeVenue(s);
  if (!scene || !venue) return;
  const id = newId("obj");
  const W = venue.canvas.width * 0.01;
  const H = venue.canvas.height * 0.01;
  const object: Object3D =
    kind === "box"
      ? boxObject(id, "Box", [0.8, 0.8, 0.8], [0, H * 0.8, 1.2], { ...DEFAULT_PHYSICS, mass: 80 })
      : kind === "ball"
        ? ballObject(id, "Ball", 0.4, [W * 0.15, H * 0.9, 1.2], { ...DEFAULT_PHYSICS, mass: 30, bounce: 0.5 })
        : kind === "ledge"
          ? boxObject(id, "Ledge", [W * 0.4, 0.25, 1], [0, H * 0.3, 0.5], { body: "static", mass: 1000, friction: 0.8, bounce: 0.1 })
          : lightObject(id, "Spot light", { type: "spot", target: [0, H / 2, 0], intensity: staticProp(4), angle: 30 }, [W * 0.4, H + 2, 7]);
  if (s.apply({ type: "object3d.add", args: { sceneId: scene.id, object } }, { label: `Add ${object.name.toLowerCase()}` })) use3D.setState({ objectId: id });
};

export const removeObject = (layer: Layer, objectId: string) => {
  const scene = sceneForLayer(layer);
  if (!scene) return;
  useStudio.getState().apply({ type: "object3d.remove", args: { sceneId: scene.id, objectId } }, { label: "Remove 3D object" });
  use3D.setState({ objectId: null });
};

/** The areas a 3D scene is built from (its first area object), for the "contain" mask. */
export const sceneArea = (scene: Scene3D): RegionRef | null => {
  for (const id of scene.objectOrder) {
    const g = scene.objects[id]?.geometry;
    if (g?.kind === "area") return g.ref;
  }
  return null;
};

/** Keep the 3D layer's pieces inside the area, or let them extend beyond it (projector blackout areas apply either way). */
export const setContain = (layer: Layer, contain: boolean) => {
  const s = useStudio.getState();
  const comp = currentComp(s);
  const scene = sceneForLayer(layer);
  const ref = scene ? sceneArea(scene) : null;
  if (!comp || !ref) return;
  const others = layer.masks.filter((m) => m.id !== "contain");
  const parts = scene?.purpose === "parts";
  const mask: Mask = { id: "contain", name: parts ? "Keep inside the house outline" : "Keep inside the area", source: { kind: "region", ref, ...(parts ? { outline: true } : {}) }, mode: "add", inverted: false, feather: staticProp(0), expansion: staticProp(0), opacity: staticProp(100) };
  s.apply({ type: "layer.update", args: { compId: comp.id, layerId: layer.id, changes: { masks: contain ? [mask, ...others] : others } } }, { label: contain ? "Keep 3D inside the area" : "Let 3D extend beyond the area" });
};

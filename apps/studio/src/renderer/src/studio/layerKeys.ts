/**
 * Keyframes on ordinary layers (pictures, videos, text): which values can be animated, and storing
 * changes. Keyframe times are the layer's own time (so moving the layer moves its animation).
 */
import { type AnimProp, type Composition, type Flicks, LAYER_EFFECTS, type Layer, type Op, type PropValue, setPropAt, toggleKeyAt } from "@be/core";
import { useStudio } from "./store.ts";

export const LAYER_PROPS: ReadonlyArray<{ path: string; label: string; get: (l: Layer) => AnimProp | undefined }> = [
  { path: "transform.position", label: "position", get: (l) => l.transform.position },
  { path: "transform.scale", label: "size", get: (l) => l.transform.scale },
  { path: "transform.rotation", label: "turn", get: (l) => l.transform.rotation },
  { path: "transform.opacity", label: "opacity", get: (l) => l.transform.opacity },
  { path: "source.doc.size", label: "text size", get: (l) => (l.source.kind === "text" ? l.source.doc.size : undefined) },
  { path: "source.doc.color", label: "text colour", get: (l) => (l.source.kind === "text" ? l.source.doc.color : undefined) },
];

/** Everything on a layer that can carry keyframes: the values above plus each effect's settings. */
export const layerProps = (l: Layer): ReadonlyArray<{ path: string; label: string; get: (l: Layer) => AnimProp | undefined }> => [
  ...LAYER_PROPS,
  { path: "source.doc.stroke.color", label: "outline colour", get: (x: Layer) => (x.source.kind === "text" ? x.source.doc.stroke?.color : undefined) },
  { path: "source.doc.stroke.width", label: "outline width", get: (x: Layer) => (x.source.kind === "text" ? x.source.doc.stroke?.width : undefined) },
  { path: "audio.volume", label: "volume", get: (x: Layer) => x.audio?.volume },
  { path: "audio.pan", label: "left/right", get: (x: Layer) => x.audio?.pan },
  ...l.masks.flatMap((m) =>
    (["feather", "expansion", "opacity"] as const).map((k) => ({ path: `masks.${m.id}.${k}`, label: `${m.name} ${k === "feather" ? "soft edge" : k === "expansion" ? "grow" : "strength"}`, get: (x: Layer) => x.masks.find((y) => y.id === m.id)?.[k] })),
  ),
  ...l.effects.flatMap((e) =>
    Object.keys(e.params).map((k) => ({
      path: `effects.${e.id}.params.${k}`,
      label: `${(LAYER_EFFECTS[e.type]?.title ?? e.type).toLowerCase()} ${(LAYER_EFFECTS[e.type]?.params.find((x) => x.key === k)?.label ?? k).toLowerCase()}`,
      get: (x: Layer) => x.effects.find((f) => f.id === e.id)?.params[k],
    })),
  ),
];

/** Layer time for a scene time. */
export const layerLocal = (layer: Layer, t: Flicks): Flicks => Math.round((t - layer.startTime) * layer.stretch);

/** Store a property's new animation (or plain value) in one undo step. */
export const storeProp = (comp: Composition, layer: Layer, path: string, next: AnimProp, label: string, coalesceKey?: string) => {
  const base = { compId: comp.id, layerId: layer.id, path };
  const ops: Op[] = next.keyframes?.length
    ? [{ type: "prop.setAnimation", args: { ...base, keyframes: next.keyframes } }]
    : [
        { type: "prop.setAnimation", args: { ...base, keyframes: [] } },
        { type: "prop.set", args: { ...base, value: next.value } },
      ];
  useStudio.getState().apply(ops, { label, ...(coalesceKey ? { coalesceKey } : {}) });
};

/** Change a value at the playhead: animated values get a keyframe there, others just change. */
export const setLayerValue = <V extends PropValue>(comp: Composition, layer: Layer, path: string, prop: AnimProp<V>, v: V, label: string) => {
  if (prop.keyframes?.length) storeProp(comp, layer, path, setPropAt(prop, layerLocal(layer, useStudio.getState().time), v) as AnimProp, label, `${layer.id}:${path}`);
  else useStudio.getState().apply({ type: "prop.set", args: { compId: comp.id, layerId: layer.id, path, value: v as unknown as number } }, { label, coalesceKey: `${layer.id}:${path}` });
};

/** Add a keyframe at the playhead (starting animation) or remove the one there. */
export const toggleLayerKey = (comp: Composition, layer: Layer, path: string, prop: AnimProp) => {
  const next = toggleKeyAt(prop, layerLocal(layer, useStudio.getState().time));
  storeProp(comp, layer, path, next, (next.keyframes?.length ?? 0) > (prop.keyframes?.length ?? 0) ? "Add keyframe" : "Remove keyframe");
};

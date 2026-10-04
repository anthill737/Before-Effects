/**
 * Adjustment layers: effects on one change everything below it (colour, blur, glow, …) instead of a
 * picture of its own — over the whole picture, or only within chosen areas of the house (its masks).
 */
import { type Composition, type Flicks, type Id, type Layer, type Mask, newId, staticProp } from "@be/core";
import { useStudio } from "./store.ts";

/** Seconds as flicks (FLICKS_PER_SECOND). */
const SECOND = 705_600_000;

/** An adjustment layer covering the scene (moved, scaled and turned like any layer), limited to `regionIds` when given. */
export const adjustmentLayer = (comp: Composition, o: { name?: string; regionIds?: readonly Id[]; from: Flicks; to: Flicks }): Layer => {
  const masks: Mask[] = o.regionIds?.length
    ? [{ id: "areas", name: "Only in these areas", source: { kind: "region", ref: { role: "areas", regionIds: [...o.regionIds] } }, mode: "add", inverted: false, feather: staticProp(0), expansion: staticProp(0), opacity: staticProp(100) }]
    : [];
  const mid: [number, number, number] = [comp.width / 2, comp.height / 2, 0];
  return {
    id: newId("layer"),
    name: o.name ?? (o.regionIds?.length ? "Adjust these areas" : "Adjust everything below"),
    source: { kind: "adjustment" },
    startTime: o.from,
    inPoint: o.from,
    outPoint: o.to,
    stretch: 1,
    enabled: true,
    solo: false,
    locked: false,
    audioEnabled: false,
    is3D: false,
    blendMode: "normal",
    transform: { anchor: staticProp(mid), position: staticProp(mid, true), scale: staticProp<[number, number, number]>([100, 100, 100]), rotation: staticProp<[number, number, number]>([0, 0, 0]), opacity: staticProp(100) },
    masks,
    effects: [],
  };
};

/** Add one on top of the current scene from the playhead (8 seconds, within the scene), in the selected areas if any; it's selected. */
export const addAdjustmentLayer = (regionIds: readonly Id[] = useStudio.getState().selection.regionIds): Id | null => {
  const s = useStudio.getState();
  const comp = s.project?.compositions[s.compId ?? ""];
  if (!comp) return null;
  const from = Math.min(s.time, Math.max(0, comp.duration - SECOND));
  const layer = adjustmentLayer(comp, { regionIds, from, to: Math.min(comp.duration, from + SECOND * 8) });
  s.apply({ type: "layer.add", args: { compId: comp.id, layer } }, { label: regionIds.length ? "Adjust these areas" : "Adjust everything below" });
  s.selectLayer(layer.id);
  return layer.id;
};

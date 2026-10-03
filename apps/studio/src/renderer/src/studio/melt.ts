/**
 * "Melt" on areas: the area's own photo is projected back onto it, then sags and drips down,
 * leaving darkness behind — the house seems to melt. An ordinary picture layer, clipped to the
 * areas, with a Melt effect whose "Melted" setting is animated (every setting stays adjustable).
 */
import { type AnimProp, LAYER_EFFECTS, type Mask, newEffect, newId, newLayer, secondsToTime, setPropAt, snapToFrame, staticProp, toggleKeyAt, type Vec3 } from "@be/core";
import { activeVenue, currentComp, useStudio } from "./store.ts";

export const MELT_EFFECT = { id: "melt-area", title: "Melt", description: "The area's own picture sags and drips downward, leaving darkness behind — the building seems to melt." };

export const meltAreas = (regionIds: readonly string[]): string | null => {
  const s = useStudio.getState();
  const comp = currentComp(s);
  const venue = activeVenue(s);
  const photo = venue?.referenceAssetId ? s.project?.assets[venue.referenceAssetId] : undefined;
  if (!comp || !venue || !regionIds.length) return null;
  if (!photo) {
    s.toast({ kind: "info", text: "Melt uses the building photo: add one in step 1 (Areas) first." });
    return null;
  }
  const regions = regionIds.map((id) => venue.regions[id]).filter((r) => !!r);
  const names = regions.map((r) => r.name);
  const ys = regions.flatMap((r) => r.path.vertices.map((v) => v.p[1]));
  const height = Math.max(40, Math.max(...ys) - Math.min(...ys));
  const start = snapToFrame(Math.min(s.time, Math.max(0, comp.duration - secondsToTime(2))), comp.frameRate);
  const w = photo.meta.width ?? venue.canvas.width, h = photo.meta.height ?? venue.canvas.height;
  const k = (comp.width / w) * 100;
  const base = newLayer({ id: newId("layer"), name: `Melt — ${names.length > 2 ? `${names.length} areas` : names.join(" + ")}`, source: { kind: "footage", assetId: photo.id }, start, duration: Math.min(comp.duration - start, secondsToTime(6)) });
  const mask: Mask = { id: "area", name: "The areas", source: { kind: "region", ref: { role: "areas", regionIds: [...regionIds] } }, mode: "add", inverted: false, feather: staticProp(0), expansion: staticProp(0), opacity: staticProp(100) };
  // Melts from 0.5 s to 3.5 s into the layer.
  let amount: AnimProp<number> = toggleKeyAt(staticProp(0), secondsToTime(0.5));
  amount = setPropAt(amount, secondsToTime(3.5), 1);
  const melt = newEffect("melt", newId("fx"), { distance: Math.round(height * 0.9) });
  const layer = {
    ...base,
    audioEnabled: false,
    transform: { ...base.transform, anchor: staticProp<Vec3>([w / 2, h / 2, 0]), position: staticProp<Vec3>([comp.width / 2, comp.height / 2, 0], true), scale: staticProp<Vec3>([k, k, 100]) },
    masks: [mask],
    effects: [{ ...melt, params: { ...melt.params, amount } }],
  };
  const tx = s.apply({ type: "layer.add", args: { compId: comp.id, layer, index: 0 } }, { label: `${LAYER_EFFECTS.melt!.title} ${names.join(" + ")}` });
  if (!tx) return null;
  if (s.step === "space") useStudio.setState({ step: "animate" });
  s.selectLayer(layer.id);
  s.toast({ kind: "success", text: `“${layer.name}”: melts from 0.5 s to 3.5 s. Change how far, the drips and the timing (◆) on the right.` });
  return layer.id;
};

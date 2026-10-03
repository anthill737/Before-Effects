/**
 * "Ripple" and "Glitch" on areas: like Melt (melt.ts), the area's own photo is projected back onto
 * it as an ordinary picture layer clipped to the areas, and a layer effect changes it — water rings
 * spread across it, or it breaks up in digital bursts. Both move by themselves with the layer's time,
 * so they need no keyframes; every setting stays adjustable (◆ to animate) in the layer's Effects.
 */
import { type EffectInstance, LAYER_EFFECTS, type Layer, type Mask, newEffect, newId, newLayer, secondsToTime, snapToFrame, staticProp, type Vec3 } from "@be/core";
import { activeVenue, currentComp, useStudio } from "./store.ts";

type Values = Readonly<Record<string, number | readonly number[]>>;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/** The areas' own picture, ready to carry an effect. */
interface AreaPicture {
  /** The building photo sized to the scene, clipped to the areas, starting at the playhead (no effects yet). */
  readonly layer: Layer;
  readonly names: readonly string[];
  /** The areas' bounds in the photo's own pixels: the layer's units, which effect settings use. */
  readonly bounds: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** The photo's size in pixels. */
  readonly size: { readonly w: number; readonly h: number };
}

/** A layer of the areas' own picture, `seconds` long from the playhead (placed as Melt places it). */
const areaPicture = (title: string, regionIds: readonly string[], seconds: number): AreaPicture | null => {
  const s = useStudio.getState();
  const comp = currentComp(s);
  const venue = activeVenue(s);
  const photo = venue?.referenceAssetId ? s.project?.assets[venue.referenceAssetId] : undefined;
  if (!comp || !venue || !regionIds.length) return null;
  if (!photo) {
    s.toast({ kind: "info", text: `${title} uses the building photo: add one in step 1 (Areas) first.` });
    return null;
  }
  const regions = regionIds.map((id) => venue.regions[id]).filter((r) => !!r);
  if (!regions.length) return null;
  const names = regions.map((r) => r.name);
  const w = photo.meta.width ?? venue.canvas.width, h = photo.meta.height ?? venue.canvas.height;
  // The photo fills the scene's width, centred: scene point → photo pixel.
  const k = comp.width / w;
  const xs = regions.flatMap((r) => r.path.vertices.map((v) => (v.p[0] - comp.width / 2) / k + w / 2));
  const ys = regions.flatMap((r) => r.path.vertices.map((v) => (v.p[1] - comp.height / 2) / k + h / 2));
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const start = snapToFrame(Math.min(s.time, Math.max(0, comp.duration - secondsToTime(2))), comp.frameRate);
  const base = newLayer({ id: newId("layer"), name: `${title} — ${names.length > 2 ? `${names.length} areas` : names.join(" + ")}`, source: { kind: "footage", assetId: photo.id }, start, duration: Math.min(comp.duration - start, secondsToTime(seconds)) });
  const mask: Mask = { id: "area", name: "The areas", source: { kind: "region", ref: { role: "areas", regionIds: [...regionIds] } }, mode: "add", inverted: false, feather: staticProp(0), expansion: staticProp(0), opacity: staticProp(100) };
  const layer: Layer = {
    ...base,
    audioEnabled: false,
    transform: { ...base.transform, anchor: staticProp<Vec3>([w / 2, h / 2, 0]), position: staticProp<Vec3>([comp.width / 2, comp.height / 2, 0], true), scale: staticProp<Vec3>([k * 100, k * 100, 100]) },
    masks: [mask],
  };
  return { layer, names, bounds: { x: x0, y: y0, w: Math.max(1, Math.max(...xs) - x0), h: Math.max(1, Math.max(...ys) - y0) }, size: { w, h } };
};

/** Add the picture layer with its effect on top, select it, and say what happened. */
const commit = (pic: AreaPicture, effect: EffectInstance, note: string): string | null => {
  const s = useStudio.getState();
  const comp = currentComp(s);
  if (!comp) return null;
  const layer: Layer = { ...pic.layer, effects: [effect] };
  const tx = s.apply({ type: "layer.add", args: { compId: comp.id, layer, index: 0 } }, { label: `${LAYER_EFFECTS[effect.type]!.title} ${pic.names.join(" + ")}` });
  if (!tx) return null;
  if (s.step === "space") useStudio.setState({ step: "animate" });
  s.selectLayer(layer.id);
  s.toast({ kind: "success", text: `“${layer.name}”: ${note}` });
  return layer.id;
};

export const RIPPLE_EFFECT = { id: "ripple-area", title: "Ripple", description: "A drop lands in the middle of the areas: rings of water spread across their own picture, bending it, then the water calms." };

/** How many rings the area card's drop makes. */
const AREA_RINGS = 8;

/**
 * Ripple on areas: a 6 s layer of their own picture. One drop lands at the middle of the areas when
 * the layer starts (the playhead); rings sized to the areas (about ten across them) spread out and
 * have passed the far edge within about 5 s. `values` override any setting.
 */
export const rippleAreas = (regionIds: readonly string[], values: Values = {}): string | null => {
  const pic = areaPicture(RIPPLE_EFFECT.title, regionIds, 6);
  if (!pic) return null;
  const { bounds: b, size } = pic;
  const wavelength = Math.round(clamp(Math.max(b.w, b.h) / 10, 8, 400));
  const speed = Math.round(clamp(Math.max(wavelength * 3, (Math.hypot(b.w, b.h) / 2 + AREA_RINGS * wavelength) / 5), 1, 3000));
  const effect = newEffect("ripple", newId("fx"), {
    wavelength,
    speed,
    strength: Math.max(2, Math.round(wavelength * 0.2)),
    rings: AREA_RINGS,
    centerX: round1(clamp(((b.x + b.w / 2) / size.w) * 100, 0, 100)),
    centerY: round1(clamp(((b.y + b.h / 2) / size.h) * 100, 0, 100)),
    ...values,
  });
  return commit(pic, effect, "a drop lands as it starts and its rings spread across the areas. Change the strength, ring spacing, speed, centre, crest light or add rain on the right.");
};

export const GLITCH_EFFECT = { id: "glitch-area", title: "Glitch", description: "The areas' own picture breaks up in digital bursts: strips jump sideways, the colours split, blocks break up and it flickers." };

/**
 * Glitch on areas: a 4 s layer of their own picture that glitches in bursts (about 2 a second), with
 * strips, jumps and colour split sized to the areas. `values` override any setting.
 */
export const glitchAreas = (regionIds: readonly string[], values: Values = {}): string | null => {
  const pic = areaPicture(GLITCH_EFFECT.title, regionIds, 4);
  if (!pic) return null;
  const { bounds: b } = pic;
  const effect = newEffect("glitch", newId("fx"), {
    slice: Math.round(clamp(b.h / 16, 4, 120)),
    shift: Math.round(clamp(b.w * 0.08, 8, 600)),
    split: Math.round(clamp(b.w * 0.012, 2, 60)),
    ...values,
  });
  return commit(pic, effect, "glitches in bursts, about 2 a second. Change how much, how often, the strips, colour split, blocks and scanlines on the right.");
};

/** The cards above, with what each does to the chosen areas. */
export const PICTURE_EFFECTS = [
  { ...RIPPLE_EFFECT, apply: rippleAreas },
  { ...GLITCH_EFFECT, apply: glitchAreas },
] as const;

export const pictureEffectFor = (id: string) => PICTURE_EFFECTS.find((e) => e.id === id);

/**
 * The effects a layer can carry (drawn by the engine's effect registry), described for people: what
 * each one does and every setting it has, with ranges and defaults. The inspector shows all of them;
 * every setting can be animated with keyframes.
 */
import { staticProp } from "./anim.ts";
import type { EffectInstance, Id, RGBA } from "./model.ts";

export interface EffectParamSpec {
  /** Omitted for numbers (most settings). */
  readonly kind?: "number";
  readonly key: string;
  readonly label: string;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit?: string;
  readonly help?: string;
}

/** A colour setting: sRGB 0..1 with straight alpha, like every colour a person picks. */
export interface EffectColorSpec {
  readonly kind: "color";
  readonly key: string;
  readonly label: string;
  readonly default: RGBA;
  readonly help?: string;
}

export type EffectSettingSpec = EffectParamSpec | EffectColorSpec;

export interface LayerEffectSpec {
  readonly title: string;
  readonly description: string;
  readonly params: readonly EffectSettingSpec[];
}

export const LAYER_EFFECTS: Readonly<Record<string, LayerEffectSpec>> = {
  "gaussian-blur": {
    title: "Blur",
    description: "Softens the layer.",
    params: [{ key: "radius", label: "Radius", default: 10, min: 0, max: 200, step: 0.5, unit: "px" }],
  },
  glow: {
    title: "Glow",
    description: "Bright parts spill soft light around them.",
    params: [
      { key: "radius", label: "Radius", default: 20, min: 0, max: 300, step: 1, unit: "px", help: "How far the glow spreads." },
      { key: "intensity", label: "Intensity", default: 1, min: 0, max: 5, step: 0.05 },
      { key: "threshold", label: "Only brighter than", default: 0, min: 0, max: 1, step: 0.01, help: "0: everything glows; higher: only the brightest parts." },
    ],
  },
  melt: {
    title: "Melt",
    description: "The picture sags and drips downward, leaving the top empty. Procedural: a look, not a simulation.",
    params: [
      { key: "amount", label: "Melted", default: 0, min: 0, max: 1, step: 0.01, help: "0 = as it is, 1 = slid all the way. Animate it to melt over time." },
      { key: "distance", label: "Slides down up to", default: 300, min: 10, max: 2000, step: 1, unit: "px" },
      { key: "drip", label: "Drips", default: 0.6, min: 0, max: 1, step: 0.01, help: "How far thin drips run ahead of the rest." },
      { key: "seed", label: "Variation", default: 1, min: 1, max: 99, step: 1, help: "A different pattern of slumps and drips." },
    ],
  },
  ripple: {
    title: "Ripple",
    description: "Rings of water spread across the picture from a point, bending it like light through water. Procedural: a look, not a simulation.",
    params: [
      { key: "strength", label: "Strength", default: 12, min: 0, max: 200, step: 0.5, unit: "px", help: "How far the waves bend the picture. 0 = calm water." },
      { key: "wavelength", label: "Ring spacing", default: 80, min: 4, max: 1000, step: 1, unit: "px", help: "Distance from one ring to the next." },
      { key: "speed", label: "Speed", default: 200, min: 1, max: 3000, step: 1, unit: "px/s", help: "How fast the rings spread outward." },
      { key: "decay", label: "Fades with distance", default: 0.3, min: 0, max: 1, step: 0.01, help: "0: the waves stay as strong all the way out; 1: they die away before the edges." },
      { key: "rings", label: "Rings", default: 0, min: 0, max: 30, step: 1, help: "How many rings each drop makes before the water calms. 0 = keeps rippling." },
      { key: "centerX", label: "Centre across", default: 50, min: 0, max: 100, step: 0.5, unit: "%", help: "Where the drop lands, from the left edge of the picture." },
      { key: "centerY", label: "Centre down", default: 50, min: 0, max: 100, step: 0.5, unit: "%", help: "Where the drop lands, from the top edge of the picture." },
      { key: "highlight", label: "Light on the crests", default: 0.3, min: 0, max: 2, step: 0.01, help: "Light catching the top of each wave. 0 = none." },
      { kind: "color", key: "highlightColor", label: "Crest light colour", default: [1, 1, 1, 1] },
      { key: "rain", label: "Rain", default: 0, min: 0, max: 10, step: 0.1, unit: "drops/s", help: "0: one drop, at the centre. Higher: raindrops land at random places, this many each second (the centre isn't used)." },
      { key: "seed", label: "Variation", default: 1, min: 1, max: 99, step: 1, help: "A different pattern of raindrops." },
    ],
  },
  glitch: {
    title: "Glitch",
    description: "Digital breakup in bursts: strips of the picture jump sideways, the colours split, blocks break up and the picture flickers. Procedural: a look, not a simulation.",
    params: [
      { key: "amount", label: "Amount", default: 0.6, min: 0, max: 1, step: 0.01, help: "0 = clean picture, 1 = the heaviest glitching. Animate it to glitch only at certain moments." },
      { key: "frequency", label: "Bursts per second", default: 2, min: 0.1, max: 20, step: 0.1, help: "How often a burst of glitching hits. High values glitch almost all the time." },
      { key: "shift", label: "Strips jump up to", default: 60, min: 0, max: 1000, step: 1, unit: "px" },
      { key: "slice", label: "Strip height", default: 24, min: 2, max: 400, step: 1, unit: "px", help: "How tall the jumping strips are. Blocks are twice this size." },
      { key: "split", label: "Colour split", default: 8, min: 0, max: 100, step: 0.5, unit: "px", help: "How far red and blue pull apart during a burst." },
      { key: "blocks", label: "Blocky breakup", default: 0.3, min: 0, max: 1, step: 0.01, help: "How many square blocks break up during a burst." },
      { key: "scanlines", label: "Scanlines", default: 0.2, min: 0, max: 1, step: 0.01, help: "Dark lines rolling across the picture, like an old screen. 0 = none." },
      { key: "seed", label: "Variation", default: 1, min: 1, max: 99, step: 1, help: "A different pattern of bursts and breaks." },
    ],
  },
};

/** True for a colour setting (shown with a colour picker), false for a number. */
export const isColorSetting = (p: EffectSettingSpec): p is EffectColorSpec => p.kind === "color";

/** A new effect with every setting at its default. */
export const newEffect = (type: string, id: Id, values: Readonly<Record<string, number | readonly number[]>> = {}): EffectInstance => {
  const spec = LAYER_EFFECTS[type];
  if (!spec) throw new Error(`Unknown effect "${type}".`);
  return { id, type, enabled: true, params: Object.fromEntries(spec.params.map((p) => [p.key, staticProp(values[p.key] ?? p.default)])) };
};

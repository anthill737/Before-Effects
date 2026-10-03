/**
 * The effects a layer can carry (drawn by the engine's effect registry), described for people: what
 * each one does and every setting it has, with ranges and defaults. The inspector shows all of them;
 * every setting can be animated with keyframes.
 */
import { staticProp } from "./anim.ts";
import type { EffectInstance, Id } from "./model.ts";

export interface EffectParamSpec {
  readonly key: string;
  readonly label: string;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly unit?: string;
  readonly help?: string;
}

export interface LayerEffectSpec {
  readonly title: string;
  readonly description: string;
  readonly params: readonly EffectParamSpec[];
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
};

/** A new effect with every setting at its default. */
export const newEffect = (type: string, id: Id, values: Readonly<Record<string, number>> = {}): EffectInstance => {
  const spec = LAYER_EFFECTS[type];
  if (!spec) throw new Error(`Unknown effect "${type}".`);
  return { id, type, enabled: true, params: Object.fromEntries(spec.params.map((p) => [p.key, staticProp(values[p.key] ?? p.default)])) };
};

/**
 * Every effect that isn't a light recipe, in one list: 3D blocks, breaking apart (real physics),
 * particles and picture effects. The Effects tab shows them beside the recipes; the Content step's
 * cards use the same list. Each one applies to the chosen areas the same way wherever it's picked.
 */
import { addParticles, BLOCK_EFFECTS, BREAK_EFFECTS, makeArea3D, PARTICLE_EFFECTS } from "./actions3d.ts";
import { MELT_EFFECT, meltAreas } from "./melt.ts";
import { animatePart } from "./parts.ts";
import { PICTURE_EFFECTS } from "./pictureEffects.ts";

export interface CatalogEffect {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Group in the Effects tab. */
  readonly group: string;
  /** Plain words people might search with. */
  readonly keywords: readonly string[];
  /** How it's made: "physical" (simulated) or "procedural" (by rule), with a short why. */
  readonly kind: string;
  /** Snow can fall over the whole picture; the rest need areas. */
  readonly needsAreas: boolean;
  readonly apply: (regionIds: readonly string[]) => string | null;
}

export const EFFECT_GROUPS = ["Blocks (3D)", "Breaking apart (3D)", "Moving parts (3D)", "Particles (3D)", "Picture effects"] as const;

export const CATALOG: readonly CatalogEffect[] = [
  ...BLOCK_EFFECTS.map((e) => ({
    id: e.id,
    title: e.title,
    description: e.description,
    group: "Blocks (3D)",
    keywords: ["blocks", "cubes", "tiles", "shifting", "pulsing", "extrude", "depth", "3d", ...(e.preset === "ripple" ? ["ripple", "radial", "rings"] : []), ...(e.preset === "wave" ? ["wave"] : []), ...(e.preset === "columns" ? ["columns", "pipes", "bars"] : []), ...(e.preset === "slats" ? ["slats", "louvres", "flipping", "turning"] : [])],
    kind: "procedural: blocks moved by rule (a pattern in time), not simulated",
    needsAreas: true,
    apply: (ids: readonly string[]) => makeArea3D(ids, false, "collapse", e.preset),
  })),
  ...BREAK_EFFECTS.map((e) => ({
    id: e.id,
    title: e.title,
    description: e.description,
    group: "Breaking apart (3D)",
    keywords: ["break", "breaking", "collapse", "crumble", "explode", "fracture", "destroy", "pieces", "physics", ...(e.preset === "shatter" ? ["shatter", "glass", "window", "smash"] : [])],
    kind: e.preset === "shatter" ? "physical: glass shards simulated with Rapier" : "physical: rigid pieces simulated with Rapier",
    needsAreas: true,
    apply: (ids: readonly string[]) => makeArea3D(ids, true, e.preset),
  })),
  {
    id: "spin-3d",
    title: "Spin (3D)",
    description: "Each chosen part turns right around in 3D — a column or panel spins about its middle, showing its sides, then settles back in place.",
    group: "Moving parts (3D)",
    keywords: ["spin", "rotate", "turn", "twist", "column", "pillar", "panel", "3d", "moving"],
    kind: "procedural: the part turns by rule in 3D (adjust it under Moving parts), not simulated",
    needsAreas: true,
    apply: (ids: readonly string[]) => {
      let last: string | null = null;
      for (const id of ids) last = animatePart(id, { motion: { kind: "turn", axis: "vertical", turns: 1 }, timing: { move: 2.5, hold: 0, back: false } }) ?? last;
      return last;
    },
  },
  ...PARTICLE_EFFECTS.map((e) => ({
    id: e.id,
    title: e.title,
    description: e.description,
    group: "Particles (3D)",
    keywords: ["particles", e.kind, ...(e.kind === "snow" ? ["winter", "christmas", "flakes"] : e.kind === "embers" ? ["fire", "glow", "sparks"] : e.kind === "sparks" ? ["electric", "fireworks"] : ["party", "celebration"])],
    kind: "procedural: particles placed by rule, not simulated",
    needsAreas: e.kind !== "snow",
    apply: (ids: readonly string[]) => addParticles(e.kind, ids),
  })),
  {
    id: MELT_EFFECT.id,
    title: MELT_EFFECT.title,
    description: MELT_EFFECT.description,
    group: "Picture effects",
    keywords: ["melt", "drip", "dripping", "sag", "liquid"],
    kind: "procedural: the picture is warped downward by rule, not simulated",
    needsAreas: true,
    apply: (ids: readonly string[]) => meltAreas(ids),
  },
  ...PICTURE_EFFECTS.map((e) => ({
    id: e.id,
    title: e.title,
    description: e.description,
    group: "Picture effects",
    keywords: e.id === "ripple-area" ? ["ripple", "water", "drop", "rain", "waves", "puddle", "liquid"] : ["glitch", "digital", "broken", "static", "tv", "distort", "corrupt", "haunted"],
    kind: "procedural: the picture is distorted by rule, not simulated",
    needsAreas: true,
    apply: (ids: readonly string[]) => e.apply(ids),
  })),
];

export const catalogEffect = (id: string): CatalogEffect | undefined => CATALOG.find((e) => e.id === id);

/** Effects matching everyday words (every word must appear in the title, description or keywords). */
export const searchCatalog = (q: string): CatalogEffect[] => {
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [...CATALOG];
  return CATALOG.filter((e) => {
    const hay = `${e.title} ${e.description} ${e.keywords.join(" ")}`.toLowerCase();
    return words.every((w) => hay.includes(w) || hay.includes(w.replace(/s$/, "")));
  });
};

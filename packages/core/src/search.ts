/**
 * Everyday-language search over recipes ("make this look like water", "glowing edges").
 * Matches keywords, synonyms and simple word stems, and says plainly when an outcome isn't built yet.
 */
import { listRecipes, type RecipeDef } from "./recipes.ts";

const SYNONYMS: Record<string, string[]> = {
  glow: ["glow", "glowing", "shine", "shiny", "bright", "luminous", "radiant", "light"],
  outline: ["outline", "edge", "edges", "border", "trace", "contour", "line", "lines", "frame"],
  water: ["water", "liquid", "wave", "waves", "ripple", "ripples", "flood", "ocean", "sea"],
  fire: ["fire", "flame", "flames", "burn", "burning", "lava", "ember"],
  crack: ["crack", "cracks", "break", "shatter", "crumble", "collapse", "fall", "destroy", "rebuild"],
  pulse: ["pulse", "beat", "music", "rhythm", "throb", "breathe", "bpm", "flash", "blink"],
  sequence: ["sequence", "after", "another", "cascade", "chase", "switch", "stagger", "order"],
  color: ["color", "colour", "paint", "fill", "tint", "wash", "red", "blue", "green", "orange", "purple", "pink", "yellow"],
  neon: ["neon", "sign", "flicker", "electric"],
  particles: ["particles", "sparks", "snow", "rain", "dust", "stars", "confetti"],
  depth: ["tunnel", "hole", "depth", "recess", "deep", "portal"],
};

const STOP = new Set(["make", "this", "these", "that", "look", "like", "the", "it", "a", "an", "with", "and", "into", "turn", "to", "of", "on", "up"]);

const norm = (w: string) =>
  w
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .replace(/(ing|ed|s)$/, "");

export interface SearchHit {
  readonly recipe: RecipeDef;
  readonly score: number;
}

export const searchRecipes = (query: string): SearchHit[] => {
  const words = query
    .split(/\s+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(norm);
  if (words.length === 0) return listRecipes().map((recipe) => ({ recipe, score: 0 }));
  const expanded = new Set<string>(words);
  for (const w of words) for (const group of Object.values(SYNONYMS)) if (group.map(norm).includes(w)) group.forEach((g) => expanded.add(norm(g)));
  return listRecipes()
    .map((recipe) => {
      const hay = [recipe.title, recipe.description, recipe.category, ...recipe.keywords].join(" ").split(/\s+/).map(norm);
      let score = 0;
      for (const w of expanded) if (hay.includes(w)) score += words.includes(w) ? 3 : 1;
      return { recipe, score };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score);
};

/** Outcome families from the capability register that people may ask for before a recipe exists. */
const PLANNED_OUTCOMES: Record<string, string> = {
  water: "Water and liquid looks are planned (milestones C–D).",
  fire: "Fire-like imagery is planned (milestones C–D).",
  crack: "Crack, fall apart and rebuild is planned (milestone D).",
  particles: "Particles, rain and snow are planned (milestones C–D).",
  depth: "Tunnel and depth illusions are planned (milestone D).",
};

/** A plain explanation when the request maps to an outcome that isn't built yet; otherwise null. */
export const plannedFor = (query: string): string | null => {
  const words = query.split(/\s+/).map(norm);
  for (const [k, label] of Object.entries(PLANNED_OUTCOMES)) if (words.some((w) => SYNONYMS[k]!.map(norm).includes(w))) return label;
  return null;
};

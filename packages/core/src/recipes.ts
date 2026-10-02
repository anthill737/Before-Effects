/**
 * Recipes: complete, editable creative outcomes ("Trace with light", "Light up one after another").
 *
 * A recipe is a pure, deterministic generator. Given a few creative parameters and target regions
 * (by role), it produces real layers: shapes, keyframes, effects. Nothing is a canned movie, and
 * everything it creates is visible and editable in the detailed tools.
 *
 * Hand edits to generated layers are recorded as overrides (see ops.ts). When the person changes
 * the recipe's simple controls, the layers are regenerated and every overridden property is carried
 * over, so custom work is never silently discarded. The UI shows which simple controls no longer
 * fully apply.
 */
import { z } from "zod";
import { current, type Draft, isDraft } from "immer";
import type { Composition, Id, Layer, PathData, Project, RecipeInstance, Region, RegionKind, RegionRef } from "./model.ts";
import { defineOp, OpError } from "./ops.ts";
import { refRegionIds } from "./areas.ts";
import { getAt, pathCovers, setAt } from "./paths.ts";
import type { Flicks } from "./time.ts";

export type RecipeCategory =
  | "light"
  | "water"
  | "fire"
  | "cracks"
  | "movement"
  | "patterns"
  | "depth"
  | "text"
  | "particles"
  | "transitions"
  | "color";

export interface RecipeParamSpec {
  readonly key: string;
  readonly label: string;
  readonly control: "slider" | "color" | "choice" | "toggle" | "seconds" | "seed" | "media" | "text" | "font";
  readonly default: unknown;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly choices?: readonly { readonly value: string; readonly label: string }[];
  readonly help?: string;
  /** Shown among the first three to five controls; the rest sit behind "More controls". */
  readonly primary?: boolean;
  /** Layer property paths this control drives, used to warn when hand edits override it. */
  readonly drives?: readonly string[];
  /** For "media" controls: which kinds of imported files can be chosen. */
  readonly accepts?: readonly ("image" | "video" | "audio")[];
}

export interface ResolvedTarget {
  readonly ref: RegionRef;
  readonly region: Region;
  /** Index within its role (stable per binding order). */
  readonly index: number;
}

export interface RecipeContext {
  readonly project: Project;
  readonly comp: Composition;
  readonly instanceId: Id;
  readonly params: Readonly<Record<string, unknown>>;
  readonly targets: readonly ResolvedTarget[];
  readonly startTime: Flicks;
}

export interface GeneratedLayer {
  /** Stable key within this recipe's output; the layer id is derived from it. */
  readonly role: string;
  readonly layer: Omit<Layer, "id" | "generatedBy">;
}

export interface RecipeDef {
  readonly id: string;
  /** Plain action name shown on buttons, e.g. "Trace with light". */
  readonly title: string;
  readonly category: RecipeCategory;
  readonly description: string;
  /** Everyday words for search ("glow", "outline", "neon", "edge"). */
  readonly keywords: readonly string[];
  /** Region kinds this recipe suits best (others still allowed). */
  readonly suits: readonly RegionKind[];
  readonly params: readonly RecipeParamSpec[];
  /** Default duration of the effect in seconds (used for the timeline clip). */
  readonly defaultSeconds: number;
  /** Pure and deterministic: same inputs → same layers. Ordered top-most first. */
  readonly generate: (ctx: RecipeContext) => readonly GeneratedLayer[];
}

// ---------------------------------------------------------------------------------------------

const registry = new Map<string, RecipeDef>();

export const registerRecipe = (...defs: RecipeDef[]): void => {
  for (const d of defs) registry.set(d.id, d);
};
export const getRecipe = (id: string): RecipeDef | undefined => registry.get(id);
export const listRecipes = (): RecipeDef[] => [...registry.values()];

export const defaultParams = (def: RecipeDef): Record<string, unknown> =>
  Object.fromEntries(def.params.map((p) => [p.key, p.default]));

/** Resolve role references to concrete regions in the project's active venue. */
export const resolveTargets = (project: Project, refs: readonly RegionRef[]): ResolvedTarget[] => {
  const vid = project.activeVenueId;
  const venue = vid ? project.venues[vid] : undefined;
  if (!vid || !venue) return [];
  const out: ResolvedTarget[] = [];
  for (const ref of refs) {
    const ids = refRegionIds(project, { ...ref, index: undefined } as RegionRef, vid);
    ids.forEach((rid, i) => {
      if (ref.index !== undefined && ref.index !== i) return;
      const region = venue.regions[rid];
      const { index: _drop, ...base } = ref;
      if (region) out.push({ ref: { ...base, index: i }, region, index: i });
    });
  }
  return out;
};

export const generatedLayerId = (instanceId: Id, role: string): Id => `${instanceId}__${role}`;

/** Which simple controls are partly overridden by hand edits (for the "customised" indicator). */
export const overriddenParams = (def: RecipeDef, inst: RecipeInstance): string[] => {
  const paths = Object.values(inst.overrides).flat();
  return def.params
    .filter((p) => p.drives?.some((d) => paths.some((o) => pathCovers(d, o) || pathCovers(o, d))))
    .map((p) => p.key);
};

const buildLayers = (project: Project, inst: RecipeInstance): Layer[] => {
  const def = getRecipe(inst.recipeId);
  if (!def) throw new OpError(`The "${inst.label}" recipe isn't available in this version.`);
  const comp = project.compositions[inst.compId];
  if (!comp) throw new OpError("The scene for this effect no longer exists.");
  const targets = resolveTargets(project, inst.targets);
  if (targets.length === 0 && def.suits.length > 0) {
    throw new OpError(`"${def.title}" needs at least one region. Select a window, edge or wall first.`);
  }
  return def
    .generate({ project, comp, instanceId: inst.id, params: { ...defaultParams(def), ...inst.params }, targets, startTime: inst.startTime })
    .map((g) => ({ ...g.layer, id: generatedLayerId(inst.id, g.role), generatedBy: { recipeInstanceId: inst.id, role: g.role } }));
};

/** Write (re)generated layers into the draft, preserving overridden properties. */
const syncGenerated = (d: Draft<Project>, inst: Draft<RecipeInstance>, layers: Layer[]): string[] => {
  const comp = d.compositions[inst.compId]!;
  const notes: string[] = [];
  const keep = new Set(layers.map((l) => l.id));
  // Remove layers the recipe no longer produces (detach them instead if they were customised).
  for (const [role, layerId] of Object.entries(inst.generated)) {
    if (keep.has(layerId)) continue;
    const old = comp.layers[layerId];
    if (old && (inst.overrides[layerId]?.length ?? 0) > 0) {
      delete old.generatedBy;
      notes.push(`Kept your customised layer "${old.name}" as a regular layer.`);
    } else if (old) {
      delete comp.layers[layerId];
      comp.layerOrder = comp.layerOrder.filter((x) => x !== layerId);
    }
    delete inst.generated[role];
    delete inst.overrides[layerId];
  }
  // Insert or update, keeping the recipe's layers together at the position of its first layer.
  const existingIdx = layers.map((l) => comp.layerOrder.indexOf(l.id)).filter((i) => i >= 0);
  let insertAt = existingIdx.length ? Math.min(...existingIdx) : 0;
  for (const fresh of layers) {
    const old = comp.layers[fresh.id];
    let next: Layer = fresh;
    if (old) {
      const overrides = inst.overrides[fresh.id] ?? [];
      if (overrides.length) {
        next = structuredClone(fresh);
        for (const path of overrides) {
          const raw = getAt(old, path);
          const v = isDraft(raw) ? current(raw) : raw;
          if (v !== undefined && !setAt(next, path, structuredClone(v))) notes.push(`A custom edit (${path}) no longer applies.`);
        }
      }
      comp.layers[fresh.id] = next as Draft<Layer>;
    } else {
      comp.layers[fresh.id] = next as Draft<Layer>;
      comp.layerOrder.splice(Math.min(insertAt, comp.layerOrder.length), 0, fresh.id);
      insertAt++;
    }
    inst.generated[next.generatedBy!.role] = fresh.id;
  }
  return notes;
};

// ---------------------------------------------------------------------------------------------
// Operations

const regionRef = z.object({ role: z.string().min(1), index: z.number().int().min(0).optional(), regionIds: z.array(z.string().min(1)).optional(), groupId: z.string().min(1).optional() });

export const recipeApply = defineOp({
  type: "recipe.apply",
  title: "Apply effect",
  description:
    "Apply a recipe (a complete editable creative effect such as 'edge-trace' or 'sequence-light-up') to regions by role. Creates real, editable layers.",
  args: z.object({
    instanceId: z.string().min(1),
    recipeId: z.string().min(1),
    compId: z.string().min(1),
    targets: z.array(regionRef).min(1),
    params: z.record(z.string(), z.unknown()).optional(),
    startTime: z.number().int().min(0).optional(),
    label: z.string().optional(),
  }),
  apply: (d, a) => {
    const def = getRecipe(a.recipeId);
    if (!def) throw new OpError(`There's no effect called "${a.recipeId}".`);
    if (d.recipes[a.instanceId]) throw new OpError("That effect was already applied.");
    const inst: RecipeInstance = {
      id: a.instanceId,
      recipeId: a.recipeId,
      compId: a.compId,
      label: a.label ?? def.title,
      targets: a.targets,
      params: { ...defaultParams(def), ...(a.params ?? {}) },
      generated: {},
      overrides: {},
      startTime: a.startTime ?? 0,
    };
    d.recipes[a.instanceId] = inst as Draft<RecipeInstance>;
    const layers = buildLayers(d as unknown as Project, inst);
    syncGenerated(d, d.recipes[a.instanceId]!, layers);
  },
  summarize: (a) => {
    const def = getRecipe(a.recipeId);
    return `Applied "${def?.title ?? a.recipeId}" to ${a.targets.map((t) => t.role).join(", ")}.`;
  },
});

export const recipeUpdate = defineOp({
  type: "recipe.update",
  title: "Adjust effect",
  description:
    "Change an applied recipe's creative controls, targets or start time. Regenerates its layers while preserving any properties the person customised by hand.",
  args: z.object({
    instanceId: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
    targets: z.array(regionRef).min(1).optional(),
    startTime: z.number().int().min(0).optional(),
    label: z.string().optional(),
  }),
  apply: (d, a) => {
    const inst = d.recipes[a.instanceId];
    if (!inst) throw new OpError("That effect no longer exists.");
    if (a.params) inst.params = { ...inst.params, ...a.params };
    if (a.targets) inst.targets = a.targets;
    if (a.startTime !== undefined) inst.startTime = a.startTime;
    if (a.label) inst.label = a.label;
    const layers = buildLayers(d as unknown as Project, inst as unknown as RecipeInstance);
    syncGenerated(d, inst, layers);
  },
  summarize: (a, p) => {
    const inst = p.recipes[a.instanceId];
    const keys = Object.keys(a.params ?? {});
    return `Adjusted "${inst?.label ?? "effect"}"${keys.length ? ` (${keys.join(", ")})` : ""}.`;
  },
});

export const recipeResetOverrides = defineOp({
  type: "recipe.resetOverrides",
  title: "Reset to effect settings",
  description: "Discard hand edits on an applied recipe's layers (optionally only some property paths) and regenerate.",
  args: z.object({ instanceId: z.string().min(1), paths: z.array(z.string()).optional() }),
  apply: (d, a) => {
    const inst = d.recipes[a.instanceId];
    if (!inst) throw new OpError("That effect no longer exists.");
    for (const lid of Object.keys(inst.overrides)) {
      inst.overrides[lid] = a.paths ? inst.overrides[lid]!.filter((p) => !a.paths!.some((x) => pathCovers(x, p))) : [];
      if (inst.overrides[lid]!.length === 0) delete inst.overrides[lid];
    }
    syncGenerated(d, inst, buildLayers(d as unknown as Project, inst as unknown as RecipeInstance));
  },
});

export const recipeRemove = defineOp({
  type: "recipe.remove",
  title: "Remove effect",
  description: "Remove an applied recipe and all the layers it generated.",
  args: z.object({ instanceId: z.string().min(1) }),
  apply: (d, a) => {
    const inst = d.recipes[a.instanceId];
    if (!inst) throw new OpError("That effect no longer exists.");
    const comp = d.compositions[inst.compId];
    if (comp) {
      for (const lid of Object.values(inst.generated)) {
        delete comp.layers[lid];
        comp.layerOrder = comp.layerOrder.filter((x) => x !== lid);
      }
    }
    delete d.recipes[a.instanceId];
  },
  summarize: (a, p) => `Removed "${p.recipes[a.instanceId]?.label ?? "effect"}".`,
});

export const recipeDetach = defineOp({
  type: "recipe.detach",
  title: "Convert to regular layers",
  description: "Keep an applied recipe's layers as ordinary layers and drop the simple controls.",
  args: z.object({ instanceId: z.string().min(1) }),
  apply: (d, a) => {
    const inst = d.recipes[a.instanceId];
    if (!inst) throw new OpError("That effect no longer exists.");
    const comp = d.compositions[inst.compId];
    if (comp) for (const lid of Object.values(inst.generated)) if (comp.layers[lid]) delete comp.layers[lid]!.generatedBy;
    delete d.recipes[a.instanceId];
  },
});

export const recipeOps = [recipeApply, recipeUpdate, recipeResetOverrides, recipeRemove, recipeDetach] as const;

export type { PathData };

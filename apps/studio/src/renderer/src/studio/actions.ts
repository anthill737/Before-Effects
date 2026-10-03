/**
 * High-level actions shared by the canvas action bar, the library, the assistant and keyboard
 * shortcuts. Each turns one creative intent into validated operations: one undo step each.
 */
import { type Binding, getRecipe, listRecipes, newId, type Project, type RecipeDef, type RegionKind, type RegionRef, snapToFrame } from "@be/core";
import { prepareLightning } from "./lightningSounds.ts";
import { addAssetLayer, analyseBeats, importMediaFiles, latestAsset } from "./media.ts";
import { activeVenue, currentComp, useStudio } from "./store.ts";

/** Recipes that suit the selected regions, best first. */
export const suggestedRecipes = (project: Project, regionIds: readonly string[]): RecipeDef[] => {
  const venue = activeVenue({ project });
  if (!venue || regionIds.length === 0) return [];
  const kinds = new Set(regionIds.map((id) => venue.regions[id]?.kind).filter((k): k is RegionKind => !!k));
  const edgeLike = [...kinds].every((k) => k === "roofline" || k === "edge");
  const many = regionIds.length > 1;
  const rank = (r: RecipeDef): number => {
    const music = !!latestAsset(["audio"]);
    const order = edgeLike
      ? ["edge-trace", "neon-outline", "text-on-surface"]
      : many
        ? ["sequence-light-up", ...(music ? ["move-with-beat"] : []), "pulse", "media-fill", "edge-trace", "color-wash", "neon-outline", "text-on-surface", "move-with-beat"]
        : ["edge-trace", ...(music ? ["move-with-beat"] : []), "pulse", "media-fill", "text-on-surface", "color-wash", "neon-outline", "sequence-light-up", "move-with-beat"];
    const i = order.indexOf(r.id);
    return i < 0 ? 99 : i;
  };
  return listRecipes()
    .filter((r) => [...kinds].some((k) => r.suits.includes(k)))
    .sort((a, b) => rank(a) - rank(b));
};

/**
 * How effects refer to the selected areas: the kind's role when the selection is exactly that
 * (e.g. all windows — follows the venue if the show is moved), a named group when it matches one,
 * otherwise the areas themselves. Areas are shared by every scene.
 */
const targetsFor = (project: Project, regionIds: readonly string[]): { refs: RegionRef[]; setup: Array<{ type: string; args: unknown }> } => {
  const venue = activeVenue({ project });
  if (!venue) return { refs: [], setup: [] };
  const binding: Binding = project.bindings[venue.id] ?? { venueId: venue.id, roles: {} };
  const sel = [...regionIds];
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));
  for (const [role, ids] of Object.entries(binding.roles)) if (same(ids, sel)) return { refs: [{ role }], setup: [] };
  const group = Object.values(venue.groups).find((g) => same(g.regionIds, sel));
  if (group) return { refs: [{ role: group.name, groupId: group.id }], setup: [] };
  return { refs: [{ role: "areas", regionIds: sel }], setup: [] };
};

/** Operations for applying a recipe to regions (shared by apply and hover-preview). */
export const recipeOpsFor = (recipeId: string, regionIds: readonly string[], instanceId: string, params?: Record<string, unknown>): { ops: Array<{ type: string; args: unknown }>; start: number } | null => {
  const s = useStudio.getState();
  const comp = currentComp(s);
  if (!s.project || !comp || regionIds.length === 0) return null;
  const { refs, setup } = targetsFor(s.project, regionIds);
  let start = snapToFrame(s.time, comp.frameRate);
  if (comp.duration - start < 2 * 705_600_000) start = 0;
  // Effects that follow the music start where the music starts.
  if (recipeId === "move-with-beat") start = 0;
  return { ops: [...setup, { type: "recipe.apply", args: { instanceId, recipeId, compId: comp.id, targets: refs, startTime: start, ...(params ? { params } : {}) } }], start };
};

/** Show what a recipe would look like on the selection without changing the project. */
export const previewRecipe = (recipeId: string | null): void => {
  const s = useStudio.getState();
  if (!recipeId || s.selection.regionIds.length === 0) return s.previewOps(null);
  const r = recipeOpsFor(recipeId, s.selection.regionIds, "rcp_preview");
  s.previewOps(r ? (r.ops as never) : null);
};

export const applyRecipeToSelection = (recipeId: string, regionIdsOverride?: readonly string[], params?: Record<string, unknown>): string | null => {
  const s = useStudio.getState();
  const comp = currentComp(s);
  const def = getRecipe(recipeId);
  if (!s.project || !comp || !def) return null;
  const regionIds = regionIdsOverride ?? s.selection.regionIds;
  if (regionIds.length === 0) {
    s.toast({ kind: "info", text: `Select one or more parts of the building first, then choose “${def.title}”.` });
    return null;
  }
  const instanceId = newId("rcp");
  // Starts at the playhead, unless that would leave too little room before the end of the show.
  const planned = recipeOpsFor(recipeId, regionIds, instanceId, params);
  if (!planned) return null;
  const { start } = planned;
  s.previewOps(null);
  const tx = s.apply(planned.ops as never, { label: def.title });
  if (!tx) return null;
  useStudio.setState({ selection: { regionIds: [], recipeId: instanceId, layerId: null }, time: start, playing: true });
  s.toast({ kind: "success", text: `Added “${def.title}”. Adjust it on the right — Ctrl+Z undoes it.` });
  return instanceId;
};

/**
 * Apply an effect, first gathering anything it needs from the person: a picture or video for
 * "Show a picture or video", music (with its beat found) for "Move with the beat", the crack and
 * thunder sounds for "Lightning & thunder".
 */
export const applyEffect = async (recipeId: string): Promise<string | null> => {
  const s = useStudio.getState();
  if (s.selection.regionIds.length === 0) return applyRecipeToSelection(recipeId);
  const regionIds = [...s.selection.regionIds];
  if (recipeId === "media-fill") {
    let a = latestAsset(["image", "video"]);
    if (!a) {
      s.toast({ kind: "info", text: "Choose a picture or video to show on the selected parts." });
      a = (await importMediaFiles()).find((x) => x.kind === "image" || x.kind === "video");
    }
    if (!a) return null;
    return applyRecipeToSelection(recipeId, regionIds, { assetId: a.id });
  }
  if (recipeId === "move-with-beat") {
    let a = latestAsset(["audio"]);
    if (!a) {
      s.toast({ kind: "info", text: "Choose the music to move with." });
      a = (await importMediaFiles()).find((x) => x.kind === "audio");
      if (!a) return null;
    }
    const comp = currentComp(useStudio.getState());
    const used = comp && Object.values(comp.layers).some((l) => (l.source.kind === "audio" || l.source.kind === "footage") && l.source.assetId === a!.id);
    if (!used) addAssetLayer(a, 0);
    const fresh = useStudio.getState().project?.assets[a.id];
    if (!fresh?.analysis) {
      s.toast({ kind: "info", text: `Finding the beat of “${a.name}”…` });
      if (!(await analyseBeats(a))) {
        s.toast({ kind: "error", text: "The beat couldn't be found in that music. Try another track." });
        return null;
      }
    }
    return applyRecipeToSelection(recipeId, regionIds, { musicId: a.id });
  }
  if (recipeId === "lightning") return applyRecipeToSelection(recipeId, regionIds, await prepareLightning());
  return applyRecipeToSelection(recipeId, regionIds);
};

/** All regions of the same kind as the given one (for "Select all 9 windows"). */
export const similarRegions = (project: Project, regionId: string): string[] => {
  const venue = activeVenue({ project });
  const r = venue?.regions[regionId];
  if (!venue || !r) return [];
  return venue.regionOrder.filter((id) => venue.regions[id]?.kind === r.kind);
};

export const KIND_LABEL: Record<RegionKind, [string, string]> = {
  window: ["window", "windows"],
  door: ["door", "doors"],
  garage: ["garage door", "garage doors"],
  wall: ["wall", "walls"],
  roof: ["roof", "roofs"],
  vent: ["vent", "vents"],
  light: ["light fixture", "light fixtures"],
  roofline: ["roofline", "rooflines"],
  column: ["column", "columns"],
  edge: ["edge", "edges"],
  exclusion: ["no-light area", "no-light areas"],
  custom: ["region", "regions"],
};

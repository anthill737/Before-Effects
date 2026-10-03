/**
 * Agent methods: the show, history, selection, building areas, media, content in areas, effects,
 * scenes, layers and their keyframes. Each one calls the same helpers and operations as the UI.
 */
import {
  regionHoles,
  hexToRgba,
  isColorSetting,
  LAYER_EFFECTS,
  type Layer,
  newEffect,
  type AnimProp,
  defaultParams,
  describeShow,
  effectCatalog,
  flattenPath,
  getRecipe,
  type Id,
  keyAt,
  newId,
  normalizeSettings,
  type Op,
  operationCatalog,
  polygonPath,
  type PropValue,
  type Region,
  resolveParts,
  resolveTargets,
  secondsToTime,
  setKeyEase,
  setPropAt,
  type ShowEntry,
  toggleKeyAt,
  snapToFrame,
  timeToSeconds,
  type Vec2,
} from "@be/core";
import { z } from "zod";
import { addRegion } from "../space/actions.ts";
import { KIND_CHOICES } from "../space/traceStore.ts";
import { recipeOpsFor } from "../studio/actions.ts";
import { assignMedia, refForAreas, replaceMedia } from "../studio/assign.ts";
import { ensureHits, prepareLightning } from "../studio/lightningAssets.ts";
import { analyseBeats, assetLayerOps, importMediaFiles } from "../studio/media.ts";
import { meltAreas } from "../studio/melt.ts";
import { glitchAreas, rippleAreas } from "../studio/pictureEffects.ts";
import { newEmptyScene, newSceneCopy, openShow, pickScene, showComp } from "../studio/ScenesBar.tsx";
import { activeVenue, currentComp, useStudio } from "../studio/store.ts";
import { AgentError, currentRevision, method } from "./core.ts";

const r2 = (n: number) => Math.round(n * 100) / 100;
const st = () => useStudio.getState();
const project = () => {
  const p = st().project;
  if (!p) throw new AgentError("no_project", "No show is open.");
  return p;
};
const venue = () => {
  const v = activeVenue({ project: project() });
  if (!v) throw new AgentError("not_found", "This show has no building yet. Create one with project.newFromPhoto.");
  return v;
};
const scene = () => {
  const c = currentComp(st());
  if (!c) throw new AgentError("not_found", "No scene is open.");
  return c;
};
const ctxFor = () => ({ compId: st().compId ?? "", timeSeconds: timeToSeconds(st().time), selectedRegionIds: st().selection.regionIds, selectedEffectId: st().selection.recipeId });

/** Areas by id, name, group name, kind ("windows") or "selected". Unknown names are an error, never guessed. */
export const areaIds = (refs: readonly string[]): Id[] => {
  const { ids, unknown } = resolveParts(project(), refs, ctxFor());
  if (unknown.length) throw new AgentError("not_found", `No area matches ${unknown.map((u) => `"${u}"`).join(", ")}. Use ids or names from areas.list.`);
  if (!ids.length) throw new AgentError("not_found", "No areas matched (is anything selected?).");
  return ids;
};

/** Media by id, file name or full path. */
const assetId = (ref: string): Id => {
  const p = project();
  if (p.assets[ref]) return ref;
  const lc = ref.toLowerCase();
  const a = Object.values(p.assets).find((x) => x.name.toLowerCase() === lc || x.originalPath?.toLowerCase() === lc || x.path.toLowerCase() === lc);
  if (!a) throw new AgentError("not_found", `No media "${ref}" in this show. Import it with assets.import, or use an id from assets.list.`);
  return a.id;
};

const sceneId = (ref: string | undefined): Id => {
  const p = project();
  if (!ref || ref === "current") return scene().id;
  if (ref === "show") {
    const s = showComp();
    if (!s) throw new AgentError("not_found", "There's no show yet. Arrange one with show.set.");
    return s.id;
  }
  if (p.compositions[ref]) return ref;
  const byName = Object.values(p.compositions).find((c) => c.name.toLowerCase() === ref.toLowerCase());
  if (!byName) throw new AgentError("not_found", `No scene "${ref}". Use ids or names from scenes.list.`);
  return byName.id;
};

const instance = (id: string) => {
  const inst = project().recipes[id];
  if (!inst) throw new AgentError("not_found", `No content or effect "${id}". Use ids from content.list or effects.list.`);
  return inst;
};

const points = z.array(z.tuple([z.number(), z.number()])).min(3);
const rect = z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() });
const rectPoints = (r: z.infer<typeof rect>): Vec2[] => [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
const kinds = z.enum(["window", "door", "garage", "wall", "roof", "roofline", "column", "vent", "light", "edge", "exclusion", "custom"]);

export const areaInfo = (r: Region, detail: boolean) => {
  const pts = flattenPath(r.path, 4);
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const v = venue();
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    closed: r.path.closed,
    bounds: { x: r2(Math.min(...xs)), y: r2(Math.min(...ys)), w: r2(Math.max(...xs) - Math.min(...xs)), h: r2(Math.max(...ys) - Math.min(...ys)) },
    groups: Object.values(v.groups).filter((g) => g.regionIds.includes(r.id)).map((g) => g.name),
    holes: regionHoles(r, v).length,
    ...(r.cutouts?.length ? { cutOut: r.cutouts.map((id) => v.regions[id]?.name ?? id) } : {}),
    ...(r.proposal ? { proposal: { score: r.proposal.score, outline: r.proposal.outline, ...(r.proposal.uncertain ? { check: r.proposal.uncertain } : {}) } } : {}),
    feather: r.feather ?? 0,
    expansion: r.expansion ?? 0,
    ...(detail ? { points: r.path.vertices.map((x) => x.p), holePoints: regionHoles(r, v).map((h) => h.vertices.map((x) => x.p)) } : {}),
  };
};

const contentInfo = (id: string) => {
  const p = project();
  const inst = p.recipes[id]!;
  const def = getRecipe(inst.recipeId);
  const params = { ...(def ? defaultParams(def) : {}), ...inst.params };
  return {
    id: inst.id,
    label: inst.label,
    effect: inst.recipeId,
    scene: inst.compId,
    areas: resolveTargets(p, inst.targets).map((t) => ({ id: t.region.id, name: t.region.name })),
    startSeconds: r2(timeToSeconds(inst.startTime)),
    settings: params,
    ...(typeof params.assetId === "string" ? { media: p.assets[params.assetId]?.name ?? params.assetId } : {}),
  };
};

// ---- project ---------------------------------------------------------------------------------------

method({
  name: "project.get",
  summary: "The open show: name, file, revision, scenes, building, selection, playhead, preview. detail='full' adds every area, effect, layer and media item.",
  params: z.object({ detail: z.enum(["summary", "full"]).optional() }),
  run: (p) => {
    const s = st();
    if (!s.project) return { open: false, revision: currentRevision() };
    const pr = s.project;
    const v = activeVenue({ project: pr });
    const c = currentComp(s);
    return {
      open: true,
      revision: currentRevision(),
      name: pr.name,
      path: s.filePath,
      dirty: s.dirty,
      scene: c ? { id: c.id, name: c.name, width: c.width, height: c.height, fps: r2(c.frameRate.num / c.frameRate.den), seconds: r2(timeToSeconds(c.duration)), isShow: !!c.show } : null,
      scenes: pr.compositionOrder.map((id) => ({ id, name: pr.compositions[id]!.name, isShow: !!pr.compositions[id]!.show })),
      building: v ? { id: v.id, name: v.name, canvas: v.canvas, photo: v.referenceAssetId ? pr.assets[v.referenceAssetId]?.name : null, areas: v.regionOrder.length, groups: Object.keys(v.groups).length, projectors: v.projectorOrder.length } : null,
      scenes3d: Object.values(pr.scenes3d ?? {}).map((x) => ({ id: x.id, name: x.name, objects: x.objectOrder.length })),
      selection: { areas: s.selection.regionIds, effect: s.selection.recipeId, layer: s.selection.layerId },
      playheadSeconds: r2(timeToSeconds(s.time)),
      playing: s.playing,
      ...(p.detail === "full" ? { show: describeShow(pr, ctxFor()), areas: v ? v.regionOrder.map((id) => areaInfo(v.regions[id]!, false)) : [] } : {}),
    };
  },
});

method({
  name: "project.save",
  summary: "Save the show (to its file, or to `path`; default Documents\\Before Effects\\Projects\\<name>.beproj).",
  params: z.object({ path: z.string().optional() }),
  run: async (p) => {
    const pr = project();
    const { serialize } = await import("../studio/persistence.ts");
    const dir = (await window.be.app.paths()).projects;
    const path = p.path ?? st().filePath ?? `${dir}\\${pr.name.replace(/[\\/:*?"<>|]/g, "_")}.beproj`;
    const r = await window.be.files.saveProject(serialize(pr), path);
    if (!r) throw new AgentError("rejected", `Couldn't save to ${path}.`);
    st().markSaved(r.path, r.savedAt);
    return { path: r.path, savedAt: r.savedAt, revision: currentRevision() };
  },
});

method({
  name: "project.open",
  summary: "Open a saved show (.beproj). Refuses if the open show has unsaved changes unless discardChanges is true.",
  params: z.object({ path: z.string(), discardChanges: z.boolean().optional() }),
  mutates: true,
  long: true,
  run: async (p) => {
    if (st().dirty && !p.discardChanges) throw new AgentError("unsaved_changes", "The open show has unsaved changes. Save it first (project.save) or pass discardChanges: true.");
    const opened = await window.be.files.openProject(p.path);
    if (!opened) throw new AgentError("not_found", `No show at ${p.path}.`);
    const { deserialize } = await import("../studio/persistence.ts");
    st().openProject(deserialize(opened.json), p.path);
    return { opened: p.path, revision: currentRevision() };
  },
});

method({
  name: "project.newFromPhoto",
  summary: "Start a new show from a photo of the building (JPG, PNG). The photo is the tracing guide; it isn't projected.",
  params: z.object({ photo: z.string(), discardChanges: z.boolean().optional() }),
  mutates: true,
  long: true,
  run: async (p) => {
    if (st().dirty && !p.discardChanges) throw new AgentError("unsaved_changes", "The open show has unsaved changes. Save it first or pass discardChanges: true.");
    const { createProjectFromPhoto } = await import("../space/actions.ts");
    if (!(await createProjectFromPhoto({ path: p.photo, dataUrl: "" }))) throw new AgentError("rejected", `That photo couldn't be opened: ${p.photo}.`);
    return { building: venue().canvas, revision: currentRevision() };
  },
});

// ---- history and selection -----------------------------------------------------------------------

method({
  name: "history.undo",
  summary: "Undo the latest step(s) — whoever made them, as the editor's Undo does.",
  params: z.object({ steps: z.number().int().min(1).max(50).optional() }),
  mutates: true,
  run: (p) => {
    const h = st().history!;
    const undone: string[] = [];
    for (let i = 0; i < (p.steps ?? 1); i++) {
      const tx = h.undo();
      if (!tx) break;
      undone.push(tx.label);
    }
    if (!undone.length) throw new AgentError("rejected", "There's nothing to undo.");
    return { undone, revision: currentRevision() };
  },
});

method({
  name: "history.redo",
  summary: "Redo the latest undone step(s).",
  params: z.object({ steps: z.number().int().min(1).max(50).optional() }),
  mutates: true,
  run: (p) => {
    const h = st().history!;
    const redone: string[] = [];
    for (let i = 0; i < (p.steps ?? 1); i++) {
      const tx = h.redo();
      if (!tx) break;
      redone.push(tx.label);
    }
    if (!redone.length) throw new AgentError("rejected", "There's nothing to redo.");
    return { redone, revision: currentRevision() };
  },
});

method({
  name: "history.list",
  summary: "The undo list (latest last): label and who made each step.",
  params: z.object({}),
  run: () => {
    const h = st().history;
    return { canUndo: !!h?.canUndo, canRedo: !!h?.canRedo, steps: (h?.transactions() ?? []).slice(-50).map((t) => ({ label: t.label, source: t.source, at: new Date(t.at).toISOString() })) };
  },
});

method({
  name: "selection.get",
  summary: "What's selected in the editor (areas, effect/content, layer).",
  params: z.object({}),
  run: () => {
    const s = st().selection;
    const v = st().project ? activeVenue({ project: st().project! }) : undefined;
    return { areas: s.regionIds.map((id) => ({ id, name: v?.regions[id]?.name })), effect: s.recipeId, layer: s.layerId };
  },
});

method({
  name: "selection.set",
  summary: "Select areas, an effect/content item or a layer in the editor (the person sees it).",
  params: z.object({ areas: z.array(z.string()).optional(), effect: z.string().optional(), layer: z.string().optional() }),
  run: (p) => {
    if (p.areas) st().selectRegions(p.areas.length ? areaIds(p.areas) : []);
    else if (p.effect) st().selectRecipe(instance(p.effect).id);
    else if (p.layer) st().selectLayer(p.layer);
    return { selected: st().selection };
  },
});

// ---- areas ---------------------------------------------------------------------------------------

method({
  name: "areas.list",
  summary: "Building areas (shared by every scene): id, name, kind, bounds in canvas pixels, groups, holes. detail adds the outline points.",
  params: z.object({ detail: z.boolean().optional() }),
  run: (p) => {
    const v = venue();
    return { canvas: v.canvas, areas: v.regionOrder.map((id) => areaInfo(v.regions[id]!, !!p.detail)), groups: Object.values(v.groups).map((g) => ({ id: g.id, name: g.name, areas: g.regionIds })) };
  },
});

method({
  name: "areas.create",
  summary: "Add a building area from a rectangle or an outline (canvas pixels). It's shared by every scene.",
  params: z.object({ kind: kinds, name: z.string().optional(), rect: rect.optional(), points: points.optional(), holes: z.array(points).optional(), feather: z.number().min(0).max(500).optional(), expansion: z.number().min(-500).max(500).optional(), select: z.boolean().optional() }),
  mutates: true,
  example: { kind: "window", name: "Left window", rect: { x: 820, y: 400, w: 260, h: 190 } },
  run: (p, ctx) => {
    const pts = p.points ?? (p.rect ? rectPoints(p.rect) : null);
    if (!pts) throw new AgentError("invalid_params", "Pass rect {x,y,w,h} or points [[x,y], …] in canvas pixels.");
    const v = venue();
    const id = ctx.edit(() => addRegion(polygonPath(pts), p.kind));
    if (!id) throw new AgentError("rejected", "The area couldn't be added.");
    const changes: Record<string, unknown> = {};
    if (p.name) changes.name = p.name;
    if (p.holes) changes.holes = p.holes.map((h) => polygonPath(h));
    if (p.feather !== undefined) changes.feather = p.feather;
    if (p.expansion !== undefined) changes.expansion = p.expansion;
    if (Object.keys(changes).length) ctx.edit(() => st().apply({ type: "region.update", args: { venueId: v.id, regionId: id, changes } }, { label: "Set up area" }));
    if (p.select === false) st().selectRegions([]);
    return { area: areaInfo(venue().regions[id]!, false), revision: currentRevision() };
  },
});

method({
  name: "areas.update",
  summary: "Rename, re-classify, reshape (rect or points), cut holes, or set the soft edge / grow-shrink of a shared building area. Every scene follows.",
  params: z.object({ area: z.string(), name: z.string().optional(), kind: kinds.optional(), rect: rect.optional(), points: points.optional(), holes: z.array(points).optional(), feather: z.number().min(0).max(500).optional(), expansion: z.number().min(-500).max(500).optional() }),
  mutates: true,
  run: (p, ctx) => {
    const v = venue();
    const [id] = areaIds([p.area]);
    const changes: Record<string, unknown> = {};
    if (p.name) changes.name = p.name;
    if (p.kind) changes.kind = p.kind;
    const pts = p.points ?? (p.rect ? rectPoints(p.rect) : null);
    if (pts) changes.path = polygonPath(pts);
    if (p.holes) changes.holes = p.holes.map((h) => polygonPath(h));
    if (p.feather !== undefined) changes.feather = p.feather;
    if (p.expansion !== undefined) changes.expansion = p.expansion;
    if (!Object.keys(changes).length) throw new AgentError("invalid_params", "Nothing to change.");
    ctx.edit(() => st().apply({ type: "region.update", args: { venueId: v.id, regionId: id!, changes } }, { label: "Change area" }));
    return { area: areaInfo(venue().regions[id!]!, false), revision: currentRevision() };
  },
});

method({
  name: "areas.delete",
  summary: "Remove building areas (from every scene).",
  params: z.object({ areas: z.array(z.string()).min(1) }),
  mutates: true,
  run: (p, ctx) => {
    const v = venue();
    const ids = areaIds(p.areas);
    ctx.edit(() => st().apply(ids.map((regionId) => ({ type: "region.remove", args: { venueId: v.id, regionId } })), { label: ids.length > 1 ? `Remove ${ids.length} areas` : "Remove area" }));
    return { removed: ids, revision: currentRevision() };
  },
});

method({
  name: "groups.set",
  summary: "Create or update a named group of areas (e.g. 'Upstairs windows'). Content on a group follows its members.",
  params: z.object({ name: z.string().min(1), areas: z.array(z.string()).min(1), id: z.string().optional() }),
  mutates: true,
  run: (p, ctx) => {
    const v = venue();
    const existing = p.id ? v.groups[p.id] : Object.values(v.groups).find((g) => g.name.toLowerCase() === p.name.toLowerCase());
    const group = { id: existing?.id ?? newId("grp"), name: p.name, regionIds: areaIds(p.areas) };
    ctx.edit(() => st().apply({ type: "group.set", args: { venueId: v.id, group } }, { label: `Group “${p.name}”` }));
    return { group, revision: currentRevision() };
  },
});

method({
  name: "groups.delete",
  summary: "Remove a group (its areas stay).",
  params: z.object({ group: z.string() }),
  mutates: true,
  run: (p, ctx) => {
    const v = venue();
    const g = v.groups[p.group] ?? Object.values(v.groups).find((x) => x.name.toLowerCase() === p.group.toLowerCase());
    if (!g) throw new AgentError("not_found", `No group "${p.group}".`);
    ctx.edit(() => st().apply({ type: "group.remove", args: { venueId: v.id, groupId: g.id } }, { label: "Ungroup" }));
    return { removed: g.id, revision: currentRevision() };
  },
});

// ---- media -----------------------------------------------------------------------------------------

method({
  name: "assets.list",
  summary: "Imported media: id, name, kind, size, duration, sound, missing.",
  params: z.object({}),
  run: () =>
    Object.values(project().assets).map((a) => ({
      id: a.id,
      name: a.name,
      kind: a.kind,
      width: a.meta.width,
      height: a.meta.height,
      seconds: a.meta.duration ? r2(timeToSeconds(a.meta.duration)) : undefined,
      sound: !!a.audioPath || a.kind === "audio",
      bpm: a.analysis ? r2(a.analysis.bpm) : undefined,
      hits: a.analysis?.hits?.length ? a.analysis.hits.map((h) => ({ atSeconds: r2(timeToSeconds(h.at)), peakSeconds: r2(timeToSeconds(h.peak)), level: h.level })) : undefined,
      missing: !!a.missing,
      reference: venue().referenceAssetId === a.id,
    })),
});

method({
  name: "assets.import",
  summary: "Import pictures, video or music by file path (copied into the show's media folder; originals untouched).",
  params: z.object({ paths: z.array(z.string()).min(1).max(100) }),
  mutates: true,
  long: true,
  run: async (p) => {
    const added = await importMediaFiles(p.paths, { quiet: true });
    if (!added.length) throw new AgentError("rejected", "None of those files could be imported (missing, or not a picture, video or sound).");
    return { imported: added.map((a) => ({ id: a.id, name: a.name, kind: a.kind })), revision: currentRevision() };
  },
});

// ---- content in areas ------------------------------------------------------------------------------

const AREA_CONTENT = "area-content";
const contentSettings = (raw: Record<string, unknown> | undefined) => {
  const def = getRecipe(AREA_CONTENT)!;
  const { params, problems } = normalizeSettings(def, raw);
  if (problems.length) throw new AgentError("invalid_params", problems.join(" "));
  return params;
};

method({
  name: "content.assign",
  summary: "Put a picture or video into areas of the current scene, clipped to them. mode 'each' repeats it per area; 'across' spans one image across them.",
  params: z.object({
    asset: z.string(),
    areas: z.array(z.string()).min(1),
    mode: z.enum(["each", "across"]).optional(),
    settings: z.record(z.string(), z.unknown()).optional().describe("fit, scale, offsetX, offsetY, rotation, cropL/R/T/B, trim, speed, loop, volume, opacity, blend, feather, expansion, fadeIn, fadeOut, seconds"),
    startSeconds: z.number().min(0).optional(),
  }),
  mutates: true,
  example: { asset: "swirl.mp4", areas: ["Window 1", "Window 2"], mode: "across", settings: { fit: "fill", loop: true } },
  run: (p, ctx) => {
    const ids = areaIds(p.areas);
    const aid = assetId(p.asset);
    const extra = contentSettings(p.settings);
    const id = ctx.edit(() => assignMedia(aid, ids, p.mode ?? "each", extra));
    if (!id) throw new AgentError("rejected", "That media couldn't be put into those areas.");
    if (p.startSeconds !== undefined) ctx.edit(() => st().apply({ type: "recipe.update", args: { instanceId: id, startTime: snapToFrame(secondsToTime(p.startSeconds!), scene().frameRate) } }, { label: "Set start time" }));
    return { content: contentInfo(id), revision: currentRevision() };
  },
});

method({
  name: "content.list",
  summary: "Content and effects in the current (or given) scene, optionally only those on one area.",
  params: z.object({ scene: z.string().optional(), area: z.string().optional() }),
  run: (p) => {
    const sid = sceneId(p.scene);
    const area = p.area ? areaIds([p.area])[0] : undefined;
    return Object.values(project().recipes)
      .filter((r) => r.compId === sid && (!area || resolveTargets(project(), r.targets).some((t) => t.region.id === area)))
      .map((r) => contentInfo(r.id));
  },
});

method({
  name: "content.update",
  summary: "Adjust content in this scene only: placement (fit, scale, offset, rotation, crop), timing (startSeconds, seconds, trim, speed, loop, fades), look (opacity, blend, feather) and sound (volume). For other effects use effects.update.",
  params: z.object({ id: z.string(), settings: z.record(z.string(), z.unknown()).optional(), startSeconds: z.number().min(0).optional() }),
  mutates: true,
  run: (p, ctx) => {
    const inst = instance(p.id);
    if (inst.recipeId !== AREA_CONTENT) throw new AgentError("invalid_params", `"${inst.label}" is an effect; use effects.update.`);
    const params = contentSettings(p.settings);
    ctx.edit(() =>
      st().apply(
        { type: "recipe.update", args: { instanceId: inst.id, ...(Object.keys(params).length ? { params } : {}), ...(p.startSeconds !== undefined ? { startTime: snapToFrame(secondsToTime(p.startSeconds), scene().frameRate) } : {}) } },
        { label: `Adjust “${inst.label}”` },
      ),
    );
    return { content: contentInfo(inst.id), revision: currentRevision() };
  },
});

method({
  name: "content.replace",
  summary: "Swap the picture/video of content, keeping its placement and timing (this scene only).",
  params: z.object({ id: z.string(), asset: z.string() }),
  mutates: true,
  run: (p, ctx) => {
    const inst = instance(p.id);
    const aid = assetId(p.asset);
    ctx.edit(() => replaceMedia(inst.id, aid));
    return { content: contentInfo(inst.id), revision: currentRevision() };
  },
});

method({
  name: "content.copyTo",
  summary: "Copy content to other areas (repeat or span), as an independent copy.",
  params: z.object({ id: z.string(), areas: z.array(z.string()).min(1), mode: z.enum(["each", "across"]).optional() }),
  mutates: true,
  run: async (p, ctx) => {
    const { copyAssignment } = await import("../studio/assign.ts");
    const id = ctx.edit(() => copyAssignment(instance(p.id).id, areaIds(p.areas), p.mode));
    if (!id) throw new AgentError("rejected", "It couldn't be copied there.");
    return { content: contentInfo(id), revision: currentRevision() };
  },
});

// ---- effects -----------------------------------------------------------------------------------

method({
  name: "effects.catalog",
  summary: "Effects that can be put on areas, with their settings (ids, ranges, choices). Also '3d.collapse' via scene3d.createFromAreas.",
  params: z.object({}),
  run: () => effectCatalog(),
});

method({
  name: "effects.apply",
  summary: "Put an effect (e.g. edge-trace, pulse, smoke-rising) on areas of the current scene.",
  params: z.object({ effect: z.string(), areas: z.array(z.string()).min(1), settings: z.record(z.string(), z.unknown()).optional(), startSeconds: z.number().min(0).optional(), name: z.string().optional() }),
  mutates: true,
  example: { effect: "edge-trace", areas: ["Wall 1"], settings: { color: "#ffd27a", lapSeconds: 3 } },
  run: async (p, ctx) => {
    const def = getRecipe(p.effect);
    if (!def) throw new AgentError("not_found", `No effect "${p.effect}". See effects.catalog.`);
    const ids = areaIds(p.areas);
    const { params, problems } = normalizeSettings(def, p.settings);
    if (problems.length) throw new AgentError("invalid_params", problems.join(" "));
    // Music-driven: like the editor, find the beat and make sure the music is in the scene.
    const musicOps = def.id === "move-with-beat" ? await prepareMusic(params) : [];
    // Lightning: the chosen crack and thunder sounds are analysed (their hits found); missing ones are made.
    if (def.id === "lightning") Object.assign(params, await prepareLightning(soundIds(params)));
    const instanceId = newId("rcp");
    const planned = recipeOpsFor(def.id, ids, instanceId, params);
    if (!planned) throw new AgentError("rejected", "That effect can't be planned for those areas.");
    const ops = planned.ops.map((o) =>
      o.type === "recipe.apply"
        ? { ...o, args: { ...(o.args as object), ...(p.startSeconds !== undefined ? { startTime: snapToFrame(secondsToTime(p.startSeconds), scene().frameRate) } : {}), ...(p.name ? { label: p.name } : {}) } }
        : o,
    ) as Op[];
    ctx.edit(() => st().apply([...musicOps, ...ops], { label: `Add ${def.title}` }));
    return { effect: contentInfo(instanceId), ...(musicOps.length ? { note: "The music wasn't in this scene, so it was added from the start (as the editor does)." } : {}), revision: currentRevision() };
  },
});

/** Media settings (sounds, the white house picture, a bolt clip) given by name or path become media ids. */
const soundIds = (params: Record<string, unknown>): Record<string, unknown> => {
  for (const key of ["crackSound", "thunderSound", "flashPicture", "boltClip"]) if (typeof params[key] === "string" && params[key]) params[key] = assetId(params[key] as string);
  return params;
};

/**
 * For "Move with the beat": resolve the music (settings.musicId, else the scene's music), find its
 * beat if that hasn't been done yet, and return the operation that adds it to the scene if it isn't
 * there (the effect follows the music where it sits on the timeline).
 */
const prepareMusic = async (params: Record<string, unknown>): Promise<Op[]> => {
  const comp = scene();
  const p = project();
  const given = typeof params.musicId === "string" && params.musicId ? assetId(params.musicId) : undefined;
  const inScene = comp.layerOrder.map((id) => comp.layers[id]?.source).find((s) => s?.kind === "audio");
  const id = given ?? (inScene?.kind === "audio" ? inScene.assetId : undefined);
  if (!id) throw new AgentError("rejected", "Move with the beat needs music: import it with assets.import and pass settings.musicId (or add music to this scene first).");
  const asset = p.assets[id]!;
  if (asset.kind !== "audio" && !asset.audioPath) throw new AgentError("rejected", `“${asset.name}” has no sound to find a beat in.`);
  params.musicId = id;
  if (!asset.analysis?.beats.length) {
    const found = await analyseBeats(asset);
    if (!found?.beats.length) throw new AgentError("rejected", `No beat could be found in “${asset.name}”. Try other music.`);
  }
  const placed = comp.layerOrder.some((lid) => {
    const s = comp.layers[lid]?.source;
    return (s?.kind === "audio" || s?.kind === "footage") && s.assetId === id;
  });
  if (placed) return [];
  const made = assetLayerOps(st().project!.assets[id]!, 0);
  if (!made) throw new AgentError("rejected", "The music couldn't be added to this scene.");
  return made.ops;
};

method({
  name: "effects.update",
  summary: "Change an effect's settings, start time or areas (this scene only).",
  params: z.object({ id: z.string(), settings: z.record(z.string(), z.unknown()).optional(), startSeconds: z.number().min(0).optional(), areas: z.array(z.string()).optional(), name: z.string().optional() }),
  mutates: true,
  run: async (p, ctx) => {
    const inst = instance(p.id);
    const def = getRecipe(inst.recipeId)!;
    const { params, problems } = normalizeSettings(def, p.settings);
    if (problems.length) throw new AgentError("invalid_params", problems.join(" "));
    if (def.id === "lightning")
      for (const key of ["crackSound", "thunderSound"]) {
        const id = soundIds(params)[key];
        const a = typeof id === "string" ? project().assets[id] : undefined;
        if (a) await ensureHits(a);
      }
    const args: Record<string, unknown> = { instanceId: inst.id };
    if (Object.keys(params).length) args.params = params;
    if (p.startSeconds !== undefined) args.startTime = snapToFrame(secondsToTime(p.startSeconds), scene().frameRate);
    if (p.areas) args.targets = [refForAreas(areaIds(p.areas))];
    if (p.name) args.label = p.name;
    if (Object.keys(args).length === 1) throw new AgentError("invalid_params", "Nothing to change.");
    ctx.edit(() => st().apply({ type: "recipe.update", args }, { label: `Adjust “${inst.label}”` }));
    return { effect: contentInfo(inst.id), revision: currentRevision() };
  },
});

method({
  name: "effects.remove",
  summary: "Remove content or an effect from its scene.",
  params: z.object({ id: z.string() }),
  mutates: true,
  run: (p, ctx) => {
    const inst = instance(p.id);
    ctx.edit(() => st().apply({ type: "recipe.remove", args: { instanceId: inst.id } }, { label: `Remove “${inst.label}”` }));
    return { removed: inst.id, revision: currentRevision() };
  },
});

// ---- scenes and the show -------------------------------------------------------------------------

method({
  name: "scenes.list",
  summary: "Scenes (every one uses the same building areas) and the show.",
  params: z.object({}),
  run: () => {
    const p = project();
    return p.compositionOrder.map((id) => {
      const c = p.compositions[id]!;
      return { id, name: c.name, seconds: r2(timeToSeconds(c.duration)), isShow: !!c.show, current: id === st().compId, content: Object.values(p.recipes).filter((r) => r.compId === id).length, layers: c.layerOrder.length };
    });
  },
});

method({
  name: "scenes.open",
  summary: "Switch the editor to a scene (or 'show').",
  params: z.object({ scene: z.string() }),
  run: (p) => {
    pickScene(sceneId(p.scene));
    return { scene: st().compId };
  },
});

method({
  name: "scenes.duplicate",
  summary: "Copy a scene (same areas, independent content) and open the copy. Swapping content in the copy never changes the original.",
  params: z.object({ scene: z.string().optional(), name: z.string().optional() }),
  mutates: true,
  run: (p, ctx) => {
    pickScene(sceneId(p.scene));
    const id = ctx.edit(() => newSceneCopy());
    if (!id) throw new AgentError("rejected", "That scene can't be duplicated (the show itself can't).");
    if (p.name) ctx.edit(() => st().apply({ type: "comp.update", args: { compId: id, changes: { name: p.name } } }, { label: "Rename scene" }));
    return { scene: { id, name: project().compositions[id]!.name }, revision: currentRevision() };
  },
});

method({
  name: "scenes.create",
  summary: "Add an empty scene (same areas, no content) and open it.",
  params: z.object({ name: z.string().optional() }),
  mutates: true,
  run: (p, ctx) => {
    const id = ctx.edit(() => newEmptyScene());
    if (!id) throw new AgentError("rejected", "The scene couldn't be added.");
    if (p.name) ctx.edit(() => st().apply({ type: "comp.update", args: { compId: id, changes: { name: p.name } } }, { label: "Rename scene" }));
    return { scene: { id, name: project().compositions[id]!.name }, revision: currentRevision() };
  },
});

method({
  name: "scenes.update",
  summary: "Rename a scene or change its length.",
  params: z.object({ scene: z.string(), name: z.string().optional(), seconds: z.number().min(0.5).max(36000).optional() }),
  mutates: true,
  run: (p, ctx) => {
    const id = sceneId(p.scene);
    const changes: Record<string, unknown> = {};
    if (p.name) changes.name = p.name;
    if (p.seconds !== undefined) changes.duration = secondsToTime(p.seconds);
    ctx.edit(() => st().apply({ type: "comp.update", args: { compId: id, changes } }, { label: "Change scene" }));
    return { scene: id, revision: currentRevision() };
  },
});

method({
  name: "scenes.delete",
  summary: "Delete a scene.",
  params: z.object({ scene: z.string() }),
  mutates: true,
  run: (p, ctx) => {
    const id = sceneId(p.scene);
    const p2 = project();
    if (p2.compositionOrder.filter((x) => !p2.compositions[x]!.show).length <= 1 && !p2.compositions[id]!.show) throw new AgentError("rejected", "A show needs at least one scene.");
    if (st().compId === id) pickScene(p2.compositionOrder.find((x) => x !== id)!);
    ctx.edit(() => st().apply({ type: "comp.remove", args: { compId: id } }, { label: "Delete scene" }));
    return { removed: id, revision: currentRevision() };
  },
});

method({
  name: "show.get",
  summary: "The show's running order: scenes, how long each plays, how each arrives (cut or crossfade).",
  params: z.object({}),
  run: () => {
    const s = showComp();
    return s ? { id: s.id, seconds: r2(timeToSeconds(s.duration)), entries: s.show!.entries.map((e) => ({ ...e, name: project().compositions[e.sceneId]?.name })) } : { id: null, entries: [] };
  },
});

method({
  name: "show.set",
  summary: "Arrange the show: scenes in order with seconds and transition ('cut' or 'fade' with fadeSeconds). Creates the show if needed.",
  params: z.object({ entries: z.array(z.object({ scene: z.string(), seconds: z.number().min(0.5).max(36000), transition: z.enum(["cut", "fade"]).optional(), fadeSeconds: z.number().min(0).max(60).optional() })).min(1) }),
  mutates: true,
  run: (p, ctx) => {
    const entries: ShowEntry[] = p.entries.map((e, i) => ({ sceneId: sceneId(e.scene), seconds: e.seconds, transition: i === 0 ? "cut" : (e.transition ?? "fade"), fadeSeconds: e.fadeSeconds ?? 1 }));
    const existing = showComp();
    const showId = existing?.id ?? newId("show");
    ctx.edit(() => st().apply({ type: "show.set", args: { showId, ...(existing ? {} : { name: "Show", makeMain: true }), entries } }, { label: "Arrange the show" }));
    if (!existing) void openShow;
    return { show: showId, revision: currentRevision() };
  },
});

// ---- layers and keyframes ----------------------------------------------------------------------------

const LAYER_PROPS: Record<string, string> = { opacity: "transform.opacity", position: "transform.position", scale: "transform.scale", rotation: "transform.rotation", anchor: "transform.anchor", volume: "audio.volume", pan: "audio.pan" };

const layerOf = (sid: string, ref: string) => {
  const c = project().compositions[sid]!;
  const l = c.layers[ref] ?? Object.values(c.layers).find((x) => x.name.toLowerCase() === ref.toLowerCase());
  if (!l) throw new AgentError("not_found", `No layer "${ref}" in "${c.name}". Use ids from layers.list.`);
  return l;
};
const propOf = (layer: object, path: string): AnimProp => {
  let v: unknown = layer;
  for (const k of path.split(".")) v = (v as Record<string, unknown> | undefined)?.[k];
  if (!v || typeof v !== "object" || !("value" in v)) throw new AgentError("not_found", `That layer has no animatable "${path}".`);
  return v as AnimProp;
};

method({
  name: "layers.list",
  summary: "Layers of a scene (top first): id, name, kind, timing, transform values, which properties are animated, and which effect made it.",
  params: z.object({ scene: z.string().optional() }),
  run: (p) => {
    const c = project().compositions[sceneId(p.scene)]!;
    return c.layerOrder.map((id) => {
      const l = c.layers[id]!;
      const animated = Object.entries(LAYER_PROPS).filter(([, path]) => {
        try {
          return (propOf(l, path).keyframes?.length ?? 0) > 0;
        } catch {
          return false;
        }
      }).map(([k]) => k);
      return {
        id,
        name: l.name,
        kind: l.source.kind,
        enabled: l.enabled,
        fromSeconds: r2(timeToSeconds(l.inPoint)),
        toSeconds: r2(timeToSeconds(l.outPoint)),
        opacity: l.transform.opacity.value,
        position: l.transform.position.value,
        scale: l.transform.scale.value,
        rotation: l.transform.rotation.value,
        animated,
        madeBy: l.generatedBy?.recipeInstanceId ?? null,
      };
    });
  },
});

method({
  name: "layers.update",
  summary: "Show/hide, rename or retime a layer (seconds).",
  params: z.object({ scene: z.string().optional(), layer: z.string(), name: z.string().optional(), enabled: z.boolean().optional(), fromSeconds: z.number().min(0).optional(), toSeconds: z.number().min(0).optional(), blend: z.enum(["normal", "add", "screen", "multiply"]).optional() }),
  mutates: true,
  run: (p, ctx) => {
    const sid = sceneId(p.scene);
    const l = layerOf(sid, p.layer);
    const changes: Record<string, unknown> = {};
    if (p.name) changes.name = p.name;
    if (p.enabled !== undefined) changes.enabled = p.enabled;
    if (p.fromSeconds !== undefined) changes.inPoint = secondsToTime(p.fromSeconds);
    if (p.toSeconds !== undefined) changes.outPoint = secondsToTime(p.toSeconds);
    if (p.blend) changes.blendMode = p.blend;
    ctx.edit(() => st().apply({ type: "layer.update", args: { compId: sid, layerId: l.id, changes } }, { label: `Change “${l.name}”` }));
    return { layer: l.id, revision: currentRevision() };
  },
});

method({
  name: "keyframes.set",
  summary: "Animate a layer property: set its value at a time (seconds), adding a keyframe (the property becomes animated). ease: ease | linear | ease-in | ease-out | hold, for motion leaving this key.",
  params: z.object({
    scene: z.string().optional(),
    layer: z.string(),
    property: z.enum(["opacity", "position", "scale", "rotation", "anchor", "volume", "pan"]),
    seconds: z.number().min(0),
    value: z.union([z.number(), z.array(z.number())]),
    ease: z.enum(["ease", "linear", "ease-in", "ease-out", "hold"]).optional(),
  }),
  mutates: true,
  example: { layer: "Text", property: "opacity", seconds: 2, value: 0, ease: "ease" },
  run: (p, ctx) => {
    const sid = sceneId(p.scene);
    const l = layerOf(sid, p.layer);
    const path = LAYER_PROPS[p.property]!;
    const prop = propOf(l, path);
    const t = snapToFrame(secondsToTime(p.seconds), project().compositions[sid]!.frameRate);
    const like = prop.value as PropValue;
    const value = typeof like === "number" ? (Array.isArray(p.value) ? p.value[0]! : p.value) : Array.isArray(p.value) ? like.map((x, i) => (p.value as number[])[i] ?? x) : like.map(() => p.value as number);
    // A still property starts animating with its current value as a key at the layer's start.
    let next: AnimProp = prop.keyframes?.length ? prop : toggleKeyAt(prop, l.inPoint);
    next = setPropAt(next, t, value);
    if (p.ease) {
      const k = keyAt(next, t);
      if (k) next = setKeyEase(next, k.id, p.ease);
    }
    ctx.edit(() => st().apply({ type: "prop.setAnimation", args: { compId: sid, layerId: l.id, path, keyframes: [...(next.keyframes ?? [])] } }, { label: `Animate ${p.property} of “${l.name}”` }));
    const now = propOf(layerOf(sid, l.id), path);
    return { layer: l.id, property: p.property, keyframes: (now.keyframes ?? []).map((k) => ({ seconds: r2(timeToSeconds(k.t)), value: k.v, out: k.out })), revision: currentRevision() };
  },
});

method({
  name: "keyframes.list",
  summary: "Keyframes of a layer property (seconds, value, easing out).",
  params: z.object({ scene: z.string().optional(), layer: z.string(), property: z.enum(["opacity", "position", "scale", "rotation", "anchor", "volume", "pan"]) }),
  run: (p) => {
    const prop = propOf(layerOf(sceneId(p.scene), p.layer), LAYER_PROPS[p.property]!);
    return { value: prop.value, keyframes: (prop.keyframes ?? []).map((k) => ({ seconds: r2(timeToSeconds(k.t)), value: k.v, in: k.in, out: k.out })) };
  },
});

method({
  name: "keyframes.remove",
  summary: "Remove the keyframe at a time (or all keyframes with all: true, keeping the current value).",
  params: z.object({ scene: z.string().optional(), layer: z.string(), property: z.enum(["opacity", "position", "scale", "rotation", "anchor", "volume", "pan"]), seconds: z.number().min(0).optional(), all: z.boolean().optional() }),
  mutates: true,
  run: (p, ctx) => {
    const sid = sceneId(p.scene);
    const l = layerOf(sid, p.layer);
    const path = LAYER_PROPS[p.property]!;
    const prop = propOf(l, path);
    const t = p.seconds !== undefined ? snapToFrame(secondsToTime(p.seconds), project().compositions[sid]!.frameRate) : -1;
    const keep = p.all ? [] : (prop.keyframes ?? []).filter((k) => Math.abs(k.t - t) > 1000);
    if (!p.all && keep.length === (prop.keyframes?.length ?? 0)) throw new AgentError("not_found", "No keyframe at that time.");
    ctx.edit(() => st().apply({ type: "prop.setAnimation", args: { compId: sid, layerId: l.id, path, keyframes: keep.length >= 1 ? keep : [] } }, { label: `Remove keyframe` }));
    return { layer: l.id, remaining: keep.length, revision: currentRevision() };
  },
});

// ---- layer effects (blur, glow, melt, ripple, glitch) -------------------------------------------------------

const effectOf = (l: Layer, ref: string) => {
  const e = l.effects.find((x) => x.id === ref) ?? l.effects.find((x) => x.type === ref || LAYER_EFFECTS[x.type]?.title.toLowerCase() === ref.toLowerCase());
  if (!e) throw new AgentError("not_found", `“${l.name}” has no effect "${ref}" (see layers.effects).`);
  return e;
};

/** An effect setting as an agent gives it: a number, or for a colour "#rrggbb" or [r, g, b, a] (0–1). */
const settingValue = z.union([z.number(), z.string(), z.array(z.number()).min(3).max(4)]);

/** Check a value fits the setting (a number for numbers, a colour for colours) and convert it. */
const toSetting = (type: string, key: string, v: z.infer<typeof settingValue>): PropValue => {
  const sp = LAYER_EFFECTS[type]?.params.find((x) => x.key === key);
  if (sp && isColorSetting(sp)) {
    const c = typeof v === "string" ? hexToRgba(v) : Array.isArray(v) ? [v[0]!, v[1]!, v[2]!, v[3] ?? 1] : null;
    if (!c) throw new AgentError("invalid_params", `"${key}" is a colour: give "#rrggbb" or [r, g, b, a] with values 0–1.`);
    return c.map((x) => Math.min(1, Math.max(0, x)));
  }
  if (typeof v !== "number") throw new AgentError("invalid_params", `"${key}" takes a number${sp ? ` (${sp.min}–${sp.max}${sp.unit ? ` ${sp.unit}` : ""})` : ""}.`);
  return v;
};

/** Starting values for a new effect; an unknown setting is an error, never ignored. */
const toSettings = (type: string, values: Readonly<Record<string, z.infer<typeof settingValue>>> = {}): Record<string, PropValue> => {
  const keys = (LAYER_EFFECTS[type]?.params ?? []).map((x) => x.key);
  return Object.fromEntries(
    Object.entries(values).map(([k, v]) => {
      if (!keys.includes(k)) throw new AgentError("invalid_params", `${LAYER_EFFECTS[type]?.title ?? type} has no setting "${k}" (it has ${keys.join(", ")}).`);
      return [k, toSetting(type, k, v)];
    }),
  );
};

method({
  name: "layers.effects",
  summary: `A layer's effects with every setting: value now, range (or kind "color": [r, g, b, a] 0–1), and keyframes if animated. Types: ${Object.entries(LAYER_EFFECTS).map(([t, e]) => `${t} (${e.title}: ${e.params.map((x) => x.key).join(", ")})`).join("; ")}.`,
  params: z.object({ scene: z.string().optional(), layer: z.string() }),
  run: (p) => {
    const l = layerOf(sceneId(p.scene), p.layer);
    return l.effects.map((e) => ({
      id: e.id,
      type: e.type,
      enabled: e.enabled,
      params: Object.entries(e.params).map(([k, prop]) => {
        const sp = LAYER_EFFECTS[e.type]?.params.find((x) => x.key === k);
        const range = sp && !isColorSetting(sp) ? sp : undefined;
        return { key: k, label: sp?.label ?? k, kind: sp && isColorSetting(sp) ? "color" : "number", value: prop.value, min: range?.min, max: range?.max, unit: range?.unit ?? null, keyframes: (prop.keyframes ?? []).map((kf) => ({ seconds: r2(timeToSeconds(kf.t)), value: kf.v })) };
      }),
    }));
  },
});

method({
  name: "layers.effectAdd",
  summary: `Add an effect to a layer (${Object.keys(LAYER_EFFECTS).join(", ")}) with optional starting values for its settings (colours as "#rrggbb").`,
  params: z.object({ scene: z.string().optional(), layer: z.string(), type: z.enum(Object.keys(LAYER_EFFECTS) as [string, ...string[]]), values: z.record(z.string(), settingValue).optional() }),
  mutates: true,
  example: { layer: "Logo", type: "glitch", values: { amount: 0.8, frequency: 4 } },
  run: (p, ctx) => {
    const sid = sceneId(p.scene);
    const l = layerOf(sid, p.layer);
    const e = newEffect(p.type, newId("fx"), toSettings(p.type, p.values));
    ctx.edit(() => st().apply({ type: "layer.update", args: { compId: sid, layerId: l.id, changes: { effects: [...l.effects, e] } } }, { label: `Add ${LAYER_EFFECTS[p.type]!.title.toLowerCase()}` }));
    return { layer: l.id, effect: e.id, revision: currentRevision() };
  },
});

method({
  name: "layers.effectSet",
  summary: "Change an effect setting (effect by id or type; colours as \"#rrggbb\"). With seconds: set it at that time as a keyframe (animating it). Also turn the effect on/off.",
  params: z.object({ scene: z.string().optional(), layer: z.string(), effect: z.string(), param: z.string().optional(), value: settingValue.optional(), seconds: z.number().min(0).optional(), enabled: z.boolean().optional() }),
  mutates: true,
  example: { layer: "Melt — Window", effect: "melt", param: "amount", seconds: 3, value: 1 },
  run: (p, ctx) => {
    const sid = sceneId(p.scene);
    const l = layerOf(sid, p.layer);
    const e = effectOf(l, p.effect);
    if (p.enabled !== undefined) ctx.edit(() => st().apply({ type: "layer.update", args: { compId: sid, layerId: l.id, changes: { effects: l.effects.map((x) => (x.id === e.id ? { ...x, enabled: p.enabled! } : x)) } } }, { label: "Turn effect on/off" }));
    if (p.param !== undefined) {
      if (p.value === undefined) throw new AgentError("invalid_params", "Give a value for the setting.");
      const prop = e.params[p.param];
      if (!prop) throw new AgentError("not_found", `The effect has no setting "${p.param}" (it has ${Object.keys(e.params).join(", ")}).`);
      const path = `effects.${e.id}.params.${p.param}`;
      const value = toSetting(e.type, p.param, p.value);
      if (p.seconds !== undefined) {
        const t = snapToFrame(secondsToTime(p.seconds), project().compositions[sid]!.frameRate);
        let next: AnimProp = prop.keyframes?.length ? prop : toggleKeyAt(prop, l.inPoint);
        next = setPropAt(next, t, value);
        ctx.edit(() => st().apply({ type: "prop.setAnimation", args: { compId: sid, layerId: l.id, path, keyframes: [...(next.keyframes ?? [])] } }, { label: "Animate effect setting" }));
      } else ctx.edit(() => st().apply({ type: "prop.set", args: { compId: sid, layerId: l.id, path, value } }, { label: "Change effect setting" }));
    }
    return { layer: l.id, effect: e.id, revision: currentRevision() };
  },
});

method({
  name: "layers.effectRemove",
  summary: "Remove an effect from a layer (by id or type).",
  params: z.object({ scene: z.string().optional(), layer: z.string(), effect: z.string() }),
  mutates: true,
  run: (p, ctx) => {
    const sid = sceneId(p.scene);
    const l = layerOf(sid, p.layer);
    const e = effectOf(l, p.effect);
    ctx.edit(() => st().apply({ type: "layer.update", args: { compId: sid, layerId: l.id, changes: { effects: l.effects.filter((x) => x.id !== e.id) } } }, { label: "Remove effect" }));
    return { layer: l.id, revision: currentRevision() };
  },
});

method({
  name: "effects.melt",
  summary: "Melt areas: their own photo is projected back onto them, then sags and drips downward (0.5–3.5 s into a 6 s layer), leaving darkness. Procedural. Adjust with layers.effectSet (melt: amount, distance, drip, seed).",
  params: z.object({ areas: z.array(z.string()).min(1) }),
  mutates: true,
  run: (p, ctx) => {
    const ids = areaIds(p.areas);
    const layerId = ctx.edit(() => meltAreas(ids));
    if (!layerId) throw new AgentError("rejected", "Melt needs the building photo and at least one area.");
    return { layer: layerId, revision: currentRevision() };
  },
});

method({
  name: "effects.ripple",
  summary: `Ripple areas: their own photo is projected back onto them and a drop lands at their middle when the 6 s layer starts (the playhead); rings of water spread across it, bending the picture, then calm. Procedural, no keyframes needed. Optional starting values; adjust later with layers.effectSet (ripple: ${LAYER_EFFECTS.ripple!.params.map((x) => x.key).join(", ")}).`,
  params: z.object({ areas: z.array(z.string()).min(1), values: z.record(z.string(), settingValue).optional() }),
  mutates: true,
  example: { areas: ["Garage door"], values: { rain: 4, highlightColor: "#9fd8ff" } },
  run: (p, ctx) => {
    const ids = areaIds(p.areas);
    const values = toSettings("ripple", p.values);
    const layerId = ctx.edit(() => rippleAreas(ids, values));
    if (!layerId) throw new AgentError("rejected", "Ripple needs the building photo and at least one area.");
    return { layer: layerId, revision: currentRevision() };
  },
});

method({
  name: "effects.glitch",
  summary: `Glitch areas: their own photo is projected back onto them for 4 s from the playhead and breaks up in seeded digital bursts (strips jump sideways, colours split, blocks break, flicker, scanlines). Procedural, no keyframes needed. Optional starting values; adjust later with layers.effectSet (glitch: ${LAYER_EFFECTS.glitch!.params.map((x) => x.key).join(", ")}).`,
  params: z.object({ areas: z.array(z.string()).min(1), values: z.record(z.string(), settingValue).optional() }),
  mutates: true,
  example: { areas: ["Window"], values: { amount: 0.8, frequency: 4 } },
  run: (p, ctx) => {
    const ids = areaIds(p.areas);
    const values = toSettings("glitch", p.values);
    const layerId = ctx.edit(() => glitchAreas(ids, values));
    if (!layerId) throw new AgentError("rejected", "Glitch needs the building photo and at least one area.");
    return { layer: layerId, revision: currentRevision() };
  },
});

// ---- low-level operations ------------------------------------------------------------------------------

method({
  name: "ops.list",
  summary: "Every low-level editing operation with its JSON Schema (the same ones the UI uses).",
  params: z.object({}),
  run: () => operationCatalog(st().history!.registry),
});

method({
  name: "ops.apply",
  summary: "Apply low-level operations atomically as one undo step (see ops.list). Prefer the higher-level methods.",
  params: z.object({ operations: z.array(z.object({ type: z.string(), args: z.unknown() })).min(1).max(500), label: z.string().optional() }),
  mutates: true,
  run: (p, ctx) => {
    const h = st().history!;
    const bad = p.operations.find((o) => !h.registry.has(o.type));
    if (bad) throw new AgentError("invalid_params", `Unknown operation "${bad.type}". See ops.list.`);
    ctx.edit(() => st().apply(p.operations as Op[], { label: p.label ?? `${p.operations.length} change${p.operations.length > 1 ? "s" : ""}` }));
    return { applied: p.operations.length, revision: currentRevision() };
  },
});

// Kind names a person would use (for areas.create docs).
export const AREA_KINDS = KIND_CHOICES.map((k) => ({ kind: k.kind, label: k.label }));

// ---- the building photo ------------------------------------------------------------------------------

method({
  name: "venue.get",
  summary: "The building: canvas size, the original photo (kept unchanged), how it's placed in the canvas, projectors.",
  params: z.object({}),
  run: () => {
    const v = venue();
    const p = project();
    const photo = v.photo ? p.assets[v.photo.assetId] : undefined;
    return {
      id: v.id,
      name: v.name,
      canvas: v.canvas,
      photo: photo ? { name: photo.name, width: photo.meta.width, height: photo.meta.height, original: photo.sourceFile ?? photo.originalPath ?? photo.path, placement: v.photo!.placement } : null,
      reference: v.referenceAssetId ? p.assets[v.referenceAssetId]?.name : null,
      projectors: v.projectorOrder.map((id) => ({ id, name: v.projectors[id]!.name, output: v.projectors[id]!.output })),
    };
  },
});

method({
  name: "venue.placePhoto",
  summary: "Place the building photo in the canvas without stretching: fit ('fit' shows all, 'fill' covers), scale % (100 = as fitted), offsetX/offsetY px, crop fractions per edge (0–0.45). Traced areas don't move.",
  params: z.object({ fit: z.enum(["fit", "fill"]).optional(), scale: z.number().min(10).max(1000).optional(), offsetX: z.number().optional(), offsetY: z.number().optional(), crop: z.object({ left: z.number().min(0).max(0.45), right: z.number().min(0).max(0.45), top: z.number().min(0).max(0.45), bottom: z.number().min(0).max(0.45) }).partial().optional() }),
  mutates: true,
  long: true,
  run: async (p, ctx) => {
    const v = venue();
    if (!v.photo) throw new AgentError("rejected", "This building has no photo to place.");
    const { placementOps } = await import("../space/photoPlacement.ts");
    const ops = await placementOps({ ...(p.fit ? { fit: p.fit } : {}), ...(p.scale !== undefined ? { scale: p.scale } : {}), ...(p.offsetX !== undefined ? { offsetX: p.offsetX } : {}), ...(p.offsetY !== undefined ? { offsetY: p.offsetY } : {}), ...(p.crop ? { crop: { ...v.photo.placement.crop, ...p.crop } } : {}) });
    if (!ops) throw new AgentError("rejected", "The photo couldn't be placed.");
    ctx.edit(() => st().apply(ops, { label: "Place the photo" }));
    return { placement: venue().photo!.placement, revision: currentRevision() };
  },
});

/**
 * Effects simulated in Blender (smoke, fire, water, cloth) and linked .blend files, from the
 * editor: build the exchange, run Blender in the background (progress, cancel), and put the
 * result in the scene as a video layer that sits exactly on the canvas. "Open in Blender" lets you
 * edit the .blend; "Update" renders it again, keeping those edits.
 */
import {
  type Asset,
  BLENDER_EFFECTS,
  type BlenderEffectKind,
  type BlenderLink,
  buildExchange,
  checkOwners,
  type Composition,
  type ExchangeObject,
  type Id,
  newId,
  newLayer,
  type Op,
  preparedObstacles,
  type Project,
  resolveScene3DLayer,
  secondsToTime,
  timeToSeconds,
} from "@be/core";
import { create } from "zustand";
import { getRenderer } from "./engineHost.ts";
import { activeVenue, currentComp, useStudio } from "./store.ts";

/** Blender jobs running now (by link id). */
export const useBlenderJobs = create<Record<string, { stage: string; done: number; total: number; error?: string; running: boolean }>>(() => ({}));

let hooked = false;
const hook = () => {
  if (hooked) return;
  hooked = true;
  window.be.blender.onProgress((p) => useBlenderJobs.setState((s) => ({ ...s, [p.jobId]: { ...(s[p.jobId] ?? { running: true }), stage: p.stage, done: p.done, total: p.total, running: true } })));
};

export const STAGES: Record<string, string> = { prepare: "Preparing the 3D physics", build: "Building the Blender scene", bake: "Simulating in Blender", render: "Rendering in Blender", video: "Making the video" };

const dirFor = async (projectId: Id, linkId: Id) => `${(await window.be.app.paths()).media}\\${projectId.replace(/[^\w.-]+/g, "_")}\\blender\\${linkId}`;

/** The video asset for a finished render (probed so its size, length and transparency are known). */
const videoAsset = async (path: string, name: string): Promise<Asset> => {
  const m = await window.be.media.probe(path);
  return {
    id: newId("asset"),
    kind: "video",
    name,
    path,
    meta: { width: m.width, height: m.height, frameRate: m.frameRate, frameCount: m.frames, duration: secondsToTime(m.durationSeconds), hasAlpha: m.hasAlpha, codec: m.codec },
  };
};

const resultLayer = (asset: Asset, link: BlenderLink, comp: { width: number; height: number }) => {
  const w = asset.meta.width ?? comp.width, h = asset.meta.height ?? comp.height;
  const k = comp.width / w;
  const base = newLayer({ id: newId("layer"), name: link.name, source: { kind: "footage", assetId: asset.id }, start: secondsToTime(link.startSeconds), duration: secondsToTime(link.seconds) });
  return { ...base, transform: { ...base.transform, anchor: { value: [w / 2, h / 2, 0] }, position: { value: [comp.width / 2, comp.height / 2, 0], spatial: true }, scale: { value: [k * 100, k * 100, 100] } } };
};

/**
 * Physics Before Effects prepared (Rapier) in 3D layers on screen during the effect: their moving
 * bodies go to Blender as played-back obstacles (waiting for the motion to finish preparing).
 */
const preparedFor = async (project: Project, comp: Composition, venueId: Id, link: BlenderLink, fps: number) => {
  const physics = (await getRenderer()).physics;
  if (!physics) return undefined;
  const objects: ExchangeObject[] = [];
  const regionIds: Id[] = [];
  for (const l of Object.values(comp.layers)) {
    if (l.source.kind !== "scene3d" || !l.enabled) continue;
    if (timeToSeconds(l.outPoint) <= link.startSeconds || timeToSeconds(l.inPoint) >= link.startSeconds + link.seconds) continue;
    const r = resolveScene3DLayer(project, comp.id, l.id);
    if (!r?.physics) continue;
    const motion = await physics.ensure(r.physics);
    const x = preparedObstacles(project, venueId, r, motion, { layerName: l.name, layerStartSeconds: timeToSeconds(l.startTime), startSeconds: link.startSeconds, frames: Math.max(1, Math.round(link.seconds * fps)), fps });
    objects.push(...x.objects);
    regionIds.push(...x.regionIds);
  }
  return objects.length ? { objects, regionIds } : undefined;
};

/** Run a link's Blender job and put (or replace) its result in the scene. One undo step at the end. */
const runLink = async (link: BlenderLink, mode: "build" | "render"): Promise<{ ok: true; linkId: Id } | { ok: false; message: string; code?: string }> => {
  hook();
  const s = useStudio.getState();
  const project = s.project!;
  const comp = project.compositions[link.compId];
  const venue = activeVenue({ project });
  if (!comp || !venue) return { ok: false, message: "The scene or the building is missing." };
  const fps = comp.frameRate.num / comp.frameRate.den;
  const dir = await dirFor(project.id, link.id);
  const output = { blend: link.blendFile ?? `${dir}\\effect.blend`, frames: `${dir}\\frames`, cache: `${dir}\\cache` };
  let exchange: Record<string, unknown> & { fps: number; frames: number; output: typeof output };
  if (link.origin === "effect" && mode === "build") {
    const ref = venue.referenceAssetId ? project.assets[venue.referenceAssetId] : undefined;
    useBlenderJobs.setState((j) => ({ ...j, [link.id]: { stage: "prepare", done: 0, total: 1, running: true } }));
    const prepared = await preparedFor(project, comp, venue.id, link, fps);
    const x = buildExchange(project, link, { venueId: venue.id, canvas: venue.canvas, fps, ...(ref ? { photo: ref.path } : {}), output, ...(prepared ? { prepared } : {}) });
    const problems = checkOwners(x);
    if (problems.length) return { ok: false, message: problems.join(" ") };
    exchange = x as unknown as typeof exchange;
  } else {
    // Re-render the .blend as it is (keeping edits made in Blender). A linked file keeps its own
    // first frame and size (half size as a draft); an effect's .blend already has the show's.
    exchange = { fps, frames: Math.max(1, Math.round(link.seconds * fps)), output, ...(link.origin === "linked" ? { linked: true, scale: link.quality === "full" ? 1 : 0.5 } : {}) };
  }
  useBlenderJobs.setState((j) => ({ ...j, [link.id]: { stage: mode === "build" ? "build" : "bake", done: 0, total: 1, running: true } }));
  const video = `${dir}\\${link.name.replace(/[<>:"/\\|?*]+/g, "-")} ${Date.now().toString(36)}.mov`;
  const r = await window.be.blender.run(link.id, { mode, exchange, video });
  if (!r.ok) {
    // Cancelling isn't a failure: nothing to report.
    useBlenderJobs.setState((j) => ({ ...j, [link.id]: r.code === "cancelled" ? { stage: "cancelled", done: 0, total: 1, running: false } : { stage: "failed", done: 0, total: 1, error: r.message, running: false } }));
    return { ok: false, message: r.message, code: r.code };
  }
  useBlenderJobs.setState((j) => ({ ...j, [link.id]: { stage: "done", done: 1, total: 1, running: false } }));
  const asset = await videoAsset(r.video, link.name);
  const now = useStudio.getState();
  const c = now.project!.compositions[link.compId]!;
  const existing = link.layerId ? c.layers[link.layerId] : undefined;
  const ops: Op[] = [{ type: "asset.add", args: { asset } }];
  let layerId = link.layerId;
  if (existing && existing.source.kind === "footage") {
    ops.push({ type: "layer.replace", args: { compId: c.id, layer: { ...existing, source: { kind: "footage", assetId: asset.id } } } });
    // The previous render leaves the media list unless something else still shows it (its file stays, for undo).
    const old = link.result?.assetId;
    const usedElsewhere = Object.values(now.project!.compositions).some((cc) => Object.values(cc.layers).some((l) => l.id !== existing.id && l.source.kind === "footage" && l.source.assetId === old));
    if (old && old !== asset.id && now.project!.assets[old] && !usedElsewhere) ops.push({ type: "asset.remove", args: { assetId: old } });
  } else {
    const layer = resultLayer(asset, link, c);
    layerId = layer.id;
    // On top: smoke and water pass in front of everything else.
    ops.push({ type: "layer.add", args: { compId: c.id, layer, index: 0 } });
  }
  const updated: BlenderLink = { ...link, blendFile: output.blend, ...(layerId ? { layerId } : {}), result: { assetId: asset.id, renderedAt: new Date().toISOString(), blendMtime: r.blendMtime, seconds: link.seconds } };
  ops.unshift({ type: "blender.set", args: { link: updated } });
  now.apply(ops, { label: mode === "build" ? `${link.name}` : `Update “${link.name}” from Blender` });
  if (layerId) now.selectLayer(layerId);
  return { ok: true, linkId: link.id };
};

/** Simulate an effect on areas in Blender and add it to the current scene. */
export const blenderEffect = async (kind: BlenderEffectKind, regionIds: readonly Id[], opts: { params?: Record<string, number | string | boolean>; seconds?: number; quality?: "draft" | "full"; startSeconds?: number } = {}) => {
  const s = useStudio.getState();
  const comp = currentComp(s);
  const venue = s.project ? activeVenue({ project: s.project }) : undefined;
  if (!comp || !venue || !regionIds.length) return { ok: false as const, message: "Select one or more areas first." };
  const names = regionIds.map((id) => venue.regions[id]?.name).filter(Boolean);
  const link: BlenderLink = {
    id: newId("blend"),
    name: `${BLENDER_EFFECTS[kind].title.replace(" (Blender)", "")} — ${names.length > 2 ? `${names.length} areas` : names.join(" + ")}`,
    origin: "effect",
    effect: { kind, regionIds: [...regionIds], params: opts.params ?? {} },
    compId: comp.id,
    startSeconds: opts.startSeconds ?? Math.round(timeToSeconds(s.time) * 10) / 10,
    seconds: opts.seconds ?? 4,
    quality: opts.quality ?? "draft",
  };
  return runLink(link, "build");
};

/** Render a linked .blend (a person's own Blender scene) and add it to the current scene. */
export const linkBlendFile = async (file?: string, opts: { seconds?: number; quality?: "draft" | "full" } = {}) => {
  const blend = file ?? (await window.be.blender.chooseBlend());
  const s = useStudio.getState();
  const comp = currentComp(s);
  if (!blend || !comp) return { ok: false as const, message: "No file chosen." };
  const link: BlenderLink = { id: newId("blend"), name: blend.split(/[\\/]/).pop()!.replace(/\.blend$/i, ""), origin: "linked", blendFile: blend, compId: comp.id, startSeconds: Math.round(timeToSeconds(s.time) * 10) / 10, seconds: opts.seconds ?? 4, quality: opts.quality ?? "draft" };
  return runLink(link, "render");
};

/** Render the link's .blend again (after editing it in Blender), replacing the video in place. */
export const updateFromBlender = (linkId: Id) => {
  const link = useStudio.getState().project?.blenderLinks?.[linkId];
  return link ? runLink(link, "render") : Promise.resolve({ ok: false as const, message: "That Blender link no longer exists." });
};

/** Make the effect again from Before Effects' side (after changing its length or quality); replaces edits made in Blender. */
export const rebuildBlenderEffect = (linkId: Id, changes: Partial<Pick<BlenderLink, "seconds" | "quality">> = {}) => {
  const link = useStudio.getState().project?.blenderLinks?.[linkId];
  return link ? runLink({ ...link, ...changes }, link.origin === "effect" ? "build" : "render") : Promise.resolve({ ok: false as const, message: "That Blender link no longer exists." });
};

export const openInBlender = async (linkId: Id) => {
  const link = useStudio.getState().project?.blenderLinks?.[linkId];
  if (!link?.blendFile) return { ok: false, message: "This link has no Blender file yet." };
  return window.be.blender.open(link.blendFile);
};

export const cancelBlender = (linkId: Id) => window.be.blender.cancel(linkId);

/** Whether the .blend changed since the last render (edited in Blender): "Update" brings it in. */
export const blendChanged = async (link: BlenderLink) => {
  if (!link.blendFile || !link.result?.blendMtime) return false;
  const m = await window.be.blender.mtime(link.blendFile);
  return m !== null && m > link.result.blendMtime + 1000;
};

/** The link whose result a layer shows, if any. */
export const linkForLayer = (layerId: string): BlenderLink | undefined => Object.values(useStudio.getState().project?.blenderLinks ?? {}).find((l) => l.layerId === layerId);

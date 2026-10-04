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
  type BlenderEditable,
  type BlenderLink,
  buildExchange,
  checkOwners,
  type Composition,
  type ExchangeObject,
  type Id,
  newId,
  newLayer,
  lightObject,
  type Object3D,
  type Op,
  preparedObstacles,
  type Project,
  resolveScene3DLayer,
  type Scene3D,
  secondsToTime,
  staticProp,
  timeToSeconds,
  type Vec3,
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

export const STAGES: Record<string, string> = { export: "Bringing it in as 3D", prepare: "Preparing the 3D physics", build: "Building the Blender scene", bake: "Simulating in Blender", render: "Rendering in Blender", video: "Making the video" };

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
    const x = buildExchange(project, link, { venueId: venue.id, canvas: venue.canvas, fps, cameraDistance: venue.cameraDistance ?? 1.6, ...(ref ? { photo: ref.path } : {}), output, ...(prepared ? { prepared } : {}) });
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
    // Same layer (its effects, masks and keyframes stay), new video, and the link's start and length.
    const start = secondsToTime(link.startSeconds);
    ops.push({ type: "layer.replace", args: { compId: c.id, layer: { ...existing, source: { kind: "footage", assetId: asset.id }, startTime: start, inPoint: start, outPoint: start + secondsToTime(link.seconds) } } });
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

/** A .blend brought straight in as editable 3D (no video): a link that keeps the file and the report. */
export const importBlendAsEditable = async (file?: string, opts: { seconds?: number } = {}) => {
  const blend = file ?? (await window.be.blender.chooseBlend());
  const s = useStudio.getState();
  const comp = currentComp(s);
  if (!blend || !comp) return { ok: false as const, message: "No file chosen." };
  const link: BlenderLink = { id: newId("blend"), name: blend.split(/[\\/]/).pop()!.replace(/\.blend$/i, ""), origin: "linked", blendFile: blend, compId: comp.id, startSeconds: Math.round(timeToSeconds(s.time) * 10) / 10, seconds: opts.seconds ?? 4, quality: "draft" };
  s.apply({ type: "blender.set", args: { link } }, { label: `Link ${link.name}` });
  const r = await importEditable(link.id);
  // Nothing came of it: drop the empty link again.
  if (!r.ok) useStudio.getState().apply({ type: "blender.remove", args: { linkId: link.id } }, { label: "Remove Blender link" });
  return r.ok ? { ok: true as const, linkId: link.id, layerId: r.layerId } : r;
};

/** The link a 3D scene came from (as editable 3D), if any. */
export const linkForScene = (sceneId: string): BlenderLink | undefined => Object.values(useStudio.getState().project?.blenderLinks ?? {}).find((l) => l.editable?.sceneId === sceneId);

/** Render the link's .blend again (after editing it in Blender), replacing the video in place. */
export const updateFromBlender = (linkId: Id) => {
  const link = useStudio.getState().project?.blenderLinks?.[linkId];
  return link ? runLink(link, "render") : Promise.resolve({ ok: false as const, message: "That Blender link no longer exists." });
};

/**
 * Make the effect again from Before Effects' side, with changed settings, length, start or quality
 * (replaces edits made in Blender). A linked .blend is rendered again at the new length or quality.
 */
export const rebuildBlenderEffect = (
  linkId: Id,
  changes: Partial<Pick<BlenderLink, "seconds" | "quality" | "startSeconds">> & { params?: Record<string, number | string | boolean>; regionIds?: readonly Id[] } = {},
) => {
  const link = useStudio.getState().project?.blenderLinks?.[linkId];
  if (!link) return Promise.resolve({ ok: false as const, message: "That Blender link no longer exists." });
  const { params, regionIds, ...rest } = changes;
  const next: BlenderLink = {
    ...link,
    ...rest,
    ...(link.effect && (params || regionIds) ? { effect: { ...link.effect, ...(params ? { params: { ...link.effect.params, ...params } } : {}), ...(regionIds?.length ? { regionIds: [...regionIds] } : {}) } } : {}),
  };
  return runLink(next, link.origin === "effect" ? "build" : "render");
};

/** Rename a Blender link and the layer showing it (no Blender run). */
export const renameBlenderLink = (linkId: Id, name: string) => {
  const s = useStudio.getState();
  const link = s.project?.blenderLinks?.[linkId];
  if (!link || !name.trim()) return;
  const ops: Op[] = [{ type: "blender.set", args: { link: { ...link, name } } }];
  if (link.layerId && s.project?.compositions[link.compId]?.layers[link.layerId]) ops.push({ type: "layer.update", args: { compId: link.compId, layerId: link.layerId, changes: { name } } });
  s.apply(ops, { label: "Rename", coalesceKey: `${linkId}:name` });
};

/**
 * Bring a linked .blend in as editable 3D: Blender exports its meshes, materials, lights and
 * animation (baked over the link's length) to a model file, which goes into a 3D layer you can move,
 * retime and light in Before Effects. The report says, per object, what came across, what was
 * approximated, and what stays in the rendered video only. Again after editing in Blender: the model
 * is replaced and your placement in Before Effects is kept.
 */
export const importEditable = async (linkId: Id): Promise<{ ok: true; layerId: Id } | { ok: false; message: string; code?: string }> => {
  hook();
  const s = useStudio.getState();
  const link = s.project?.blenderLinks?.[linkId];
  if (!link?.blendFile) return { ok: false, message: "This link has no Blender file yet." };
  if (link.origin !== "linked") return { ok: false, message: "Effects made by Before Effects come back as video (smoke, fire, water and cloth can't be carried as editable shapes). Link your own .blend to bring it in as 3D." };
  const comp = s.project!.compositions[link.compId];
  if (!comp) return { ok: false, message: "The scene is missing." };
  const fps = comp.frameRate.num / comp.frameRate.den;
  const dir = `${await dirFor(s.project!.id, link.id)}\\model`;
  useBlenderJobs.setState((j) => ({ ...j, [link.id]: { stage: "export", done: 0, total: 1, running: true } }));
  const r = await window.be.blender.exportModel(`${link.id}-model`, { blend: link.blendFile, fps, frames: Math.max(1, Math.round(link.seconds * fps)), dir });
  if (!r.ok) {
    useBlenderJobs.setState((j) => ({ ...j, [link.id]: r.code === "cancelled" ? { stage: "cancelled", done: 0, total: 1, running: false } : { stage: "failed", done: 0, total: 1, error: r.message, running: false } }));
    return { ok: false, message: r.message, code: r.code };
  }
  useBlenderJobs.setState((j) => ({ ...j, [link.id]: { stage: "done", done: 1, total: 1, running: false } }));
  const now = useStudio.getState();
  const project = now.project!;
  const asset: Asset = { id: newId("asset"), kind: "model", name: `${link.name} (3D)`, path: r.model, meta: {} };
  const report = { objects: r.report.objects, file: { meshes: r.report.file.meshes, materials: r.report.file.materials, animations: r.report.file.animations, lights: r.report.file.lights, bytes: r.report.file.bytes } };
  const prev = link.editable && project.scenes3d?.[link.editable.sceneId]?.objects[link.editable.objectId] ? link.editable : undefined;
  const ops: Op[] = [{ type: "asset.add", args: { asset } }];
  let editable: BlenderEditable;
  if (prev) {
    // Updated in Blender: swap the model, keep where it sits and how it plays.
    ops.push({ type: "object3d.update", args: { sceneId: prev.sceneId, objectId: prev.objectId, changes: { geometry: { kind: "model", assetId: asset.id } } } });
    editable = { ...prev, assetId: asset.id, at: new Date().toISOString(), report };
  } else {
    const sceneId = newId("s3d");
    const objectId = `${sceneId}-model`;
    const model: Object3D = {
      id: objectId,
      name: link.name,
      kind: "mesh",
      visible: true,
      position: staticProp<Vec3>([0, 0, 0.5], true),
      rotation: staticProp<Vec3>([0, 0, 0]),
      scale: staticProp<Vec3>([100, 100, 100]),
      geometry: { kind: "model", assetId: asset.id },
      clip: { speed: 1, offset: 0 },
    };
    // Its own lights come along; without any, a key light and a soft fill so it can be seen.
    const lights: Object3D[] = r.report.file.lights
      ? []
      : [lightObject(`${sceneId}-key`, "Key light", { target: [0, 1, 0] }, [-3, 6, 8]), lightObject(`${sceneId}-fill`, "Soft fill", { type: "ambient", intensity: staticProp(0.5), castShadow: false, color: [0.85, 0.9, 1, 1] }, [0, 0, 0])];
    const scene: Scene3D = { id: sceneId, name: `${link.name} (3D)`, objectOrder: [objectId, ...lights.map((l) => l.id)], objects: Object.fromEntries([model, ...lights].map((o) => [o.id, o])), gravity: [0, -9.81, 0] };
    const layer = { ...newLayer({ id: newId("layer"), name: `${link.name} (3D)`, source: { kind: "scene3d", sceneId }, start: secondsToTime(link.startSeconds), duration: secondsToTime(link.seconds) }), audioEnabled: false };
    ops.push({ type: "scene3d.add", args: { scene } }, { type: "layer.add", args: { compId: comp.id, layer, index: 0 } });
    editable = { assetId: asset.id, sceneId, layerId: layer.id, objectId, at: new Date().toISOString(), report };
  }
  ops.unshift({ type: "blender.set", args: { link: { ...link, editable } } });
  now.apply(ops, { label: prev ? `Update “${link.name}” 3D from Blender` : `Bring “${link.name}” in as 3D` });
  now.selectLayer(editable.layerId);
  return { ok: true, layerId: editable.layerId };
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

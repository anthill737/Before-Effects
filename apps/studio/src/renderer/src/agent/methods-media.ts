/**
 * Agent methods: 3D scenes, objects, lights and physics; simulation/physics preparation; playback,
 * preview and frame capture; exports and job monitoring.
 */
import {
  sceneCameraDistance,
  balancesPicture,
  type AnimProp,
  areaObject,
  modelObject,
  pictureObject,
  evalProp,
  framesIn,
  keyAt,
  newId,
  type Layer,
  type Light3D,
  type Material3D,
  type Object3D,
  type Physics3D,
  type Blocks3D,
  DEFAULT_BLOCKS,
  type Fracture3D,
  type PropValue,
  type Scene3D,
  secondsToTime,
  setKeyEase,
  setPropAt,
  snapToFrame,
  timeToFrame,
  timeToSeconds,
  toggleKeyAt,
  type Vec3,
} from "@be/core";
import { z } from "zod";
import { currentPreviewLoop } from "../preview/PreviewPanel.tsx";
import { usePreviewStats } from "../preview/loop.ts";
import { usePreview } from "../preview/settings.ts";
import { addObject, addParticles, ensureModelInfo, layerTime, makeArea3D, makeHouse3D, removeObject, setContain } from "../studio/actions3d.ts";
import { importMediaFiles } from "../studio/media.ts";
import { hasAudio } from "../studio/audioEngine.ts";
import { pausePreparing, startPreparing, stopPreparing, usePrepare } from "../preview/prepare.ts";
import { applyPlan, computePlan } from "../preview/recommend.ts";
import { driveMediaInUse } from "../studio/drive.ts";
import { getRenderer } from "../studio/engineHost.ts";
import { OUTCOMES, SIZES } from "../studio/ExportDialog.tsx";
import { useSims } from "../studio/simHost.ts";
import { currentProjector, useProjectorPick } from "../studio/projectors.ts";
import { projectorRef } from "./methods-projectors.ts";
import { activeVenue, currentComp, useStudio } from "../studio/store.ts";
import { AgentError, currentRevision, method } from "./core.ts";
import { areaIds } from "./methods-show.ts";

const r2 = (n: number) => Math.round(n * 100) / 100;
const st = () => useStudio.getState();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const project = () => {
  const p = st().project;
  if (!p) throw new AgentError("no_project", "No show is open.");
  return p;
};

// ---- 3D --------------------------------------------------------------------------------------------

/** A 3D scene by id or name, and the layer showing it in the current scene (if any). */
/** A picture by media id or name. */
const mediaId = (ref: string): string => {
  const p = project();
  const lc = ref.toLowerCase();
  const a = p.assets[ref] ?? Object.values(p.assets).find((x) => x.name.toLowerCase() === lc);
  if (!a || a.kind !== "image") throw new AgentError("not_found", `No picture "${ref}" in this show. Import it with assets.import.`);
  return a.id;
};

const scene3d = (ref: string): { scene: Scene3D; layer: Layer | undefined } => {
  const all = project().scenes3d ?? {};
  const s = all[ref] ?? Object.values(all).find((x) => x.name.toLowerCase() === ref.toLowerCase());
  if (!s) throw new AgentError("not_found", `No 3D scene "${ref}". Use ids from scene3d.list.`);
  const comp = currentComp(st());
  const layer = comp ? Object.values(comp.layers).find((l) => l.source.kind === "scene3d" && l.source.sceneId === s.id) : undefined;
  return { scene: s, layer };
};
const object3d = (s: Scene3D, ref: string): Object3D => {
  const o = s.objects[ref] ?? Object.values(s.objects).find((x) => x.name.toLowerCase() === ref.toLowerCase());
  if (!o) throw new AgentError("not_found", `No object "${ref}" in "${s.name}". Objects: ${s.objectOrder.map((id) => s.objects[id]!.name).join(", ")}.`);
  return o;
};
const needLayer = (layer: Layer | undefined, s: Scene3D): Layer => {
  if (!layer) throw new AgentError("not_found", `“${s.name}” isn't shown in the current scene. Open the scene that shows it (scenes.open).`);
  return layer;
};

const objectInfo = (o: Object3D, t: number) => ({
  id: o.id,
  name: o.name,
  kind: o.kind,
  visible: o.visible,
  position: evalProp(o.position, t),
  rotation: evalProp(o.rotation, t),
  scale: evalProp(o.scale, t),
  animated: ["position", "rotation", "scale"].filter((k) => ((o as unknown as Record<string, AnimProp>)[k]!.keyframes?.length ?? 0) > 0),
  ...(o.geometry ? { geometry: o.geometry.kind === "area" ? { kind: "area", areas: o.geometry.ref, thicknessCm: Math.round(o.geometry.depth * 100), standOutCm: Math.round((o.geometry.standOut ?? 0) * 100), ...(o.geometry.cut ? { cutOut: o.geometry.cut } : {}) } : o.geometry } : {}),
  ...(o.material ? { material: { style: o.material.style, ...(o.material.assetId ? { image: o.material.assetId } : {}), color: evalProp(o.material.color, t), roughness: o.material.roughness, metalness: o.material.metalness, glow: evalProp(o.material.glow, t), opacity: o.material.opacity, ...(o.material.style === "photo" || o.material.style === "image" ? { shading: o.material.shading ?? 1, matchPicture: o.material.matchPicture ?? true } : {}) } } : {}),
  ...(o.physics ? { physics: o.physics } : {}),
  ...(o.fracture ? { fracture: o.fracture } : {}),
  ...(o.blocks ? { blocks: o.blocks } : {}),
  ...(o.light ? { light: { ...o.light, intensity: evalProp(o.light.intensity, t), balance: balancesPicture(o.light) } } : {}),
  ...(o.attach ? { attach: o.attach } : {}),
  ...(o.geometry?.kind === "model" ? { model: modelReport(o.geometry.assetId) } : {}),
});

/** A model's measurements and whether it could be read (the renderer remembers failures). */
let modelErrors: ReadonlyMap<string, string> = new Map();
void getRenderer().then((r) => (modelErrors = r.scenes.modelErrors));
const modelReport = (assetId: string) => {
  const a = project().assets[assetId];
  const m = a?.meta.model;
  const problem = modelErrors.get(assetId);
  return { asset: assetId, name: a?.name, ...(m ? { sizeM: [m.bounds[3] - m.bounds[0], m.bounds[4] - m.bounds[1], m.bounds[5] - m.bounds[2]], collider: m.hull.length >= 12 ? `hull of ${m.hull.length / 3} points` : "none", animations: m.animations } : { measured: false }), ...(problem ? { problem } : {}) };
};

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

method({
  name: "scene3d.list",
  summary: "3D scenes in the show and the layers that show them.",
  params: z.object({}),
  run: () => {
    const p = project();
    return Object.values(p.scenes3d ?? {}).map((s) => ({
      id: s.id,
      name: s.name,
      objects: s.objectOrder.map((id) => ({ id, name: s.objects[id]!.name, kind: s.objects[id]!.kind })),
      shownBy: Object.values(p.compositions).flatMap((c) => Object.values(c.layers).filter((l) => l.source.kind === "scene3d" && l.source.sceneId === s.id).map((l) => ({ scene: c.id, layer: l.id, startSeconds: r2(timeToSeconds(l.startTime)), seconds: r2(timeToSeconds(l.outPoint - l.startTime)) }))),
    }));
  },
});

method({
  name: "scene3d.get",
  summary: "A 3D scene in full: gravity, camera, and every object's transform, shape, material, physics, breaking and light (values at the playhead).",
  params: z.object({ scene: z.string() }),
  run: (p) => {
    const { scene, layer } = scene3d(p.scene);
    const t = layer ? layerTime(layer, st().time) : 0;
    return {
      id: scene.id,
      name: scene.name,
      gravity: scene.gravity,
      cameraDistance: sceneCameraDistance(project(), scene, activeVenue(st())?.id),
      viewpoint: scene.cameraDistance === undefined ? "building" : "own",
      layer: layer ? { id: layer.id, startSeconds: r2(timeToSeconds(layer.startTime)), seconds: r2(timeToSeconds(layer.outPoint - layer.startTime)), contained: layer.masks.some((m) => m.id === "contain") } : null,
      objects: scene.objectOrder.map((id) => objectInfo(scene.objects[id]!, t)),
    };
  },
});

method({
  name: "scene3d.createFromAreas",
  summary:
    "Give areas thickness as a 3D solid (photo on its front, inside, ledge, ground, key light, fill), optionally breaking apart with real physics (Rapier): collapse (falls and flies back), explode (bursts toward the audience) crumble (top first, piles up) or shatter (like a pane of glass: thin, clear shards burst out from where it's struck). Or, with blocks, the surface as moving blocks (procedural, worked out from time): pulse (cubes breathing together), ripple (rings from a point), wave (a wave across), columns (tall columns pushing out) or slats (tall slats turning); adjust with scene3d.objectUpdate blocks. Adds a 3D layer at the playhead.",
  params: z.object({ areas: z.array(z.string()).min(1), collapse: z.boolean().optional(), preset: z.enum(["collapse", "explode", "crumble", "shatter"]).optional(), blocks: z.enum(["pulse", "ripple", "wave", "columns", "slats"]).optional(), thicknessCm: z.number().min(1).max(500).optional() }),
  mutates: true,
  example: { areas: ["Wall 1"], collapse: true, preset: "explode", thicknessCm: 30 },
  run: (p, ctx) => {
    const ids = areaIds(p.areas);
    if (p.blocks && (p.collapse || p.preset)) throw new AgentError("invalid_params", "Choose either breaking apart (collapse/preset) or blocks, not both.");
    const layerId = ctx.edit(() => makeArea3D(ids, !!p.collapse || !!p.preset, p.preset ?? "collapse", p.blocks));
    if (!layerId) throw new AgentError("rejected", "Those areas couldn't be made 3D.");
    const l = currentComp(st())!.layers[layerId]!;
    const sid = l.source.kind === "scene3d" ? l.source.sceneId : "";
    if (p.thicknessCm !== undefined) {
      const s = project().scenes3d![sid]!;
      const area = Object.values(s.objects).find((o) => o.geometry?.kind === "area")!;
      ctx.edit(() => st().apply({ type: "object3d.update", args: { sceneId: sid, objectId: area.id, changes: { geometry: { ...area.geometry!, depth: p.thicknessCm! / 100 } } } }, { label: "Change thickness" }));
    }
    return { scene: sid, layer: layerId, revision: currentRevision() };
  },
});

method({
  name: "scene3d.createHouse",
  summary:
    "Make the whole house one 3D space, as a 3D layer from the playhead: every traced area a solid at its depth (areas.update standOutCm/thicknessCm, or its kind's usual depth: windows, doors and the garage set back, columns standing out), each its own object, with the set-in and standing-out areas cut out of the walls; a key light that is the picture's own lighting, a soft fill, and a ground that shows only shadows. Add characters, props and lights to it with scene3d.objectAdd (kind model / picture / light); they share its depth, shadows and collisions.",
  params: z.object({ name: z.string().optional(), seconds: z.number().min(0.1).optional().describe("layer length (default: to the end of the scene)") }),
  mutates: true,
  run: (p, ctx) => {
    const layerId = ctx.edit(() => makeHouse3D({ ...(p.name ? { name: p.name } : {}), ...(p.seconds ? { seconds: p.seconds } : {}) }));
    if (!layerId) throw new AgentError("rejected", "There are no traced areas to make 3D (trace the building first).");
    const comp = currentComp(st())!;
    const l = comp.layers[layerId]!;
    const sid = l.source.kind === "scene3d" ? l.source.sceneId : "";
    const sc = project().scenes3d![sid]!;
    return { layer: layerId, scene: sid, objects: sc.objectOrder.map((id) => ({ id, name: sc.objects[id]!.name, kind: sc.objects[id]!.kind, ...(sc.objects[id]!.geometry?.kind === "area" ? { standOutCm: Math.round(((sc.objects[id]!.geometry as { standOut?: number }).standOut ?? 0) * 100) } : {}) })), revision: currentRevision() };
  },
});

method({
  name: "particles.add",
  summary:
    "Particles in 3D in front of the house, as a layer on top at the playhead: sparks (spray out and arc down), embers (drift up, flickering), snow (falls over the areas, or the whole picture without areas), confetti (a burst that flutters down). Procedural: placed by rule, not simulated; they don't hit the house. Adjust with scene3d.objectUpdate (particles: rate, life, speed, size, colors, wind, start, stop, seed).",
  params: z.object({ kind: z.enum(["sparks", "embers", "snow", "confetti"]), areas: z.array(z.string()).optional() }),
  mutates: true,
  example: { kind: "sparks", areas: ["Garage door"] },
  run: (p, ctx) => {
    const ids = p.areas?.length ? areaIds(p.areas) : [];
    if (!ids.length && p.kind !== "snow") throw new AgentError("invalid_params", `${p.kind} start from areas: give at least one.`);
    const layerId = ctx.edit(() => addParticles(p.kind, ids));
    if (!layerId) throw new AgentError("rejected", "The particles couldn't be added.");
    const l = currentComp(st())!.layers[layerId]!;
    return { scene: l.source.kind === "scene3d" ? l.source.sceneId : "", layer: layerId, revision: currentRevision() };
  },
});

method({
  name: "scene3d.update",
  summary:
    "Change a 3D scene's gravity (strength m/s² and direction in degrees, 0 = down, 90 = right; or a vector) or the audience viewpoint: cameraDistance (building widths in front of the building) gives this scene its own, null makes it follow the building's; buildingCameraDistance changes the building's viewpoint, shared by every scene that follows it.",
  params: z.object({
    scene: z.string(),
    gravity: z.object({ strength: z.number().min(0).max(100), angle: z.number().optional() }).optional(),
    gravityVector: vec3.optional(),
    cameraDistance: z.number().min(0.2).max(20).nullable().optional(),
    buildingCameraDistance: z.number().min(0.2).max(20).optional(),
    name: z.string().optional(),
  }),
  mutates: true,
  run: (p, ctx) => {
    const { scene } = scene3d(p.scene);
    const changes: Record<string, unknown> = {};
    if (p.gravity) {
      const a = ((p.gravity.angle ?? 0) * Math.PI) / 180;
      changes.gravity = [Math.sin(a) * p.gravity.strength, -Math.cos(a) * p.gravity.strength, 0];
    }
    if (p.gravityVector) changes.gravity = p.gravityVector;
    if (p.cameraDistance !== undefined) changes.cameraDistance = p.cameraDistance;
    if (p.name) changes.name = p.name;
    if (p.buildingCameraDistance !== undefined) {
      const v = activeVenue(st());
      if (!v) throw new AgentError("not_found", "There's no building (venue) yet.");
      ctx.edit(() => st().apply({ type: "venue.update", args: { venueId: v.id, changes: { cameraDistance: p.buildingCameraDistance! } } }, { label: "Change the audience viewpoint" }));
    }
    if (Object.keys(changes).length) ctx.edit(() => st().apply({ type: "scene3d.update", args: { sceneId: scene.id, changes } }, { label: "Change 3D scene" }));
    return { scene: scene.id, gravity: project().scenes3d![scene.id]!.gravity, revision: currentRevision() };
  },
});

method({
  name: "scene3d.objectAdd",
  summary:
    "Add an object: box (falls), ball (falls and bounces), ledge (fixed obstacle), spot light, area — a traced area as its own solid in this scene (the building photo on it; give it a picture, physics or breaking with scene3d.objectUpdate) — or model: a 3D model (glTF/GLB: a character or prop) that shares this scene's depth, lights and shadows with the house (it can pass behind a column, cast shadows on the wall, and collide when given physics). An area can stand out toward the audience (standOutCm: a column in front of a porch — it stays on its picture from the audience while lights and shadows see the real solid) and have other areas cut out of it (cutOut: room for parts that are their own pieces).",
  params: z.object({
    scene: z.string(),
    kind: z.enum(["box", "ball", "ledge", "light", "area", "model", "picture"]),
    model: z.string().optional().describe("kind model: a model in the show (asset id or name), or a .glb/.gltf file path to import"),
    picture: z.string().optional().describe("kind picture: a picture in the show (asset id or name) or an image file path to import; stands in the scene (a cut-out PNG's transparent parts are cut out of it and its shadow)"),
    heightM: z.number().min(0.01).max(200).optional().describe("kind model: scale it to this height (default: as made)"),
    xM: z.number().optional().describe("kind model: left/right from the building's middle (m)"),
    aheadM: z.number().optional().describe("kind model/picture: distance in front of the building front (m, default 1)"),
    standsAtM: z.number().optional().describe("kind model/picture: height it stands at (m above the bottom of the canvas, default 0: e.g. a porch floor's height)"),
    area: z.union([z.string(), z.array(z.string()).min(1)]).optional().describe("kind area: the area(s) by name or id"),
    name: z.string().optional(),
    thicknessCm: z.number().min(1).max(500).optional(),
    standOutCm: z.number().min(0).max(2000).optional(),
    cutOut: z.array(z.string()).optional().describe("kind area: areas cut out of it"),
  }),
  mutates: true,
  run: async (p, ctx) => {
    const { scene, layer } = scene3d(p.scene);
    const before = new Set(scene.objectOrder);
    if (p.kind === "model") {
      if (!p.model) throw new AgentError("invalid_params", "A model object needs model (a model in the show, or a .glb/.gltf file path).");
      let asset = Object.values(project().assets).find((a) => a.kind === "model" && (a.id === p.model || a.name.toLowerCase() === p.model!.toLowerCase()));
      if (!asset) {
        if (!/\.(glb|gltf)$/i.test(p.model)) throw new AgentError("not_found", `No 3D model "${p.model}" in the show (give a .glb/.gltf path to import one).`);
        let added: Awaited<ReturnType<typeof importMediaFiles>> = [];
        try {
          added = await importMediaFiles([p.model], { quiet: true });
        } catch (e) {
          throw new AgentError("rejected", String((e as Error)?.message ?? e));
        }
        asset = added[0];
        if (!asset) throw new AgentError("rejected", `“${p.model}” couldn't be imported as a 3D model (see the app log for why).`);
      }
      const info = await ensureModelInfo(asset.id);
      const object = modelObject(newId("obj"), p.name ?? asset.name.replace(/\.(glb|gltf)$/i, ""), asset.id, info ?? undefined, [p.xM ?? 0, p.standsAtM ?? 0, p.aheadM ?? 1], p.heightM);
      ctx.edit(() => st().apply({ type: "object3d.add", args: { sceneId: scene.id, object } }, { label: `Add ${object.name}` }));
      const b = info?.bounds;
      return { object: object.id, asset: asset.id, measured: b ? { widthM: b[3] - b[0], heightM: b[4] - b[1], depthM: b[5] - b[2], hullPoints: info!.hull.length / 3, animations: info!.animations } : null, revision: currentRevision() };
    }
    if (p.kind === "picture") {
      if (!p.picture) throw new AgentError("invalid_params", "A picture object needs picture (a picture in the show, or an image file path).");
      let asset = Object.values(project().assets).find((a) => a.kind === "image" && (a.id === p.picture || a.name.toLowerCase() === p.picture!.toLowerCase()));
      if (!asset) asset = (await importMediaFiles([p.picture], { quiet: true }))[0];
      if (!asset || asset.kind !== "image") throw new AgentError("not_found", `No picture "${p.picture}" (give an image in the show, or an image file path).`);
      const aspect = (asset.meta.width ?? 1) / (asset.meta.height ?? 1);
      const object = pictureObject(newId("obj"), p.name ?? asset.name.replace(/\.\w+$/, ""), asset.id, aspect, p.heightM ?? 1.7, [p.xM ?? 0, p.standsAtM ?? 0, p.aheadM ?? 1]);
      ctx.edit(() => st().apply({ type: "object3d.add", args: { sceneId: scene.id, object } }, { label: `Add ${object.name}` }));
      return { object: object.id, asset: asset.id, revision: currentRevision() };
    }
    if (p.kind === "area") {
      if (!p.area) throw new AgentError("invalid_params", "An area object needs area (an area's name or id).");
      const ids = areaIds([p.area].flat());
      const cut = p.cutOut?.length ? { role: "areas", regionIds: areaIds(p.cutOut) } : undefined;
      const object = areaObject(newId("obj"), p.name ?? [p.area].flat().join(" + "), { role: "areas", regionIds: ids }, { depth: (p.thicknessCm ?? 25) / 100, ...(p.standOutCm ? { standOut: p.standOutCm / 100 } : {}), ...(cut ? { cut } : {}) });
      ctx.edit(() => st().apply({ type: "object3d.add", args: { sceneId: scene.id, object } }, { label: `Add ${object.name}` }));
      return { object: object.id, revision: currentRevision() };
    }
    ctx.edit(() => addObject(needLayer(layer, scene), p.kind as "box" | "ball" | "ledge" | "light"));
    const added = project().scenes3d![scene.id]!.objectOrder.find((id) => !before.has(id));
    if (!added) throw new AgentError("rejected", "The object couldn't be added.");
    return { object: added, revision: currentRevision() };
  },
});

method({
  name: "scene3d.objectRemove",
  summary: "Remove an object from a 3D scene.",
  params: z.object({ scene: z.string(), object: z.string() }),
  mutates: true,
  run: (p, ctx) => {
    const { scene, layer } = scene3d(p.scene);
    const o = object3d(scene, p.object);
    ctx.edit(() => removeObject(needLayer(layer, scene), o.id));
    return { removed: o.id, revision: currentRevision() };
  },
});

method({
  name: "scene3d.objectUpdate",
  summary:
    "Change a 3D object. position (m), rotation (°), scale (%) are set at the playhead (as keyframes if animated). Partial material/physics/fracture/light settings merge with the current ones; physics or fracture null removes it. fracture times are seconds into the 3D layer.",
  params: z.object({
    scene: z.string(),
    object: z.string(),
    name: z.string().optional(),
    visible: z.boolean().optional(),
    position: vec3.optional(),
    rotation: vec3.optional(),
    scale: z.number().min(1).max(10000).optional(),
    thicknessCm: z.number().min(1).max(500).optional(),
    standOutCm: z.number().min(0).max(2000).optional().describe("area: how far its front stands out toward the audience (it stays on its picture from the audience)"),
    cutOut: z.array(z.string()).nullable().optional().describe("area: other areas cut out of it (null: none)"),
    material: z.object({ style: z.enum(["photo", "color", "shadow", "image"]), image: z.string(), color: z.tuple([z.number(), z.number(), z.number(), z.number()]), roughness: z.number().min(0).max(1), metalness: z.number().min(0).max(1), glow: z.number().min(0).max(10), opacity: z.number().min(0).max(1), shading: z.number().min(0).max(1).describe("picture surfaces: 0 = the picture itself whichever way it turns, 1 = lit like a real solid (default)"), matchPicture: z.boolean().describe("picture surfaces: facing the audience it shows the picture exactly whatever the lights (default true); false = as the lights really fall on it (a light's own pass)") }).partial().optional(),
    physics: z
      .object({
        body: z.enum(["dynamic", "static"]),
        mass: z.number().min(0.01).max(1e6),
        friction: z.number().min(0).max(2),
        bounce: z.number().min(0).max(1),
        releaseAt: z.number().min(0).nullable().describe("dynamic: seconds into the layer when it lets go — until then it follows its animation (and what it rides on), then flies on with the speed and spin it had; null: physics from the start"),
      })
      .partial()
      .nullable()
      .optional(),
    attachTo: z.string().nullable().optional().describe("ride on another object of the scene (its position, turn and size become relative to it); null: stand on its own"),
    detachAt: z.number().min(0).nullable().optional().describe("seconds into the layer when it stops riding (stays where it was left, or physics takes over with physics.releaseAt); null: rides throughout"),
    fracture: z
      .object({
        pieceSize: z.number().min(5).max(1000),
        seed: z.number().int(),
        collapseAt: z.number().min(0),
        rebuildAt: z.number().min(0).nullable(),
        rebuildSeconds: z.number().min(0.1).max(60),
        push: z.number().min(-20).max(20),
        spin: z.number().min(0).max(10),
        stagger: z.number().min(0).max(30),
        pattern: z.enum(["pieces", "glass", "bricks"]),
        trigger: z.enum(["time", "impact"]).describe("time: breaks at collapseAt; impact: stays whole until something moving hits it, then breaks only around the hit, the way the hit was going"),
        impactRadius: z.number().min(0.05).max(20).describe("impact: metres around the hit that break out (default 0.8)"),
        impactSpeed: z.number().min(0).max(100).describe("impact: slowest hit that breaks it, m/s (default 3)"),
      })
      .partial()
      .nullable()
      .optional(),
    blocks: z
      .object({
        shape: z.enum(["cubes", "columns", "rows"]),
        size: z.number().min(5).max(1000),
        height: z.number().min(5).max(1000).nullable().describe("block height in cm (blocks shaped like the stones they cover); null: square"),
        bond: z.number().min(0).max(1).describe("every other row shifted by this much of a block's width (0.5: brickwork)"),
        offset: z.tuple([z.number(), z.number()]).nullable().describe("where the grid starts (canvas px), to line blocks up with the joints in the picture"),
        gap: z.number().min(0).max(100),
        motion: z.enum(["push", "turn"]),
        pattern: z.enum(["pulse", "ripple", "wave", "random", "checker"]),
        amount: z.number().min(0).max(500),
        bothWays: z.boolean(),
        speed: z.number().min(0).max(20),
        wavelength: z.number().min(10).max(10000),
        direction: z.number(),
        origin: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
        startAt: z.number().min(0),
        stopAt: z.number().min(0).nullable(),
        ramp: z.number().min(0).max(30),
        seed: z.number().int(),
      })
      .partial()
      .nullable()
      .optional(),
    light: z
      .object({
        type: z.enum(["directional", "spot", "point", "ambient"]),
        color: z.tuple([z.number(), z.number(), z.number(), z.number()]),
        intensity: z.number().min(0).max(100),
        castShadow: z.boolean(),
        target: vec3,
        angle: z.number().min(1).max(89),
        softness: z.number().min(0).max(1),
        balance: z.boolean().describe("part of the picture's own lighting (evens picture surfaces out so they show exactly); default true for directional/ambient, false for spot/point, which add light and shadows on top"),
      })
      .partial()
      .optional(),
  }),
  mutates: true,
  example: { scene: "Wall 1 in 3D", object: "Key light", position: [8, 6, 6] },
  run: async (p, ctx) => {
    const { scene, layer } = scene3d(p.scene);
    const o = object3d(scene, p.object);
    const t = layer ? layerTime(layer, st().time) : 0;
    const at = <V extends PropValue>(prop: AnimProp<V>, v: V): AnimProp<V> => setPropAt(prop, t, v);
    const changes: Record<string, unknown> = {};
    if (p.name) changes.name = p.name;
    if (p.visible !== undefined) changes.visible = p.visible;
    if (p.position) changes.position = at(o.position, p.position as Vec3);
    if (p.rotation) changes.rotation = at(o.rotation, p.rotation as Vec3);
    if (p.scale !== undefined) changes.scale = at(o.scale, [p.scale, p.scale, p.scale] as Vec3);
    if (p.thicknessCm !== undefined || p.standOutCm !== undefined || p.cutOut !== undefined) {
      if (o.geometry?.kind !== "area") throw new AgentError("invalid_params", `“${o.name}” isn't a building area, so it has no thickness, stand-out or cut-outs.`);
      const g = { ...o.geometry } as Record<string, unknown>;
      if (p.thicknessCm !== undefined) g.depth = p.thicknessCm / 100;
      if (p.standOutCm !== undefined) g.standOut = p.standOutCm / 100;
      if (p.cutOut === null || (p.cutOut && !p.cutOut.length)) delete g.cut;
      else if (p.cutOut) g.cut = { role: "areas", regionIds: areaIds(p.cutOut) };
      changes.geometry = g;
    }
    if (p.material) {
      if (!o.material) throw new AgentError("invalid_params", `“${o.name}” has no material (is it a light?).`);
      // "image": a picture lined up with the building (like a house skin) on the front, by media id or name.
      const image = p.material.image !== undefined ? mediaId(p.material.image) : undefined;
      if (p.material.style === "image" && !image && !(o.material.style === "image" && o.material.assetId)) throw new AgentError("invalid_params", "A picture surface needs material.image (a picture's media id or name).");
      const m: Material3D = { ...o.material, ...(image ? { assetId: image } : {}), ...(p.material.style ? { style: p.material.style } : {}), ...(p.material.roughness !== undefined ? { roughness: p.material.roughness } : {}), ...(p.material.metalness !== undefined ? { metalness: p.material.metalness } : {}), ...(p.material.opacity !== undefined ? { opacity: p.material.opacity } : {}), ...(p.material.shading !== undefined ? { shading: p.material.shading } : {}), ...(p.material.matchPicture !== undefined ? { matchPicture: p.material.matchPicture } : {}) };
      changes.material = { ...m, ...(p.material.color ? { color: at(o.material.color, p.material.color) } : {}), ...(p.material.glow !== undefined ? { glow: at(o.material.glow, p.material.glow) } : {}) };
    }
    if (p.physics === null) changes.physics = null;
    else if (p.physics) {
      const { releaseAt, ...rest } = p.physics;
      const base: Physics3D = { ...(o.physics ?? { body: "dynamic", mass: 50, friction: 0.7, bounce: 0.2 }), ...rest };
      const { releaseAt: _old, ...noRelease } = base;
      changes.physics = releaseAt === null ? noRelease : releaseAt !== undefined ? { ...base, releaseAt } : base;
      // A model needs its measurements to collide.
      if (o.geometry?.kind === "model") await ensureModelInfo(o.geometry.assetId);
    }
    if (p.attachTo !== undefined || p.detachAt !== undefined) {
      const to = p.attachTo === undefined ? o.attach?.to : p.attachTo;
      if (to === null || to === undefined) changes.attach = null;
      else {
        const target = scene.objects[to] ?? Object.values(scene.objects).find((x) => x.name.toLowerCase() === to.toLowerCase());
        if (!target || target.id === o.id) throw new AgentError("not_found", `No other object "${to}" in this scene to ride on.`);
        // Riding on something that rides on this would go round in circles.
        for (let x: typeof target | undefined = target, n = 0; x?.attach && n < 10; x = scene.objects[x.attach.to], n++) if (x.attach.to === o.id) throw new AgentError("rejected", `“${target.name}” already rides on “${o.name}”.`);
        const until = p.detachAt === undefined ? o.attach?.until : p.detachAt;
        changes.attach = { to: target.id, ...(until !== null && until !== undefined ? { until } : {}) };
      }
    }
    if (p.fracture === null) changes.fracture = null;
    else if (p.fracture) {
      if (o.geometry?.kind !== "area") throw new AgentError("invalid_params", "Only building areas given thickness can break apart.");
      const f: Fracture3D = { ...(o.fracture ?? { pieceSize: 70, seed: 1, collapseAt: 1, rebuildAt: 5, rebuildSeconds: 2, push: 0.6, spin: 0.25 }), ...p.fracture };
      if (f.rebuildAt !== null && f.rebuildAt <= f.collapseAt) throw new AgentError("invalid_params", "rebuildAt must be after collapseAt (or null to stay down).");
      changes.fracture = f;
      if (!o.physics || o.physics.body !== "dynamic") changes.physics = { ...(o.physics ?? { mass: 2000, friction: 0.7, bounce: 0.15 }), body: "dynamic" };
    }
    if (p.blocks === null) changes.blocks = null;
    else if (p.blocks) {
      if (o.geometry?.kind !== "area") throw new AgentError("invalid_params", "Only building areas given thickness can move as blocks.");
      const merged = { ...(o.blocks ?? DEFAULT_BLOCKS), ...p.blocks } as Record<string, unknown>;
      for (const k of ["height", "offset"]) if (merged[k] === null) delete merged[k];
      const bl = merged as unknown as Blocks3D;
      if (bl.stopAt !== null && bl.stopAt <= bl.startAt) throw new AgentError("invalid_params", "stopAt must be after startAt (or null to keep moving).");
      changes.blocks = bl;
    }
    if (p.light) {
      if (!o.light) throw new AgentError("invalid_params", `“${o.name}” isn't a light.`);
      const { intensity, ...rest } = p.light;
      changes.light = { ...o.light, ...rest, ...(intensity !== undefined ? { intensity: at(o.light.intensity, intensity) } : {}) } satisfies Light3D;
    }
    if (!Object.keys(changes).length) throw new AgentError("invalid_params", "Nothing to change.");
    ctx.edit(() => st().apply({ type: "object3d.update", args: { sceneId: scene.id, objectId: o.id, changes } }, { label: `Change “${o.name}”` }));
    return { object: objectInfo(project().scenes3d![scene.id]!.objects[o.id]!, t), revision: currentRevision() };
  },
});

method({
  name: "scene3d.objectKeyframe",
  summary: "Animate a 3D object: set position/rotation/scale/color/glow/intensity at a time (seconds into the 3D layer), adding a keyframe. ease applies to motion leaving this key.",
  params: z.object({
    scene: z.string(),
    object: z.string(),
    property: z.enum(["position", "rotation", "scale", "color", "glow", "intensity"]),
    seconds: z.number().min(0),
    value: z.union([z.number(), z.array(z.number())]),
    ease: z.enum(["ease", "linear", "ease-in", "ease-out", "hold"]).optional(),
    remove: z.boolean().optional(),
  }),
  mutates: true,
  example: { scene: "Wall 1 in 3D", object: "Key light", property: "position", seconds: 6, value: [-6, 6, 6], ease: "ease" },
  run: (p, ctx) => {
    const { scene, layer } = scene3d(p.scene);
    const o = object3d(scene, p.object);
    const fps = currentComp(st())!.frameRate;
    const t = snapToFrame(secondsToTime(p.seconds), fps);
    const pick = (): { prop: AnimProp; put: (np: AnimProp) => Record<string, unknown> } => {
      switch (p.property) {
        case "position":
        case "rotation":
        case "scale":
          return { prop: o[p.property], put: (np) => ({ [p.property]: np }) };
        case "color":
        case "glow":
          if (!o.material) throw new AgentError("invalid_params", `“${o.name}” has no material.`);
          return { prop: o.material[p.property], put: (np) => ({ material: { ...o.material!, [p.property]: np } }) };
        case "intensity":
          if (!o.light) throw new AgentError("invalid_params", `“${o.name}” isn't a light.`);
          return { prop: o.light.intensity, put: (np) => ({ light: { ...o.light!, intensity: np } }) };
      }
    };
    void layer;
    const { prop, put } = pick();
    const like = prop.value as PropValue;
    const value = (typeof like === "number" ? (Array.isArray(p.value) ? p.value[0] : p.value) : p.property === "scale" && !Array.isArray(p.value) ? [p.value, p.value, p.value] : Array.isArray(p.value) ? like.map((x, i) => (p.value as number[])[i] ?? x) : like.map(() => p.value)) as PropValue;
    let next: AnimProp;
    if (p.remove) {
      const k = keyAt(prop, t);
      if (!k) throw new AgentError("not_found", "No keyframe at that time.");
      next = toggleKeyAt(prop, t);
    } else {
      next = setPropAt(prop.keyframes?.length ? prop : toggleKeyAt(prop, 0), t, value);
      if (p.ease) {
        const k = keyAt(next, t);
        if (k) next = setKeyEase(next, k.id, p.ease);
      }
    }
    ctx.edit(() => st().apply({ type: "object3d.update", args: { sceneId: scene.id, objectId: o.id, changes: put(next) } }, { label: `Animate ${p.property} of “${o.name}”` }));
    return { object: o.id, property: p.property, keyframes: (next.keyframes ?? []).map((k) => ({ seconds: r2(timeToSeconds(k.t)), value: k.v, out: k.out })), revision: currentRevision() };
  },
});

method({
  name: "scene3d.layer",
  summary: "Move or lengthen the 3D layer (seconds in the scene), and choose whether pieces stay inside the area (contain) or may extend beyond it. Projector blackout areas apply either way.",
  params: z.object({ scene: z.string(), startSeconds: z.number().min(0).optional(), seconds: z.number().min(0.5).optional(), contain: z.boolean().optional() }),
  mutates: true,
  run: (p, ctx) => {
    const { scene, layer } = scene3d(p.scene);
    const l = needLayer(layer, scene);
    const comp = currentComp(st())!;
    if (p.startSeconds !== undefined || p.seconds !== undefined) {
      const start = p.startSeconds !== undefined ? snapToFrame(secondsToTime(p.startSeconds), comp.frameRate) : l.startTime;
      const len = p.seconds !== undefined ? secondsToTime(p.seconds) : l.outPoint - l.startTime;
      ctx.edit(() => st().apply({ type: "layer.update", args: { compId: comp.id, layerId: l.id, changes: { startTime: start, inPoint: start, outPoint: Math.min(comp.duration, start + len) } } }, { label: "Retime 3D layer" }));
    }
    if (p.contain !== undefined) ctx.edit(() => setContain(currentComp(st())!.layers[l.id]!, p.contain!));
    const now = currentComp(st())!.layers[l.id]!;
    return { layer: l.id, startSeconds: r2(timeToSeconds(now.startTime)), seconds: r2(timeToSeconds(now.outPoint - now.startTime)), contained: now.masks.some((m) => m.id === "contain"), revision: currentRevision() };
  },
});

// ---- preparation (simulations and physics) -----------------------------------------------------------

const FRAME_JOB_ACTIVE = ["waiting", "preparing", "checking", "paused"];
const prepStatus = () => {
  const p = st().project;
  const status = useSims.getState().status;
  const names: Record<string, string> = {};
  for (const c of Object.values(p?.compositions ?? {})) for (const l of Object.values(c.layers)) names[l.id] = `${c.name} / ${l.name}`;
  const items = Object.entries(status).map(([layer, s]) => ({ layer, name: names[layer] ?? layer, done: s.done, total: s.total, ready: s.done >= s.total }));
  const job = usePrepare.getState().job;
  const frames = job
    ? { target: job.target, scene: job.compId, name: job.name, resolution: job.resolution, quality: job.quality, state: job.state, phase: job.phase, done: job.done, total: job.total, rendered: job.rendered, failedFrames: job.failedFrames, fps: job.fps, etaSeconds: job.etaSeconds, diskBytes: job.diskBytes, ...(job.timing ? { timing: job.timing } : {}), ...(job.reason ? { reason: job.reason } : {}) }
    : null;
  // Ready: simulations and physics prepared, and any frame preparation finished.
  return { ready: items.every((i) => i.ready) && !(job && FRAME_JOB_ACTIVE.includes(job.state)), items, frames };
};

method({
  name: "prepare.status",
  summary: "Preparation of simulations (smoke, water) and 3D physics: frames done per layer.",
  params: z.object({}),
  run: () => prepStatus(),
});

method({
  name: "preview.recommend",
  summary:
    "Cache settings recommended for this computer (graphics card and its memory, the computer's memory, free space on the drive preview frames go on), what they hold of the current scene and the whole show, and why. apply: true uses them (every amount stays adjustable with preview.set).",
  params: z.object({ apply: z.boolean().optional() }),
  run: async (p) => {
    const ctx = await computePlan();
    if (p.apply) applyPlan(ctx.plan);
    const s = usePreview.getState();
    return {
      hardware: { ...ctx.hardware, gpu: ctx.hardware.gpu ? { ...ctx.hardware.gpu, gb: Math.round(ctx.hardware.gpu.bytes / 1024 ** 3) } : null },
      drive: ctx.space,
      recommended: ctx.plan,
      current: { frameCacheMB: s.cacheBudgetMB, videoCacheMB: s.videoCacheMB, diskCache: s.diskCache, diskCacheGB: s.diskCacheGB, diskCacheFolder: s.diskCacheFolder, resolution: s.resolution, playbackMode: s.playbackMode },
      applied: !!p.apply,
    };
  },
});

method({
  name: "prepare.frames",
  summary:
    "Prepare a whole scene (target scene: the current one, or `scene`) or the whole show (target show) for smooth playback: simulations first, then every frame rendered once at a preview size and kept in the disk cache (it plays smoothly even after restarting; edits re-prepare only what they change). Frames already on disk are skipped, so starting again resumes. Runs in the background: follow it with prepare.status or prepare.wait. Refuses (state failed, with the reason) when the disk cache can't hold every frame, unless raiseDiskLimit (default true) can raise it within the drive's free space.",
  params: z.object({
    target: z.enum(["scene", "show"]),
    scene: z.string().optional().describe("target scene: a scene id or name (default the current one)"),
    resolution: z.enum(["full", "half", "quarter"]).optional().describe("default: the preview's size (Auto counts as Full)"),
    raiseDiskLimit: z.boolean().optional(),
  }),
  long: true,
  run: async (p) => {
    const pr = project();
    const sceneId = p.scene ? (pr.compositions[p.scene] ? p.scene : Object.values(pr.compositions).find((c) => c.name === p.scene)?.id) : undefined;
    if (p.scene && !sceneId) throw new AgentError("not_found", `No scene "${p.scene}".`);
    try {
      await startPreparing({ target: p.target, ...(sceneId ? { compId: sceneId } : {}), ...(p.resolution ? { resolution: p.resolution } : {}), raiseDiskLimit: p.raiseDiskLimit ?? true });
    } catch (e) {
      throw new AgentError("rejected", String((e as Error)?.message ?? e));
    }
    return prepStatus();
  },
});

method({
  name: "prepare.stop",
  summary: "Stop, pause or resume frame preparation (prepare.frames). Frames already prepared stay on disk; starting again carries on.",
  params: z.object({ action: z.enum(["stop", "pause", "resume"]).optional() }),
  run: (p) => {
    if ((p.action ?? "stop") === "stop") stopPreparing();
    else pausePreparing(p.action === "pause");
    return prepStatus();
  },
});

method({
  name: "prepare.wait",
  summary: "Wait until every simulation and 3D physics layer is prepared and any frame preparation (prepare.frames) has finished, or timeoutMs. Long preparations: call again (each call waits at most 30 minutes).",
  params: z.object({ timeoutMs: z.number().int().min(0).max(1_800_000).optional() }),
  long: true,
  run: async (p) => {
    const t0 = performance.now();
    await sleep(600); // let a just-made edit start re-preparing
    while (!prepStatus().ready && performance.now() - t0 < (p.timeoutMs ?? 120_000)) await sleep(200);
    return { ...prepStatus(), waitedMs: Math.round(performance.now() - t0) };
  },
});

// ---- playback and preview -------------------------------------------------------------------------------

method({
  name: "playback.get",
  summary: "Playhead (seconds), playing, preview range, loop, current scene.",
  params: z.object({}),
  run: () => {
    const s = st();
    return { seconds: r2(timeToSeconds(s.time)), playing: s.playing, loop: s.loop, range: s.range ? { start: r2(timeToSeconds(s.range.start)), end: r2(timeToSeconds(s.range.end)) } : null, scene: s.compId };
  },
});

method({
  name: "playback.set",
  summary: "Seek (seconds), play/pause, loop, or set the preview range ({start,end} seconds, null for the whole scene).",
  params: z.object({ seconds: z.number().min(0).optional(), playing: z.boolean().optional(), loop: z.boolean().optional(), range: z.object({ start: z.number().min(0), end: z.number().min(0) }).nullable().optional() }),
  run: (p) => {
    const s = st();
    if (p.seconds !== undefined) s.setTime(secondsToTime(p.seconds));
    if (p.range !== undefined) s.setRange(p.range ? { start: secondsToTime(p.range.start), end: secondsToTime(p.range.end) } : null);
    if (p.loop !== undefined) s.setLoop(p.loop);
    if (p.playing !== undefined) s.setPlaying(p.playing);
    return { seconds: r2(timeToSeconds(st().time)), playing: st().playing };
  },
});

method({
  name: "preview.get",
  summary: "Preview settings and what it actually renders: view, resolution choice, rendered size, frames per second (and skipped frames), playback mode and cache amounts.",
  params: z.object({}),
  run: () => {
    const s = usePreview.getState();
    const stats = usePreviewStats.getState();
    return {
      view: s.view,
      resolution: s.resolution,
      customScale: s.customScale,
      effectQuality: s.effectQuality,
      renderedSize: stats.size,
      achievedFps: stats.achievedFps,
      targetFps: stats.targetFps,
      dropped: stats.dropped,
      mode: stats.mode,
      cacheFrames: stats.cacheFrames,
      buffering: stats.mode === "preparing" && s.diskCache ? stats.preparing : null,
      diskReadMs: stats.diskReadMs,
      orbit: s.orbit,
      playbackMode: s.playbackMode,
      frameCacheGB: s.cacheBudgetMB / 1024,
      videoCacheGB: s.videoCacheMB / 1024,
      diskCache: s.diskCache,
      diskCacheGB: s.diskCacheGB,
      diskCacheFolder: s.diskCacheFolder,
    };
  },
});

method({
  name: "preview.set",
  summary: "Preview view (show, 3d inspection, projector), resolution (auto, full, half, quarter, eighth, custom with customScale), effect quality, 3D orbit, playback mode and cache amounts (graphics memory and disk). Never changes the project or export size.",
  params: z.object({
    view: z.enum(["show", "venue", "3d", "projector"]).optional(),
    resolution: z.enum(["auto", "full", "half", "quarter", "eighth", "custom"]).optional(),
    customScale: z.number().min(0.05).max(1).optional(),
    effectQuality: z.enum(["full", "draft"]).optional(),
    orbit: z.object({ yaw: z.number(), pitch: z.number(), distance: z.number(), panX: z.number(), panY: z.number() }).partial().optional(),
    playbackMode: z.enum(["realtime", "cache"]).optional().describe("cache: prepare frames first and play smoothly"),
    frameCacheGB: z.number().min(0.25).optional().describe("graphics memory for finished frames (any amount; see preview.recommend)"),
    videoCacheGB: z.number().min(0.25).optional().describe("graphics memory for decoded video frames"),
    diskCache: z.boolean().optional().describe("also keep finished frames on disk"),
    diskCacheGB: z.number().min(1).optional(),
    diskCacheFolder: z.string().nullable().optional().describe("a folder for preview frames, or null for the data folder's Cache\\preview"),
  }),
  run: (p) => {
    const s = usePreview.getState();
    s.set({
      ...(p.view ? { view: p.view } : {}),
      ...(p.resolution ? { resolution: p.resolution } : {}),
      ...(p.customScale ? { customScale: p.customScale } : {}),
      ...(p.effectQuality ? { effectQuality: p.effectQuality } : {}),
      ...(p.orbit ? { orbit: { ...s.orbit, ...p.orbit } } : {}),
      ...(p.playbackMode ? { playbackMode: p.playbackMode } : {}),
      ...(p.frameCacheGB !== undefined ? { cacheBudgetMB: Math.round(p.frameCacheGB * 1024) } : {}),
      ...(p.videoCacheGB !== undefined ? { videoCacheMB: Math.round(p.videoCacheGB * 1024) } : {}),
      ...(p.diskCache !== undefined ? { diskCache: p.diskCache } : {}),
      ...(p.diskCacheGB !== undefined ? { diskCacheGB: p.diskCacheGB } : {}),
      ...(p.diskCacheFolder !== undefined ? { diskCacheFolder: p.diskCacheFolder } : {}),
    });
    const n = usePreview.getState();
    return { view: n.view, resolution: n.resolution, orbit: n.orbit, playbackMode: n.playbackMode, frameCacheGB: n.cacheBudgetMB / 1024, videoCacheGB: n.videoCacheMB / 1024, diskCache: n.diskCache, diskCacheGB: n.diskCacheGB, diskCacheFolder: n.diskCacheFolder };
  },
});

/** Encode preview pixels (canvas format) as PNG bytes. */
const toPng = async (px: Uint8Array, w: number, h: number): Promise<Uint8Array> => {
  const rgba = new Uint8ClampedArray(px.length);
  const bgra = navigator.gpu.getPreferredCanvasFormat() === "bgra8unorm";
  for (let i = 0; i < px.length; i += 4) {
    rgba[i] = px[i + (bgra ? 2 : 0)]!;
    rgba[i + 1] = px[i + 1]!;
    rgba[i + 2] = px[i + (bgra ? 0 : 2)]!;
    rgba[i + 3] = 255;
  }
  const c = new OffscreenCanvas(w, h);
  c.getContext("2d")!.putImageData(new ImageData(rgba, w, h), 0, 0);
  return new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
};

method({
  name: "preview.capture",
  summary: "Capture the preview exactly as rendered (current view and resolution) at a time (seconds; default the playhead), waiting until media and prepared physics are loaded. Saves a PNG; inline returns it as base64 too.",
  params: z.object({ seconds: z.number().min(0).optional(), view: z.enum(["show", "venue", "3d", "projector"]).optional(), projector: z.string().optional().describe("for the projector view: which projector (name or id)"), inline: z.boolean().optional(), path: z.string().optional(), timeoutMs: z.number().int().min(0).max(120_000).optional() }),
  long: true,
  run: async (p) => {
    const s = st();
    const loop = currentPreviewLoop();
    if (!loop) throw new AgentError("unavailable", "The preview isn't open.");
    if (p.view) usePreview.getState().set({ view: p.view });
    if (p.projector) useProjectorPick.setState({ id: projectorRef(p.projector).id });
    if (p.seconds !== undefined) {
      s.setPlaying(false);
      s.setTime(secondsToTime(p.seconds));
    }
    const r = await getRenderer();
    const t0 = performance.now();
    let shot = await loop.sample();
    // Wait for video frames, the photo and prepared physics, so the capture is the real frame.
    while ((r.lastFrameIncomplete || !shot.pixels) && performance.now() - t0 < (p.timeoutMs ?? 20_000)) {
      await sleep(150);
      shot = await loop.sample();
    }
    if (!shot.pixels) throw new AgentError("unavailable", "The preview couldn't be captured.");
    const png = await toPng(shot.pixels, shot.width, shot.height);
    const dir = `${(await window.be.app.paths()).renders}\\agent-captures`;
    const path = p.path ?? `${dir}\\capture ${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    await window.be.files.writeBinary(path, png);
    const stats = usePreviewStats.getState();
    return {
      path,
      width: shot.width,
      height: shot.height,
      seconds: r2(timeToSeconds(st().time)),
      view: usePreview.getState().view,
      resolution: usePreview.getState().resolution,
      renderedSize: stats.size,
      complete: !r.lastFrameIncomplete,
      ...(p.inline ? { pngBase64: btoa(Array.from(png, (b) => String.fromCharCode(b)).join("")) } : {}),
    };
  },
});

// ---- exports and jobs -----------------------------------------------------------------------------------

const jobInfo = (j: Awaited<ReturnType<typeof window.be.render.list>>[number]) => ({
  id: j.id,
  name: j.name,
  state: j.state,
  phase: j.phase,
  done: j.done,
  frames: j.frames,
  fps: j.fps,
  etaSeconds: j.etaSeconds,
  output: j.output,
  result: j.result,
  sizeBytes: j.sizeBytes,
  error: j.error,
  checks: j.verify?.checks.map((c) => ({ name: c.name, ok: c.ok, actual: c.actual })),
  delivery: j.delivery,
});

method({
  name: "export.start",
  summary: "Export in the background from a frozen copy of the show (keep editing meanwhile). purpose: share (MP4), master (ProRes 422 HQ), transparent (ProRes 4444), projector (warped for the projector). Returns the job id and output path.",
  params: z.object({
    scene: z.string().optional().describe("scene id/name, 'current' or 'show' (default current)"),
    purpose: z.enum(["share", "master", "transparent", "projector"]).optional(),
    size: z.enum(["full", "half", "quarter"]).optional(),
    range: z.object({ startSeconds: z.number().min(0), endSeconds: z.number().min(0) }).optional(),
    output: z.string().optional(),
    hap: z.boolean().optional(),
    projector: z.string().optional().describe("purpose projector: which projector (name or id; default the current one). Call once per projector for several."),
    sendToDrive: z.boolean().optional().describe("when finished, copy it into Before Effects' Exports folder in Google Drive (see the job's delivery)"),
  }),
  mutates: false,
  long: true,
  run: async (p) => {
    const pr = project();
    const s = st();
    // Rendering reads local files only: media still in Google Drive is copied first (drive.localize).
    const inDrive = await driveMediaInUse();
    if (inDrive.length) throw new AgentError("drive_media", `${inDrive.length} file${inDrive.length > 1 ? "s are" : " is"} read straight from Google Drive (${inDrive.slice(0, 3).map((x) => x.asset.name).join(", ")}${inDrive.length > 3 ? ", …" : ""}). Copy ${inDrive.length > 1 ? "them" : "it"} to the local media folder first with drive.localize.`);
    if (p.sendToDrive && !(await window.be.drive.status()).myDrive) throw new AgentError("unavailable", "Google Drive for desktop isn't installed or signed in, so there's nowhere to send the export.");
    const sid = p.scene === "show" ? Object.values(pr.compositions).find((c) => c.show)?.id : p.scene && p.scene !== "current" ? (pr.compositions[p.scene] ? p.scene : Object.values(pr.compositions).find((c) => c.name === p.scene)?.id) : s.compId;
    const comp = sid ? pr.compositions[sid] : undefined;
    if (!comp) throw new AgentError("not_found", `No scene "${p.scene}".`);
    const o = OUTCOMES.find((x) => x.id === (p.purpose ?? "share"))!;
    const venue = activeVenue({ project: pr });
    const projector = p.projector ? projectorRef(p.projector) : currentProjector(venue);
    if (o.id === "projector" && !projector) throw new AgentError("rejected", "There's no projector set up for this building.");
    const start = p.range ? timeToFrame(secondsToTime(p.range.startSeconds), comp.frameRate) : 0;
    const end = p.range ? timeToFrame(secondsToTime(p.range.endSeconds), comp.frameRate) : framesIn(comp.duration, comp.frameRate);
    const frames = Math.max(1, end - start);
    const f = o.id === "projector" ? 1 : SIZES.find((x) => x.id === (p.size ?? "full"))!.f;
    const full = o.id === "projector" && projector ? { width: projector.output.width, height: projector.output.height } : { width: comp.width, height: comp.height };
    const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
    const preset = o.id === "projector" && p.hap ? "hap" : o.preset;
    const ext = preset.startsWith("prores") || preset === "hap" ? "mov" : "mp4";
    const dir = (await window.be.app.paths()).renders;
    const output = p.output ?? `${dir}\\${pr.name.replace(/[<>:"/\\|?*]+/g, "-")} - ${comp.name.replace(/[<>:"/\\|?*]+/g, "-")} - ${o.suffix} ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`;
    const seconds = frames / (comp.frameRate.num / comp.frameRate.den);
    const id = await window.be.render.enqueue({
      name: `${pr.name} — ${comp.name} — ${o.title}`,
      outcome: o.id,
      preset,
      compId: comp.id,
      target: o.id === "projector" && venue && projector ? { kind: "projector", venueId: venue.id, projectorId: projector.id } : { kind: "master", keepAlpha: o.alpha },
      output,
      width: full.width,
      height: full.height,
      ...(f < 1 ? { deliverSize: { width: even(full.width * f), height: even(full.height * f) } } : {}),
      frameRate: comp.frameRate,
      startFrame: start,
      frames,
      alpha: o.alpha,
      withAudio: hasAudio(pr, comp.id),
      estimatedBytes: Math.round(((o.mbps * 1e6) / 8) * seconds * f * f),
      snapshot: JSON.stringify(pr),
      ...(p.sendToDrive ? { sendToDrive: true } : {}),
    });
    return { job: id, output, frames, width: f < 1 ? even(full.width * f) : full.width, height: f < 1 ? even(full.height * f) : full.height, sound: hasAudio(pr, comp.id) };
  },
});

method({
  name: "jobs.list",
  summary: "Background exports: state, progress, output file, checks, delivery.",
  params: z.object({}),
  run: async () => (await window.be.render.list()).map(jobInfo),
});

method({
  name: "jobs.get",
  summary: "One export job.",
  params: z.object({ job: z.string() }),
  run: async (p) => {
    const j = (await window.be.render.list()).find((x) => x.id === p.job);
    if (!j) throw new AgentError("not_found", `No job "${p.job}".`);
    return jobInfo(j);
  },
});

method({
  name: "jobs.cancel",
  summary: "Cancel an export (its partial file is removed).",
  params: z.object({ job: z.string() }),
  run: async (p) => {
    await window.be.render.cancel(p.job);
    return { cancelled: p.job };
  },
});

method({
  name: "jobs.retry",
  summary: "Retry a failed or cancelled export (a new job from the same snapshot).",
  params: z.object({ job: z.string() }),
  run: async (p) => ({ job: await window.be.render.retry(p.job) }),
});

method({
  name: "jobs.wait",
  summary: "Wait until an export finishes (done, failed or cancelled) or timeoutMs; returns the job.",
  params: z.object({ job: z.string(), timeoutMs: z.number().int().min(0).max(1_800_000).optional() }),
  long: true,
  run: async (p) => {
    const t0 = performance.now();
    for (;;) {
      const j = (await window.be.render.list()).find((x) => x.id === p.job);
      if (!j) throw new AgentError("not_found", `No job "${p.job}".`);
      if (j.state === "done" || j.state === "failed" || j.state === "cancelled" || performance.now() - t0 > (p.timeoutMs ?? 600_000)) return { ...jobInfo(j), waitedMs: Math.round(performance.now() - t0) };
      await sleep(300);
    }
  },
});


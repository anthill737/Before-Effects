/**
 * Moving parts in the studio: make a door swing, a garage door raise, a window push in… Each scene
 * of the show gets one "house parts" 3D layer (at the bottom, so content on areas draws over it)
 * holding the facade with its openings cut out, the moving parts and what's behind them. The
 * traced areas are never changed; undo removes a part like any other edit.
 */
import {
  type Backing,
  type Composition,
  DEFAULT_TIMING,
  defaultBacking,
  defaultMotion,
  type Layer,
  newId,
  type Object3D,
  type Op,
  type PartInfo,
  type PartMotion,
  partObjects,
  partsScene,
  type PartTiming,
  stillId,
  stillObject,
  type Region,
  type RGBA,
  type Scene3D,
  secondsToTime,
  staticProp,
  type Vec3,
} from "@be/core";
import { use3D } from "./actions3d.ts";
import { activeVenue, currentComp, useStudio } from "./store.ts";

export const MOVES: Record<PartMotion["kind"], string> = { swing: "Swing open", raise: "Raise", push: "Push in", slide: "Slide away", turn: "Turn around", fall: "Fall off" };

/** The scene's house-parts layer and its 3D scene, if it has one. */
export const partsLayer = (comp: Composition | undefined): { layer: Layer; scene: Scene3D } | null => {
  const p = useStudio.getState().project;
  if (!comp || !p) return null;
  for (const id of comp.layerOrder) {
    const l = comp.layers[id];
    const sc = l?.source.kind === "scene3d" ? p.scenes3d?.[l.source.sceneId] : undefined;
    if (l && sc?.purpose === "parts") return { layer: l, scene: sc };
  }
  return null;
};

/** The facade: the wall area with openings cut out of it (the largest such area). */
const facadeOf = (regions: readonly Region[]) =>
  regions
    .filter((r) => r.kind === "wall" && r.path.closed && !r.proposal)
    .sort((a, b) => (b.cutouts?.length ?? 0) - (a.cutouts?.length ?? 0) || span(b) - span(a))[0];
const span = (r: Region) => {
  const xs = r.path.vertices.map((v) => v.p[0]), ys = r.path.vertices.map((v) => v.p[1]);
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
};

/** Operations creating the parts layer (and its scene) when the current scene has none. */
const partsLayerOps = (comp: Composition): { ops: Op[]; sceneId: string; layerId: string } => {
  const s = useStudio.getState();
  const venue = activeVenue(s)!;
  const sceneId = newId("s3d");
  const facade = facadeOf(Object.values(venue.regions));
  const stills = (facade?.cutouts ?? []).map((id) => venue.regions[id]).filter((r): r is Region => !!r).map((r) => ({ regionId: r.id, name: r.name, kind: r.kind }));
  const scene = partsScene(s.project!, { sceneId, name: "House parts", ...(facade ? { facadeId: facade.id, stills } : {}), venueId: venue.id, canvas: venue.canvas });
  const layerId = newId("layer");
  const layer: Layer = {
    id: layerId,
    name: "House parts (3D)",
    source: { kind: "scene3d", sceneId },
    startTime: 0,
    inPoint: 0,
    outPoint: comp.duration,
    stretch: 1,
    enabled: true,
    solo: false,
    locked: false,
    audioEnabled: false,
    is3D: false,
    blendMode: "normal",
    transform: { anchor: staticProp<Vec3>([0, 0, 0]), position: staticProp<Vec3>([0, 0, 0], true), scale: staticProp<Vec3>([100, 100, 100]), rotation: staticProp<Vec3>([0, 0, 0]), opacity: staticProp(100) },
    masks: [],
    effects: [],
  };
  return { ops: [{ type: "scene3d.add", args: { scene } }, { type: "layer.add", args: { compId: comp.id, layer, index: comp.layerOrder.length } }], sceneId, layerId };
};

/** The part made from an area in this scene, if any. */
export const partFor = (scene: Scene3D | undefined, regionId: string): Object3D | undefined =>
  scene ? scene.objectOrder.map((id) => scene.objects[id]!).find((o) => o?.part?.regionId === regionId) : undefined;

/** The average colour of the photo just around an area (for a backing that looks like the wall). */
export const wallColorAround = async (regionId: string): Promise<RGBA> => {
  const s = useStudio.getState();
  const venue = activeVenue(s)!;
  const r = venue.regions[regionId];
  const ref = venue.referenceAssetId ? s.project!.assets[venue.referenceAssetId] : undefined;
  if (!r || !ref) return [0.5, 0.5, 0.5, 1];
  const bmp = await createImageBitmap(new Blob([(await window.be.files.readFile(ref.path)) as BlobPart]));
  const xs = r.path.vertices.map((v) => v.p[0]), ys = r.path.vertices.map((v) => v.p[1]);
  const pad = Math.max(8, (Math.max(...xs) - Math.min(...xs)) * 0.08);
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad)), y0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
  const x1 = Math.min(bmp.width, Math.ceil(Math.max(...xs) + pad)), y1 = Math.min(bmp.height, Math.ceil(Math.max(...ys) + pad));
  const c = new OffscreenCanvas(Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  bmp.close();
  const d = g.getImageData(0, 0, c.width, c.height).data;
  // Only the ring outside the area's own box.
  const ix0 = Math.min(...xs) - x0, iy0 = Math.min(...ys) - y0, ix1 = Math.max(...xs) - x0, iy1 = Math.max(...ys) - y0;
  let n = 0, R = 0, G = 0, B = 0;
  for (let y = 0; y < c.height; y++)
    for (let x = 0; x < c.width; x++) {
      if (x >= ix0 && x <= ix1 && y >= iy0 && y <= iy1) continue;
      const i = (y * c.width + x) * 4;
      if (d[i + 3]! < 128) continue;
      R += (d[i]! / 255) ** 2.2;
      G += (d[i + 1]! / 255) ** 2.2;
      B += (d[i + 2]! / 255) ** 2.2;
      n++;
    }
  if (!n) return [0.5, 0.5, 0.5, 1];
  return [(R / n) ** (1 / 2.2), (G / n) ** (1 / 2.2), (B / n) ** (1 / 2.2), 1];
};

/**
 * Make an area move in 3D (or change how it moves). Creates the scene's parts layer the first time.
 * Returns the part's object id.
 */
export const animatePart = (regionId: string, opts: { motion?: PartMotion; timing?: Partial<PartTiming>; backing?: Backing } = {}): string | null => {
  const s = useStudio.getState();
  const comp = currentComp(s);
  const venue = activeVenue(s);
  const r = venue?.regions[regionId];
  if (!s.project || !comp || !venue || !r || !r.path.closed) return null;
  const ops: Op[] = [];
  let found = partsLayer(comp);
  let sceneId = found?.scene.id;
  let layerId = found?.layer.id;
  if (!found) {
    const made = partsLayerOps(comp);
    ops.push(...made.ops);
    sceneId = made.sceneId;
    layerId = made.layerId;
  }
  // The opening's still copy gives way to the moving part.
  const still = stillId(sceneId!, regionId);
  const hasStill = found ? !!found.scene.objects[still] : !!(ops[0]?.args as { scene: Scene3D }).scene.objects[still];
  if (hasStill) ops.push({ type: "object3d.remove", args: { sceneId, objectId: still } });
  const existing = partFor(found?.scene, regionId);
  const prev = existing?.part;
  const motion = opts.motion ?? prev?.motion ?? defaultMotion(r.kind);
  const timing: PartTiming = { ...DEFAULT_TIMING, ...(prev?.timing ?? { start: Math.max(0, Math.round((s.time / 705_600_000) * 10) / 10) }), ...opts.timing };
  const backing = opts.backing ?? prev?.backing ?? defaultBacking(r.kind);
  const id = existing?.id ?? newId("part");
  const backingId = prev?.backingId ?? newId("behind");
  const objs = partObjects(s.project, { id, backingId, name: r.name, regionId, kind: r.kind, venueId: venue.id, canvas: venue.canvas, motion, timing, backing });
  if (!objs) return null;
  const [part, back] = objs;
  if (existing) {
    // Replace the motion; the part keeps its id (and any material changes made to it).
    const { id: _a, kind: _b, material: _m, ...changes } = part;
    ops.push({ type: "object3d.update", args: { sceneId, objectId: id, changes: { ...changes, fracture: part.fracture ?? null } } });
    const oldBack = found!.scene.objects[backingId];
    if (oldBack) {
      const { id: _c, kind: _d, ...bc } = back;
      ops.push({ type: "object3d.update", args: { sceneId, objectId: backingId, changes: bc } });
    } else ops.push({ type: "object3d.add", args: { sceneId, object: back } });
  } else ops.push({ type: "object3d.add", args: { sceneId, object: back } }, { type: "object3d.add", args: { sceneId, object: part } });
  const tx = s.apply(ops, { label: existing ? `Change how “${r.name}” moves` : `${MOVES[motion.kind]}: “${r.name}”` });
  if (!tx) return null;
  if (s.step === "space") useStudio.setState({ step: "animate" });
  s.selectLayer(layerId!);
  use3D.setState({ objectId: id });
  return id;
};

export const updatePart = (objectId: string, changes: { motion?: PartMotion; timing?: Partial<PartTiming>; backing?: Backing }) => {
  const found = partsLayer(currentComp(useStudio.getState()));
  const info: PartInfo | undefined = found?.scene.objects[objectId]?.part;
  if (!info) return null;
  return animatePart(info.regionId, { ...changes, ...(changes.timing ? { timing: { ...info.timing, ...changes.timing } } : {}) });
};

/** Stop an area moving: remove its part and what's behind it (an opening of the facade gets its still photo back). */
export const removePart = (objectId: string) => {
  const s = useStudio.getState();
  const found = partsLayer(currentComp(s));
  const o = found?.scene.objects[objectId];
  if (!found || !o?.part) return;
  const ops: Op[] = [{ type: "object3d.remove", args: { sceneId: found.scene.id, objectId } }];
  if (o.part.backingId && found.scene.objects[o.part.backingId]) ops.push({ type: "object3d.remove", args: { sceneId: found.scene.id, objectId: o.part.backingId } });
  // An opening of the facade shows its still photo again.
  const venue = activeVenue(s)!;
  const r = venue.regions[o.part.regionId];
  if (r && Object.values(venue.regions).some((x) => x.cutouts?.includes(r.id))) ops.push({ type: "object3d.add", args: { sceneId: found.scene.id, object: stillObject(found.scene.id, r.id, r.name, r.kind) } });
  s.apply(ops, { label: `Stop “${o.name}” moving` });
  use3D.setState({ objectId: null });
};

export const secondsLabel = (t: PartTiming) => `${t.start}–${Math.round((t.start + t.move) * 10) / 10} s${t.back ? `, back at ${Math.round((t.start + t.move + t.hold) * 10) / 10}–${Math.round((t.start + 2 * t.move + t.hold) * 10) / 10} s` : ""}`;
export const at = secondsToTime;

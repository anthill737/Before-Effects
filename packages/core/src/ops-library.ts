/**
 * The built-in operations. Each one is small, validated and undoable; composite behaviour (recipes,
 * assistant requests) is built by combining them inside one transaction.
 */
import { z } from "zod";
import type { Draft } from "immer";
import type { AnimProp, Keyframe, PropValue } from "./anim.ts";
import { evalKeyframes } from "./anim.ts";
import type {
  Asset,
  Calibration,
  Composition,
  EffectInstance,
  Id,
  Layer,
  Marker,
  Mask,
  Project,
  Projector,
  Region,
  RegionGroup,
  Venue,
} from "./model.ts";
import { defineOp, OpError } from "./ops.ts";
import { getAt, setAt } from "./paths.ts";
import type { Flicks } from "./time.ts";

const id = z.string().min(1);
const num = z.number().finite();
const vec2 = z.tuple([num, num]);
const propValue = z.union([num, z.array(num)]);

const obj = <T>(what: string) =>
  z.custom<T>((v) => !!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string", {
    message: `expected a ${what} object with an id`,
  });

// ---------------------------------------------------------------------------------------------
// Lookups that fail with plain-language errors

const comp = (d: Draft<Project>, compId: Id) => {
  const c = d.compositions[compId];
  if (!c) throw new OpError("That scene no longer exists.", `composition ${compId}`);
  return c;
};
const layerOf = (d: Draft<Project>, compId: Id, layerId: Id) => {
  const l = comp(d, compId).layers[layerId];
  if (!l) throw new OpError("That layer no longer exists.", `layer ${layerId}`);
  return l;
};
const venueOf = (d: Draft<Project>, venueId: Id) => {
  const v = d.venues[venueId];
  if (!v) throw new OpError("That venue no longer exists.", `venue ${venueId}`);
  return v;
};
const projectorOf = (d: Draft<Project>, venueId: Id, projectorId: Id) => {
  const p = venueOf(d, venueId).projectors[projectorId];
  if (!p) throw new OpError("That projector no longer exists.", `projector ${projectorId}`);
  return p;
};
const assertUnlocked = (l: { locked: boolean; name: string }) => {
  if (l.locked) throw new OpError(`"${l.name}" is locked. Unlock it to change it.`);
};
const isAnimProp = (x: unknown): x is AnimProp =>
  !!x && typeof x === "object" && "value" in (x as object) && !("id" in (x as object));

const nameOfLayer = (p: Project, compId: Id, layerId: Id) =>
  p.compositions[compId]?.layers[layerId]?.name ?? "layer";

// ---------------------------------------------------------------------------------------------
// Project & compositions

export const projectRename = defineOp({
  type: "project.rename",
  title: "Rename show",
  description: "Rename the project.",
  args: z.object({ name: z.string().min(1).max(200) }),
  apply: (d, a) => {
    d.name = a.name;
  },
  summarize: (a) => `Renamed the show to "${a.name}".`,
});

export const compAdd = defineOp({
  type: "comp.add",
  title: "Add scene",
  description: "Add a composition (scene) to the project.",
  args: z.object({ comp: obj<Composition>("composition"), makeMain: z.boolean().optional() }),
  apply: (d, a) => {
    if (d.compositions[a.comp.id]) throw new OpError("A scene with that id already exists.");
    d.compositions[a.comp.id] = a.comp as Draft<Composition>;
    d.compositionOrder.push(a.comp.id);
    if (a.makeMain || !d.mainCompId) d.mainCompId = a.comp.id;
  },
  summarize: (a) => `Added the scene "${a.comp.name}".`,
});

export const compUpdate = defineOp({
  type: "comp.update",
  title: "Change scene settings",
  description: "Change a composition's name, size, frame rate, duration or background.",
  args: z.object({
    compId: id,
    changes: z
      .object({
        name: z.string().min(1),
        width: z.number().int().min(16).max(16384),
        height: z.number().int().min(16).max(16384),
        frameRate: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }),
        duration: z.number().int().positive(),
        background: z.tuple([num, num, num, num]),
        workArea: z.object({ start: z.number().int(), end: z.number().int() }),
      })
      .partial(),
  }),
  apply: (d, a) => {
    Object.assign(comp(d, a.compId), a.changes);
  },
  summarize: (a, p) => `Changed settings of "${p.compositions[a.compId]?.name ?? "scene"}".`,
});

export const compRemove = defineOp({
  type: "comp.remove",
  title: "Delete scene",
  description: "Remove a composition. Fails if another scene still uses it.",
  args: z.object({ compId: id }),
  apply: (d, a) => {
    const users = Object.values(d.compositions).filter((c) =>
      Object.values(c.layers).some((l) => l.source.kind === "comp" && l.source.compId === a.compId),
    );
    if (users.length > 0) throw new OpError(`This scene is used inside "${users[0]!.name}". Remove it there first.`);
    delete d.compositions[a.compId];
    d.compositionOrder = d.compositionOrder.filter((x) => x !== a.compId);
    if (d.mainCompId === a.compId) d.mainCompId = d.compositionOrder[0];
  },
});

export const markerAdd = defineOp({
  type: "marker.add",
  title: "Add marker",
  description: "Add a marker (note, beat, cue or section) to a scene's timeline.",
  args: z.object({ compId: id, marker: obj<Marker>("marker") }),
  apply: (d, a) => {
    const c = comp(d, a.compId);
    c.markers.push(a.marker as Draft<Marker>);
    c.markers.sort((x, y) => x.t - y.t);
  },
});

export const markerRemove = defineOp({
  type: "marker.remove",
  title: "Remove marker",
  description: "Remove a marker from a scene.",
  args: z.object({ compId: id, markerId: id }),
  apply: (d, a) => {
    const c = comp(d, a.compId);
    c.markers = c.markers.filter((m) => m.id !== a.markerId);
  },
});

// ---------------------------------------------------------------------------------------------
// Layers

export const layerAdd = defineOp({
  type: "layer.add",
  title: "Add layer",
  description: "Add a layer to a scene. index 0 is the top of the stack; omit to add on top.",
  args: z.object({ compId: id, layer: obj<Layer>("layer"), index: z.number().int().min(0).optional() }),
  apply: (d, a) => {
    const c = comp(d, a.compId);
    if (c.layers[a.layer.id]) throw new OpError("A layer with that id already exists.");
    c.layers[a.layer.id] = a.layer as Draft<Layer>;
    const i = Math.min(a.index ?? 0, c.layerOrder.length);
    c.layerOrder.splice(i, 0, a.layer.id);
  },
  summarize: (a) => `Added the layer "${a.layer.name}".`,
});

export const layerRemove = defineOp({
  type: "layer.remove",
  title: "Delete layer",
  description: "Remove a layer from a scene. Children are unparented and mattes using it are cleared.",
  args: z.object({ compId: id, layerId: id }),
  apply: (d, a) => {
    const c = comp(d, a.compId);
    const l = layerOf(d, a.compId, a.layerId);
    assertUnlocked(l);
    delete c.layers[a.layerId];
    c.layerOrder = c.layerOrder.filter((x) => x !== a.layerId);
    for (const other of Object.values(c.layers)) {
      if (other.parentId === a.layerId) delete other.parentId;
      if (other.trackMatte?.layerId === a.layerId) delete other.trackMatte;
    }
    const gen = l.generatedBy;
    if (gen) {
      const r = d.recipes[gen.recipeInstanceId];
      if (r) {
        delete r.generated[gen.role];
        delete r.overrides[a.layerId];
      }
    }
  },
  summarize: (a, p) => `Deleted the layer "${nameOfLayer(p, a.compId, a.layerId)}".`,
});

const layerChanges = z
  .object({
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    solo: z.boolean(),
    locked: z.boolean(),
    audioEnabled: z.boolean(),
    is3D: z.boolean(),
    blendMode: z.enum([
      "normal", "add", "screen", "multiply", "overlay", "soft-light", "hard-light", "color-dodge", "color-burn",
      "darken", "lighten", "difference", "exclusion", "hue", "saturation", "color", "luminosity", "illuminate",
    ]),
    startTime: z.number().int(),
    inPoint: z.number().int(),
    outPoint: z.number().int(),
    stretch: z.number().finite().refine((x) => x !== 0, "stretch cannot be 0"),
    parentId: z.string().nullable(),
    /** Shown only through another layer of the same scene (that layer isn't drawn itself); null: shown whole. */
    trackMatte: z.object({ layerId: z.string(), mode: z.enum(["alpha", "alpha-inverted", "luma", "luma-inverted"]) }).nullable(),
    label: z.string(),
    /** The whole clipping stack (masks) or effect stack, replaced as a unit. */
    masks: z.array(obj<Mask>("mask")),
    effects: z.array(obj<EffectInstance>("effect")),
  })
  .partial();

export const layerUpdate = defineOp({
  type: "layer.update",
  title: "Change layer",
  description:
    "Change a layer's name, visibility, solo, lock, blend mode, timing (startTime/inPoint/outPoint in flicks), speed (stretch), parent, track matte (another layer it's shown through, or null), or replace its masks or effects.",
  args: z.object({ compId: id, layerId: id, changes: layerChanges }),
  apply: (d, a, ctx) => {
    const l = layerOf(d, a.compId, a.layerId);
    if (l.locked && a.changes.locked !== false) assertUnlocked(l);
    const { parentId, trackMatte, ...rest } = a.changes;
    Object.assign(l, rest);
    if (trackMatte !== undefined) {
      if (trackMatte === null) delete l.trackMatte;
      else {
        const c = comp(d, a.compId);
        if (trackMatte.layerId === a.layerId) throw new OpError("A layer can't be shown through itself.");
        if (!c.layers[trackMatte.layerId]) throw new OpError("That matte layer isn't in this scene.");
        if (c.layers[trackMatte.layerId]!.trackMatte?.layerId === a.layerId) throw new OpError("Two layers can't each be shown through the other.");
        l.trackMatte = { layerId: trackMatte.layerId, mode: trackMatte.mode };
      }
    }
    if (parentId !== undefined) {
      if (parentId === null) delete l.parentId;
      else {
        // Refuse parent cycles.
        let p: string | undefined = parentId;
        const c = comp(d, a.compId);
        while (p) {
          if (p === a.layerId) throw new OpError("A layer can't follow itself through its parents.");
          p = c.layers[p]?.parentId;
        }
        l.parentId = parentId;
      }
    }
    if (l.inPoint > l.outPoint) throw new OpError("A layer must end after it starts.");
    for (const k of Object.keys(a.changes)) ctx.noteLayerEdit(a.compId, a.layerId, k);
  },
  summarize: (a, p) => `Changed ${Object.keys(a.changes).join(", ")} of "${nameOfLayer(p, a.compId, a.layerId)}".`,
});

export const layerMove = defineOp({
  type: "layer.move",
  title: "Reorder layer",
  description: "Move a layer to a new stacking position (0 = top).",
  args: z.object({ compId: id, layerId: id, index: z.number().int().min(0) }),
  apply: (d, a) => {
    const c = comp(d, a.compId);
    layerOf(d, a.compId, a.layerId);
    c.layerOrder = c.layerOrder.filter((x) => x !== a.layerId);
    c.layerOrder.splice(Math.min(a.index, c.layerOrder.length), 0, a.layerId);
  },
});

export const layerReplace = defineOp({
  type: "layer.replace",
  title: "Update layer",
  description: "Replace a layer's full definition (used by recipes when regenerating).",
  args: z.object({ compId: id, layer: obj<Layer>("layer") }),
  apply: (d, a) => {
    const c = comp(d, a.compId);
    if (!c.layers[a.layer.id]) throw new OpError("That layer no longer exists.");
    c.layers[a.layer.id] = a.layer as Draft<Layer>;
  },
});

// ---------------------------------------------------------------------------------------------
// Properties & keyframes

const propAt = (l: Draft<Layer>, path: string): Draft<AnimProp> => {
  const p = getAt(l, path);
  if (!isAnimProp(p)) throw new OpError("That setting can't be animated or doesn't exist.", path);
  return p as Draft<AnimProp>;
};

export const propSet = defineOp({
  type: "prop.set",
  title: "Change setting",
  description:
    "Set a layer property (path like 'transform.opacity', 'source.color', 'effects.<effectId>.params.<name>'). If the property is animated and `atTime` is given, sets or adds a keyframe at that time; if animated and no time is given, shifts all keyframes by the same amount.",
  args: z.object({ compId: id, layerId: id, path: z.string().min(1), value: propValue, atTime: z.number().int().optional() }),
  apply: (d, a, ctx) => {
    const l = layerOf(d, a.compId, a.layerId);
    assertUnlocked(l);
    const p = propAt(l, a.path);
    const kfs = p.keyframes;
    if (!kfs || kfs.length === 0) {
      p.value = a.value;
    } else if (a.atTime !== undefined) {
      const i = kfs.findIndex((k) => k.t === a.atTime);
      if (i >= 0) kfs[i]!.v = a.value;
      else {
        const ref = kfs[0]!;
        kfs.push({ id: `kf_${a.atTime}_${kfs.length}`, t: a.atTime, v: a.value, in: ref.in, out: ref.out });
        kfs.sort((x, y) => x.t - y.t);
      }
    } else {
      // Offset every keyframe so the curve keeps its shape (what people expect when dragging an animated value).
      const current = evalKeyframes(p as AnimProp, kfs[0]!.t);
      const delta = (v: PropValue, cur: PropValue, nv: PropValue): PropValue =>
        typeof v === "number"
          ? v + ((nv as number) - (cur as number))
          : v.map((x, i) => x + (((nv as number[])[i] ?? 0) - ((cur as number[])[i] ?? 0)));
      for (const k of kfs) k.v = delta(k.v as PropValue, current, a.value) as never;
    }
    ctx.noteLayerEdit(a.compId, a.layerId, a.path);
  },
  summarize: (a, p) => `Changed ${a.path.split(".").at(-1)} of "${nameOfLayer(p, a.compId, a.layerId)}".`,
});

export const propSetAnimation = defineOp({
  type: "prop.setAnimation",
  title: "Change animation",
  description: "Replace a property's keyframes (and optionally its expression). Pass an empty list to remove animation.",
  args: z.object({
    compId: id,
    layerId: id,
    path: z.string().min(1),
    keyframes: z.array(z.custom<Keyframe>((v) => !!v && typeof v === "object" && "t" in (v as object))),
    expression: z.object({ src: z.string(), enabled: z.boolean() }).nullable().optional(),
  }),
  apply: (d, a, ctx) => {
    const l = layerOf(d, a.compId, a.layerId);
    assertUnlocked(l);
    const p = propAt(l, a.path);
    if (a.keyframes.length === 0) {
      if (p.keyframes?.length) p.value = p.keyframes[0]!.v;
      delete p.keyframes;
    } else {
      p.keyframes = [...a.keyframes].sort((x, y) => x.t - y.t) as never;
    }
    if (a.expression === null) delete p.expression;
    else if (a.expression) p.expression = a.expression;
    ctx.noteLayerEdit(a.compId, a.layerId, a.path);
  },
  summarize: (a, p) =>
    a.keyframes.length
      ? `Animated ${a.path.split(".").at(-1)} of "${nameOfLayer(p, a.compId, a.layerId)}" (${a.keyframes.length} keyframes).`
      : `Removed animation from ${a.path.split(".").at(-1)} of "${nameOfLayer(p, a.compId, a.layerId)}".`,
});

export const layerSetPath = defineOp({
  type: "layer.setPath",
  title: "Change layer data",
  description: "Set a non-animated field of a layer by path (e.g. 'source.contents.0.stroke.cap'). For animatable values use prop.set.",
  args: z.object({ compId: id, layerId: id, path: z.string().min(1), value: z.unknown() }),
  apply: (d, a, ctx) => {
    const l = layerOf(d, a.compId, a.layerId);
    assertUnlocked(l);
    if (isAnimProp(getAt(l, a.path))) throw new OpError("Use an animatable change for that setting.", a.path);
    if (!setAt(l, a.path, a.value)) throw new OpError("That setting doesn't exist on this layer.", a.path);
    ctx.noteLayerEdit(a.compId, a.layerId, a.path);
  },
});

// ---------------------------------------------------------------------------------------------
// Effects & masks

export const effectAdd = defineOp({
  type: "effect.add",
  title: "Add effect",
  description: "Add an effect to a layer's effect stack. index 0 runs first; omit to add at the end.",
  args: z.object({ compId: id, layerId: id, effect: obj<EffectInstance>("effect"), index: z.number().int().min(0).optional() }),
  apply: (d, a, ctx) => {
    const l = layerOf(d, a.compId, a.layerId);
    assertUnlocked(l);
    const i = Math.min(a.index ?? l.effects.length, l.effects.length);
    l.effects.splice(i, 0, a.effect as Draft<EffectInstance>);
    ctx.noteLayerEdit(a.compId, a.layerId, `effects.${a.effect.id}`);
  },
  summarize: (a, p) => `Added ${a.effect.type} to "${nameOfLayer(p, a.compId, a.layerId)}".`,
});

export const effectRemove = defineOp({
  type: "effect.remove",
  title: "Remove effect",
  description: "Remove an effect from a layer.",
  args: z.object({ compId: id, layerId: id, effectId: id }),
  apply: (d, a, ctx) => {
    const l = layerOf(d, a.compId, a.layerId);
    assertUnlocked(l);
    l.effects = l.effects.filter((e) => e.id !== a.effectId);
    ctx.noteLayerEdit(a.compId, a.layerId, `effects.${a.effectId}`);
  },
});

export const effectMove = defineOp({
  type: "effect.move",
  title: "Reorder effect",
  description: "Move an effect to a new position in the layer's stack (0 runs first).",
  args: z.object({ compId: id, layerId: id, effectId: id, index: z.number().int().min(0) }),
  apply: (d, a, ctx) => {
    const l = layerOf(d, a.compId, a.layerId);
    const e = l.effects.find((x) => x.id === a.effectId);
    if (!e) throw new OpError("That effect no longer exists.");
    l.effects = l.effects.filter((x) => x.id !== a.effectId);
    l.effects.splice(Math.min(a.index, l.effects.length), 0, e);
    ctx.noteLayerEdit(a.compId, a.layerId, "effects");
  },
});

export const effectEnable = defineOp({
  type: "effect.enable",
  title: "Turn effect on/off",
  description: "Enable or disable an effect without removing it.",
  args: z.object({ compId: id, layerId: id, effectId: id, enabled: z.boolean() }),
  apply: (d, a, ctx) => {
    const e = layerOf(d, a.compId, a.layerId).effects.find((x) => x.id === a.effectId);
    if (!e) throw new OpError("That effect no longer exists.");
    e.enabled = a.enabled;
    ctx.noteLayerEdit(a.compId, a.layerId, `effects.${a.effectId}.enabled`);
  },
});

export const maskAdd = defineOp({
  type: "mask.add",
  title: "Add mask",
  description: "Add a mask to a layer (drawn path or venue region).",
  args: z.object({ compId: id, layerId: id, mask: obj<Mask>("mask") }),
  apply: (d, a, ctx) => {
    const l = layerOf(d, a.compId, a.layerId);
    assertUnlocked(l);
    l.masks.push(a.mask as Draft<Mask>);
    ctx.noteLayerEdit(a.compId, a.layerId, `masks.${a.mask.id}`);
  },
});

export const maskRemove = defineOp({
  type: "mask.remove",
  title: "Remove mask",
  description: "Remove a mask from a layer.",
  args: z.object({ compId: id, layerId: id, maskId: id }),
  apply: (d, a, ctx) => {
    const l = layerOf(d, a.compId, a.layerId);
    assertUnlocked(l);
    l.masks = l.masks.filter((m) => m.id !== a.maskId);
    ctx.noteLayerEdit(a.compId, a.layerId, `masks.${a.maskId}`);
  },
});

// ---------------------------------------------------------------------------------------------
// Assets

export const assetAdd = defineOp({
  type: "asset.add",
  title: "Import media",
  description: "Register an imported file (image, video, audio, model, font, LUT) with the project.",
  args: z.object({ asset: obj<Asset>("asset") }),
  apply: (d, a) => {
    d.assets[a.asset.id] = a.asset as Draft<Asset>;
  },
  summarize: (a) => `Imported "${a.asset.name}".`,
});

export const assetUpdate = defineOp({
  type: "asset.update",
  title: "Update media details",
  description: "Store analysis results (beats, tempo) or corrected details for an imported file.",
  args: z.object({
    assetId: id,
    changes: z
      .object({
        name: z.string().min(1),
        analysis: z.custom<NonNullable<Asset["analysis"]>>((v) => !!v && typeof v === "object" && Array.isArray((v as { beats?: unknown }).beats)),
        audioPath: z.string(),
        missing: z.boolean(),
        /** Details measured later (e.g. a 3D model's size and collision hull), merged into the existing ones. */
        meta: z.custom<Partial<Asset["meta"]>>((v) => !!v && typeof v === "object" && !Array.isArray(v), { message: "expected media details" }),
      })
      .partial(),
  }),
  apply: (d, a) => {
    const asset = d.assets[a.assetId];
    if (!asset) throw new OpError("That media item no longer exists.");
    const { meta, ...rest } = a.changes;
    Object.assign(asset, rest);
    if (meta) asset.meta = { ...asset.meta, ...meta } as Draft<Asset["meta"]>;
  },
  summarize: (a, p) => (a.changes.analysis ? `Found the beat of "${p.assets[a.assetId]?.name ?? "the music"}" (${Math.round(a.changes.analysis.bpm)} BPM).` : `Updated "${p.assets[a.assetId]?.name ?? "media"}".`),
});

export const assetRemove = defineOp({
  type: "asset.remove",
  title: "Remove media",
  description: "Remove an imported file from the project. Refused while a layer still uses it.",
  args: z.object({ assetId: id }),
  apply: (d, a) => {
    for (const c of Object.values(d.compositions))
      for (const l of Object.values(c.layers))
        if ((l.source.kind === "footage" || l.source.kind === "audio") && l.source.assetId === a.assetId)
          throw new OpError(`"${d.assets[a.assetId]?.name ?? "This file"}" is still used by "${l.name}". Remove that layer first.`);
    delete d.assets[a.assetId];
  },
});

export const assetRelink = defineOp({
  type: "asset.relink",
  title: "Relink media",
  description: "Point a missing or moved asset at a new file (optionally with the new file's details).",
  args: z.object({ assetId: id, path: z.string().min(1), originalPath: z.string().optional(), drive: z.string().optional(), audioPath: z.string().optional(), meta: z.custom<Asset["meta"]>((v) => !!v && typeof v === "object" && !Array.isArray(v), { message: "expected media details" }).optional() }),
  apply: (d, a) => {
    const asset = d.assets[a.assetId];
    if (!asset) throw new OpError("That media item no longer exists.");
    asset.path = a.path;
    if (a.originalPath) asset.originalPath = a.originalPath;
    if (a.drive) asset.drive = a.drive;
    if (a.audioPath) asset.audioPath = a.audioPath;
    if (a.meta) asset.meta = { ...asset.meta, ...a.meta } as Draft<Asset["meta"]>;
    delete asset.missing;
  },
  summarize: (a, p) => `Relinked "${p.assets[a.assetId]?.name ?? "media"}".`,
});

// ---------------------------------------------------------------------------------------------
// Venue, regions, projectors, calibration, bindings

export const venueAdd = defineOp({
  type: "venue.add",
  title: "Set up the space",
  description: "Add a venue (the physical installation: surfaces, regions, projectors).",
  args: z.object({ venue: obj<Venue>("venue"), makeActive: z.boolean().optional() }),
  apply: (d, a) => {
    d.venues[a.venue.id] = a.venue as Draft<Venue>;
    if (a.makeActive || !d.activeVenueId) d.activeVenueId = a.venue.id;
    if (!d.bindings[a.venue.id]) d.bindings[a.venue.id] = { venueId: a.venue.id, roles: {} };
  },
  summarize: (a) => `Set up the space "${a.venue.name}".`,
});

export const venueUpdate = defineOp({
  type: "venue.update",
  title: "Change the space",
  description: "Rename the venue, change its canvas size, its reference image, how its photo sits in the canvas (fit/fill, scale %, offset px, crop fractions), or its house lights (the flames on the building, shared by every 3D scene).",
  args: z.object({
    venueId: id,
    changes: z
      .object({
        name: z.string().min(1),
        cameraDistance: z.number().min(0.2).max(50),
        canvas: z.object({ width: z.number().int().min(16).max(16384), height: z.number().int().min(16).max(16384) }),
        referenceAssetId: z.string().nullable(),
        photo: z.object({
          assetId: z.string(),
          placement: z.object({
            fit: z.enum(["fit", "fill"]),
            scale: z.number().min(10).max(1000),
            offsetX: z.number(),
            offsetY: z.number(),
            crop: z.object({ left: z.number().min(0).max(0.45), right: z.number().min(0).max(0.45), top: z.number().min(0).max(0.45), bottom: z.number().min(0).max(0.45) }),
          }),
        }),
        lights: z.array(obj<import("./houseLights.ts").HouseLight>("house light")),
      })
      .partial(),
  }),
  apply: (d, a) => {
    const v = venueOf(d, a.venueId);
    const { referenceAssetId, ...rest } = a.changes;
    Object.assign(v, rest);
    if (referenceAssetId === null) delete v.referenceAssetId;
    else if (referenceAssetId !== undefined) v.referenceAssetId = referenceAssetId;
  },
});

export const regionAdd = defineOp({
  type: "region.add",
  title: "Add region",
  description: "Add a named physical region (window, door, roofline, …) to a venue.",
  args: z.object({ venueId: id, region: obj<Region>("region"), bindRole: z.string().optional() }),
  apply: (d, a) => {
    const v = venueOf(d, a.venueId);
    v.regions[a.region.id] = a.region as Draft<Region>;
    v.regionOrder.push(a.region.id);
    if (a.bindRole) {
      const b = (d.bindings[a.venueId] ??= { venueId: a.venueId, roles: {} });
      b.roles[a.bindRole] = [...(b.roles[a.bindRole] ?? []), a.region.id];
    }
  },
  summarize: (a) => `Marked "${a.region.name}" (${a.region.kind}).`,
});

export const regionUpdate = defineOp({
  type: "region.update",
  title: "Change region",
  description: "Rename, re-classify or reshape a region.",
  args: z.object({
    venueId: id,
    regionId: id,
    changes: z
      .object({
        name: z.string().min(1),
        kind: z.enum(["window", "door", "garage", "wall", "roof", "roofline", "column", "vent", "light", "edge", "exclusion", "custom"]),
        path: z.custom<Region["path"]>(),
        tags: z.array(z.string()),
        holes: z.custom<NonNullable<Region["holes"]>>((v) => Array.isArray(v)),
        feather: z.number().min(0).max(500),
        expansion: z.number().min(-500).max(500),
        cutouts: z.array(id),
        depth: z.object({ standOut: z.number().min(-20).max(50).optional(), thickness: z.number().min(0.005).max(20).optional() }).nullable(),
        /** null: reviewed, no longer a proposal. */
        proposal: z.custom<NonNullable<Region["proposal"]>>((v) => typeof v === "object").nullable(),
      })
      .partial(),
  }),
  apply: (d, a) => {
    const v = venueOf(d, a.venueId);
    const r = v.regions[a.regionId];
    if (!r) throw new OpError("That region no longer exists.");
    const { proposal, depth, ...rest } = a.changes;
    if (rest.cutouts?.some((c) => c === a.regionId || !v.regions[c])) throw new OpError("An area can only have other existing areas cut out of it.");
    Object.assign(r, rest);
    if (depth === null) delete r.depth;
    else if (depth) r.depth = { ...r.depth, ...depth };
    if (proposal === null) delete r.proposal;
    else if (proposal) r.proposal = proposal as Draft<NonNullable<Region["proposal"]>>;
  },
});

export const regionRemove = defineOp({
  type: "region.remove",
  title: "Remove region",
  description: "Remove a region from a venue and from every role binding.",
  args: z.object({ venueId: id, regionId: id }),
  apply: (d, a) => {
    const v = venueOf(d, a.venueId);
    delete v.regions[a.regionId];
    v.regionOrder = v.regionOrder.filter((x) => x !== a.regionId);
    for (const g of Object.values(v.groups)) g.regionIds = g.regionIds.filter((x) => x !== a.regionId);
    for (const r of Object.values(v.regions)) if (r.cutouts?.includes(a.regionId)) r.cutouts = r.cutouts.filter((x) => x !== a.regionId);
    const b = d.bindings[a.venueId];
    if (b) for (const k of Object.keys(b.roles)) b.roles[k] = b.roles[k]!.filter((x) => x !== a.regionId);
  },
});

export const groupSet = defineOp({
  type: "group.set",
  title: "Group regions",
  description: "Create or replace a group of regions (e.g. 'All windows').",
  args: z.object({ venueId: id, group: obj<RegionGroup>("group") }),
  apply: (d, a) => {
    venueOf(d, a.venueId).groups[a.group.id] = a.group as Draft<RegionGroup>;
  },
  summarize: (a) => `Grouped ${a.group.regionIds.length} regions as "${a.group.name}".`,
});

export const groupRemove = defineOp({
  type: "group.remove",
  title: "Ungroup",
  description: "Remove a named group of areas (the areas themselves stay).",
  args: z.object({ venueId: id, groupId: id }),
  apply: (d, a) => {
    delete venueOf(d, a.venueId).groups[a.groupId];
  },
});

export const bindingSetRole = defineOp({
  type: "binding.setRole",
  title: "Choose regions for a role",
  description: "Bind a show role (e.g. 'windows') to an ordered list of regions in a venue.",
  args: z.object({ venueId: id, role: z.string().min(1), regionIds: z.array(id) }),
  apply: (d, a) => {
    const v = venueOf(d, a.venueId);
    for (const r of a.regionIds) if (!v.regions[r]) throw new OpError("One of those regions no longer exists.", r);
    const b = (d.bindings[a.venueId] ??= { venueId: a.venueId, roles: {} });
    b.roles[a.role] = a.regionIds;
  },
});

export const projectorAdd = defineOp({
  type: "projector.add",
  title: "Add projector",
  description: "Add a projector to a venue.",
  args: z.object({ venueId: id, projector: obj<Projector>("projector") }),
  apply: (d, a) => {
    const v = venueOf(d, a.venueId);
    v.projectors[a.projector.id] = a.projector as Draft<Projector>;
    v.projectorOrder.push(a.projector.id);
  },
  summarize: (a) => `Added "${a.projector.name}".`,
});

const assertCalibrationUnlocked = (p: Draft<Projector>) => {
  if (p.calibration.locked) throw new OpError(`The alignment of "${p.name}" is locked. Unlock it to make changes.`);
};

export const calibrationMovePoint = defineOp({
  type: "calibration.movePoint",
  title: "Move alignment point",
  description: "Move a numbered alignment point in the projector's output so it lands on the physical feature.",
  args: z.object({ venueId: id, projectorId: id, pointId: id, output: vec2.optional(), content: vec2.optional() }),
  apply: (d, a) => {
    const p = projectorOf(d, a.venueId, a.projectorId);
    assertCalibrationUnlocked(p);
    const pt = p.calibration.points.find((x) => x.id === a.pointId);
    if (!pt) throw new OpError("That alignment point no longer exists.");
    if (a.output) pt.output = a.output;
    if (a.content) pt.content = a.content;
  },
});

export const calibrationSetPoints = defineOp({
  type: "calibration.setPoints",
  title: "Set alignment points",
  description: "Replace the projector's alignment points and mode.",
  args: z.object({
    venueId: id,
    projectorId: id,
    mode: z.enum(["corner-pin", "mesh"]),
    points: z.array(z.object({ id, label: z.string(), content: vec2, output: vec2 })).min(4),
    mesh: z.object({ cols: z.number().int().min(2), rows: z.number().int().min(2), offsets: z.array(vec2), labels: z.array(z.number().int().min(0).max(255)).optional(), surfaces: z.array(id).optional(), base: z.array(vec2).optional() }).optional(),
  }),
  apply: (d, a) => {
    const p = projectorOf(d, a.venueId, a.projectorId);
    assertCalibrationUnlocked(p);
    p.calibration.mode = a.mode;
    p.calibration.points = a.points as never;
    if (a.mesh) p.calibration.mesh = a.mesh as never;
    else delete p.calibration.mesh;
  },
});

export const calibrationLock = defineOp({
  type: "calibration.lock",
  title: "Lock alignment",
  description: "Lock or unlock a projector's alignment so creative edits can't disturb it.",
  args: z.object({ venueId: id, projectorId: id, locked: z.boolean() }),
  apply: (d, a) => {
    projectorOf(d, a.venueId, a.projectorId).calibration.locked = a.locked;
  },
  summarize: (a) => (a.locked ? "Locked the projector alignment." : "Unlocked the projector alignment."),
});

export const calibrationSave = defineOp({
  type: "calibration.save",
  title: "Save alignment",
  description: "Save the current alignment as a restorable version.",
  args: z.object({ venueId: id, projectorId: id, note: z.string().optional(), savedAt: z.string() }),
  apply: (d, a) => {
    const p = projectorOf(d, a.venueId, a.projectorId);
    const snapshot: Calibration = { ...(p.calibration as Calibration), savedAt: a.savedAt, ...(a.note ? { note: a.note } : {}) };
    p.calibrationHistory.push(snapshot as Draft<Calibration>);
    p.calibration.version = snapshot.version + 1;
  },
  summarize: () => "Saved the projector alignment.",
});

export const calibrationRestore = defineOp({
  type: "calibration.restore",
  title: "Restore alignment",
  description: "Restore a previously saved alignment version.",
  args: z.object({ venueId: id, projectorId: id, version: z.number().int() }),
  apply: (d, a) => {
    const p = projectorOf(d, a.venueId, a.projectorId);
    const snap = p.calibrationHistory.find((c) => c.version === a.version);
    if (!snap) throw new OpError("That saved alignment no longer exists.");
    p.calibration = { ...snap, locked: false } as Draft<Calibration>;
  },
});

// ---------------------------------------------------------------------------------------------

export const coreOps = [
  projectRename,
  compAdd,
  compUpdate,
  compRemove,
  markerAdd,
  markerRemove,
  layerAdd,
  layerRemove,
  layerUpdate,
  layerMove,
  layerReplace,
  propSet,
  propSetAnimation,
  layerSetPath,
  effectAdd,
  effectRemove,
  effectMove,
  effectEnable,
  maskAdd,
  maskRemove,
  assetAdd,
  assetUpdate,
  assetRemove,
  assetRelink,
  venueAdd,
  venueUpdate,
  regionAdd,
  regionUpdate,
  regionRemove,
  groupSet,
  groupRemove,
  bindingSetRole,
  projectorAdd,
  calibrationMovePoint,
  calibrationSetPoints,
  calibrationLock,
  calibrationSave,
  calibrationRestore,
] as const;



export type { Flicks };

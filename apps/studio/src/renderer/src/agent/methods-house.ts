/** Agent methods for automatic house setup and reshaping areas (split, join). */
import { ASSUMED_DEPTH, FLICKS_PER_SECOND, HOUSE_LIGHT_DEFAULTS, type HouseLight, houseLightLevel, type Object3D, type PartMotion, type PartTiming, staticProp } from "@be/core";
import { z } from "zod";
import { mergeAreas, splitArea } from "../space/areaEdit.ts";
import { acceptProposals, addProposals, cancelDetection, discardProposals, proposedAreas, runDetection, useHouseSetup } from "../space/houseSetup.ts";
import { animatePart, partFor, partsLayer, removePart, wallColorAround } from "../studio/parts.ts";
import { activeVenue, currentComp, useStudio } from "../studio/store.ts";
import { AgentError, method } from "./core.ts";
import { areaIds, areaInfo } from "./methods-show.ts";

const venue = () => {
  const p = useStudio.getState().project;
  const v = p ? activeVenue({ project: p }) : undefined;
  if (!v) throw new AgentError("no_project", "No show is open.");
  return v;
};

method({
  name: "house.status",
  summary: "Whether the detection models are on this computer (and the download size if not), a run in progress, and how many found areas wait for review.",
  params: z.object({}),
  run: async () => {
    const s = await window.be.detect.status();
    const h = useHouseSetup.getState();
    const p = useStudio.getState().project;
    return {
      models: s.models,
      modelsDir: s.modelsDir,
      downloadMB: s.downloadMB,
      running: h.phase === "running" ? { progress: Math.round(h.fraction * 100) / 100, step: h.text } : null,
      lastRun: h.summary,
      proposals: p ? proposedAreas(activeVenue({ project: p })).length : 0,
    };
  },
});

method({
  name: "house.detect",
  summary:
    "Find the parts of the house in the venue photo (windows, doors, garage doors, lights, vents, columns, roof, roofline, and the facade with its openings cut out) and add them as proposed areas — one undo step. Runs on this computer (GPU if possible). If the models aren't downloaded yet this fails with code 'needs_download' unless allowDownload is true: ask the person first (see details for size and licenses). Earlier unreviewed proposals are replaced; areas already traced are skipped. Review with house.proposals, fix with areas.update / areas.split / areas.merge / areas.delete, then house.accept.",
  params: z.object({ allowDownload: z.boolean().optional(), device: z.enum(["gpu", "cpu"]).optional(), timeoutMs: z.number().int().min(10_000).max(1_800_000).optional() }),
  mutates: true,
  long: true,
  run: async (p, ctx) => {
    if (useHouseSetup.getState().phase === "running") throw new AgentError("busy", "House detection is already running. Wait for it (house.status) or cancel it (house.cancel).");
    const r = await runDetection({ allowDownload: !!p.allowDownload, ...(p.device ? { device: p.device } : {}) });
    if (!r.ok) {
      if (r.code === "needs-download") {
        const s = await window.be.detect.status();
        throw new AgentError("needs_download", `${r.message} Ask the person, then call again with allowDownload: true.`, { downloadMB: s.downloadMB, models: s.models.filter((m) => !m.present), modelsDir: s.modelsDir });
      }
      throw new AgentError(r.code === "cancelled" ? "cancelled" : r.code === "no_photo" ? "not_found" : "failed", r.message);
    }
    const added = ctx.edit(() => addProposals(r.detection, r.referenceAssetId));
    if (!added) throw new AgentError("conflict", "The venue photo changed while detecting; nothing was added. Run it again.");
    const v = venue();
    return {
      found: added.regions.map((x) => areaInfo(v.regions[x.id] ?? x, false)),
      skippedAlreadyTraced: added.skipped.map((x) => x.name),
      replacedEarlierProposals: added.replaced,
      notes: r.detection.notes,
      seconds: Math.round(r.detection.seconds * 10) / 10,
      ranOn: r.detection.device,
    };
  },
});

method({
  name: "house.cancel",
  summary: "Stop a house detection in progress (nothing is changed).",
  params: z.object({}),
  run: async () => ({ cancelled: useHouseSetup.getState().phase === "running" ? (await cancelDetection(), true) : false }),
});

method({
  name: "house.proposals",
  summary: "Areas found automatically that haven't been accepted yet, with confidence, why to check them, and their outlines (points in canvas pixels).",
  params: z.object({ points: z.boolean().optional() }),
  run: (p) => ({ proposals: proposedAreas(venue()).map((r) => areaInfo(r, !!p.points)) }),
});

method({
  name: "house.accept",
  summary: "Accept found areas (default: all): they become ordinary areas used by effects for their kind (e.g. 'windows'), grouped as Windows, Openings and Lights.",
  params: z.object({ areas: z.array(z.string()).optional() }),
  mutates: true,
  run: (p, ctx) => {
    const ids = p.areas ? areaIds(p.areas) : undefined;
    const n = ctx.edit(() => acceptProposals(ids));
    if (!n) throw new AgentError("not_found", "No found areas are waiting to be accepted" + (ids ? " among those." : "."));
    return { accepted: n, waiting: proposedAreas(venue()).length };
  },
});

method({
  name: "house.discard",
  summary: "Remove found areas that haven't been accepted (default: all of them).",
  params: z.object({ areas: z.array(z.string()).optional() }),
  mutates: true,
  run: (p, ctx) => {
    const ids = p.areas ? areaIds(p.areas) : undefined;
    const n = ctx.edit(() => discardProposals(ids));
    if (!n) throw new AgentError("not_found", "No found areas to remove.");
    return { removed: n };
  },
});

method({
  name: "areas.split",
  summary: "Split an area in two: 'side' (left and right) or 'stacked' (top and bottom), at a fraction across (default 0.5). Four-cornered areas split along their own sides. The new part keeps the kind, groups and uses.",
  params: z.object({ area: z.string(), how: z.enum(["side", "stacked"]), at: z.number().min(0.05).max(0.95).optional() }),
  mutates: true,
  run: (p, ctx) => {
    const [id] = areaIds([p.area]);
    const r = ctx.edit(() => splitArea(id!, p.how, p.at ?? 0.5));
    if (!r) throw new AgentError("rejected", "That area can't be split (it must be a closed outline).");
    const v = venue();
    return { areas: r.map((x) => areaInfo(v.regions[x]!, false)) };
  },
});

method({
  name: "areas.merge",
  summary: "Join areas into one (the first keeps its name, kind and uses): their combined outline when they touch, else the outline around all of them.",
  params: z.object({ areas: z.array(z.string()).min(2) }),
  mutates: true,
  run: (p, ctx) => {
    const ids = areaIds(p.areas);
    const id = ctx.edit(() => mergeAreas(ids));
    if (!id) throw new AgentError("rejected", "Those areas can't be joined (they must be closed outlines).");
    return { area: areaInfo(venue().regions[id]!, false) };
  },
});

// ---- moving parts (3D) ------------------------------------------------------------------------

const motionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("swing"), hinge: z.enum(["left", "right"]).default("left"), direction: z.enum(["in", "out"]).default("in"), angle: z.number().min(5).max(180).default(95) }),
  z.object({ kind: z.literal("raise"), style: z.enum(["slide", "tilt"]).default("slide") }),
  z.object({ kind: z.literal("push"), distance: z.number().min(-3).max(3).default(-0.25) }),
  z.object({ kind: z.literal("slide"), direction: z.enum(["left", "right", "up", "down"]).default("left") }),
  z.object({ kind: z.literal("turn"), axis: z.enum(["vertical", "horizontal"]).default("vertical"), turns: z.number().min(0.25).max(10).default(1) }),
  z.object({ kind: z.literal("fall") }),
]);
const timingSchema = z.object({ start: z.number().min(0), move: z.number().min(0.1).max(60), hold: z.number().min(0).max(600), back: z.boolean() }).partial();
const backingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("recess") }),
  z.object({ kind: z.literal("room"), color: z.tuple([z.number(), z.number(), z.number(), z.number()]).default([1, 0.78, 0.45, 1]) }),
  z.object({ kind: z.literal("image"), asset: z.string() }),
  z.object({ kind: z.literal("wall") }),
]);

const backingFrom = async (b: z.infer<typeof backingSchema> | undefined, regionId: string) => {
  if (!b) return undefined;
  if (b.kind === "image") {
    const p = useStudio.getState().project!;
    const a = Object.values(p.assets).find((x) => x.id === b.asset || x.name.toLowerCase() === b.asset.toLowerCase());
    if (!a || a.kind !== "image") throw new AgentError("not_found", `No picture "${b.asset}" in this show (import it with assets.import).`);
    return { kind: "image" as const, assetId: a.id };
  }
  if (b.kind === "wall") return { kind: "wall" as const, color: await wallColorAround(regionId) };
  return b;
};

const partInfoOut = (o: Object3D, layerId: string) => ({
  id: o.id,
  name: o.name,
  area: venue().regions[o.part!.regionId]?.name ?? o.part!.regionId,
  motion: o.part!.motion,
  timing: o.part!.timing,
  backing: o.part!.backing,
  layer: layerId,
  assumedDepthMetres: { facade: ASSUMED_DEPTH.facade, part: o.geometry?.kind === "area" ? o.geometry.depth : null },
});

method({
  name: "parts.animate",
  summary:
    "Make an area move in 3D in the current scene — a door swings on a hinge, a garage door raises, a window pushes in, or a part slides, turns or falls — with the photo of it moving and a backing (dark recess, lit room, a picture, or the wall colour) showing behind its opening. The first time, adds the scene's 'House parts (3D)' layer (facade with openings cut out). Timing is seconds into the scene. The traced area never moves. Calling it again for the same area changes how it moves.",
  params: z.object({ area: z.string(), motion: motionSchema.optional(), timing: timingSchema.optional(), backing: backingSchema.optional() }),
  mutates: true,
  example: { area: "Front door", motion: { kind: "swing", hinge: "left", direction: "in", angle: 95 }, timing: { start: 1, move: 1.5, hold: 2, back: true }, backing: { kind: "recess" } },
  run: async (p, ctx) => {
    const [id] = areaIds([p.area]);
    const backing = await backingFrom(p.backing, id!);
    const partId = ctx.edit(() => animatePart(id!, { ...(p.motion ? { motion: p.motion as PartMotion } : {}), ...(p.timing ? { timing: p.timing as Partial<PartTiming> } : {}), ...(backing ? { backing } : {}) }));
    if (!partId) throw new AgentError("rejected", "That area can't be made to move (it must be a closed outline).");
    const found = partsLayer(currentComp(useStudio.getState()))!;
    return { part: partInfoOut(found.scene.objects[partId]!, found.layer.id) };
  },
});

method({
  name: "parts.list",
  summary: "The moving parts in the current scene (with motion, timing, backing and assumed depths), and the openings that stay still.",
  params: z.object({}),
  run: () => {
    const found = partsLayer(currentComp(useStudio.getState()));
    if (!found) return { parts: [], layer: null };
    const objs = found.scene.objectOrder.map((id) => found.scene.objects[id]!);
    return { layer: found.layer.id, parts: objs.filter((o) => o.part).map((o) => partInfoOut(o, found.layer.id)), still: objs.filter((o) => o.name.endsWith("(still)")).map((o) => o.name.replace(/ \(still\)$/, "")) };
  },
});

method({
  name: "parts.remove",
  summary: "Stop an area moving in the current scene (its opening shows the still photo again).",
  params: z.object({ area: z.string() }),
  mutates: true,
  run: (p, ctx) => {
    const [id] = areaIds([p.area]);
    const found = partsLayer(currentComp(useStudio.getState()));
    const o = partFor(found?.scene, id!);
    if (!o) throw new AgentError("not_found", `“${p.area}” doesn't move in this scene.`);
    ctx.edit(() => removePart(o.id));
    return { removed: o.name };
  },
});

// ---- house lights (candles, torches) ----------------------------------------------------------

const keyframeSchema = z.object({
  t: z.number().min(0).describe("seconds of show time"),
  v: z.number().min(0).max(100),
  to: z.enum(["hold", "linear"]).optional().describe("how it goes on to the next key: held (a switch, the default) or a straight ramp (a fade, a candle being lit)"),
});
const houseLightSchema = z.object({
  id: z.string().min(1).max(80).optional().describe("keeps a light's identity across edits; new id = a new light"),
  name: z.string().min(1).max(200),
  at: z.tuple([z.number(), z.number()]).describe("where its flame shows on the canvas (pixels)"),
  depth: z.number().min(-20).max(20).describe("metres in front of the building's front (negative: set back into it, e.g. a recessed window sill)"),
  color: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]).optional().describe("sRGB; default a warm flame"),
  intensity: z.number().min(0).max(100).optional().describe("steady brightness (point-light units) when no keyframes are given"),
  keyframes: z.array(keyframeSchema).optional().describe("brightness over show time: 0 while it's out (scene changes), held between keys unless a key ramps to the next"),
  range: z.number().min(0).max(100).optional().describe("metres beyond which it lights nothing (0: no limit; default 6)"),
  falloff: z.number().min(0).max(4).optional().describe("how it weakens with distance (2 as real light)"),
  castShadow: z.boolean().optional().describe("the house's solids (walls, columns, roof edges) cast shadows from it (default yes)"),
  softness: z.number().min(0).max(1).optional(),
  flicker: z
    .object({ amount: z.number().min(0).max(1), speed: z.number().min(0).max(60), seed: z.number().int(), octaves: z.number().int().min(1).max(6).default(2) })
    .partial()
    .optional()
    .describe("flicker = brightness × (1 + wiggle(speed, amount, octaves, seed)) at show time; a flame layer's opacity wiggle(speed, a, octaves, seed) at opacity o flickers with it when amount = a/o"),
  curve: z
    .object({ start: z.number().describe("show time (s) of the first sample: where the footage's layer starts"), fps: z.number().min(1).max(240), values: z.array(z.number().min(0).max(10)).min(2).max(20000) })
    .optional()
    .describe("instead of the wiggle: a measured brightness curve (factors around 1), repeating — e.g. sampled from candles filmed in a looping video, so the light follows the flames seen in it"),
});

const lightInfo = (L: HouseLight) => ({
  id: L.id,
  name: L.name,
  at: L.at,
  depth: L.depth,
  color: L.color.slice(0, 3),
  keyframes: L.intensity.keyframes?.length ? L.intensity.keyframes.map((k) => ({ t: k.t / FLICKS_PER_SECOND, v: k.v, ...(k.out === "linear" ? { to: "linear" as const } : {}) })) : null,
  intensity: L.intensity.keyframes?.length ? null : L.intensity.value,
  range: L.range,
  falloff: L.falloff,
  castShadow: L.castShadow,
  softness: L.softness,
  flicker: L.flicker,
  curve: L.curve ? { start: L.curve.start, fps: L.curve.fps, samples: L.curve.values.length } : null,
});

method({
  name: "house.lights",
  summary: "The house's lights: the flames on the building (candles, torches) that light every 3D scene of the show and the candlelight layer, with their place, colour, brightness over the show, range, shadows and flicker.",
  params: z.object({}),
  run: () => ({ lights: (venue().lights ?? []).map(lightInfo) }),
});

method({
  name: "house.setLights",
  summary:
    "Set the house's lights (replaces the list; one undo step): each a flame on the building — where it shows on the canvas and how far in front of the building's front — with a warm colour, its brightness over show time (keyframes; 0 while out), range, falloff, shadows from the house's solids and its own steady flicker (show time, deterministic: the same in preview, export and any outside renderer using the formula). Every 3D scene of the venue is lit by them unless the scene opts out (scene3d.update houseLights false).",
  params: z.object({ lights: z.array(houseLightSchema).max(64) }),
  mutates: true,
  run: (p, ctx) => {
    const v = venue();
    const used = new Set<string>();
    const lights: HouseLight[] = p.lights.map((l, i) => {
      let id = l.id ?? `hl_${i + 1}`;
      while (used.has(id)) id = `${id}_`;
      used.add(id);
      const kf = l.keyframes?.length
        ? [...l.keyframes]
            .sort((a, b) => a.t - b.t)
            .map((k, j, all) => ({ id: `${id}_k${j}`, t: Math.round(k.t * FLICKS_PER_SECOND), v: k.v, in: all[j - 1]?.to === "linear" ? ("linear" as const) : ("hold" as const), out: k.to === "linear" ? ("linear" as const) : ("hold" as const) }))
        : undefined;
      const fl = { ...HOUSE_LIGHT_DEFAULTS.flicker, ...(l.flicker ?? {}) };
      return {
        id,
        name: l.name,
        at: [l.at[0], l.at[1]] as const,
        depth: l.depth,
        color: l.color ? ([l.color[0], l.color[1], l.color[2], 1] as const) : HOUSE_LIGHT_DEFAULTS.color,
        intensity: kf ? { value: kf[0]!.v, keyframes: kf } : staticProp(l.intensity ?? 1),
        range: l.range ?? HOUSE_LIGHT_DEFAULTS.range,
        falloff: l.falloff ?? HOUSE_LIGHT_DEFAULTS.falloff,
        castShadow: l.castShadow ?? HOUSE_LIGHT_DEFAULTS.castShadow,
        softness: l.softness ?? HOUSE_LIGHT_DEFAULTS.softness,
        flicker: { amount: fl.amount, speed: fl.speed, seed: fl.seed, octaves: fl.octaves },
        ...(l.curve ? { curve: { start: l.curve.start, fps: l.curve.fps, values: l.curve.values } } : {}),
      };
    });
    ctx.edit(() => useStudio.getState().apply({ type: "venue.update", args: { venueId: v.id, changes: { lights } } }, { label: lights.length ? "Set the house's lights" : "Remove the house's lights" }));
    return { lights: lights.map(lightInfo) };
  },
});

method({
  name: "house.lightLevel",
  summary: "A house light's brightness (keyframes × flicker) at show times, for checking it against a flame or an outside render (Blender) that uses the same formula.",
  params: z.object({ light: z.string(), times: z.array(z.number().min(0)).min(1).max(4000) }),
  run: (p) => {
    const L = (venue().lights ?? []).find((l) => l.id === p.light || l.name === p.light);
    if (!L) throw new AgentError("not_found", `No house light “${p.light}”.`);
    return { light: L.id, levels: p.times.map((t) => houseLightLevel(L, Math.round(t * FLICKS_PER_SECOND))) };
  },
});

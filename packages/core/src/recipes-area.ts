/**
 * "Content in an area": a picture or video assigned to one or more building areas in one scene.
 *
 * Areas are shared by every scene; this assignment belongs to the scene it's made in, so
 * replacing the content here never changes another scene, while reshaping the area outline
 * updates every scene that uses it.
 *
 *   Repeat in each area   one copy per area, each fitted to its own area
 *   Span across areas     one continuous picture across all of them, clipped to each area
 *
 * The result is ordinary, editable layers: a footage layer clipped by the areas (and an optional
 * crop), with placement, timing, looping and sound level from the controls below.
 */
import { EASY_EASE, type Keyframe, staticProp } from "./anim.ts";
import { defaultAudio, type Layer, type Mask, packPath, type Vec3 } from "./model.ts";
import { pathBounds } from "./pathmath.ts";
import { type RecipeDef, registerRecipe } from "./recipes.ts";
import { FLICKS_PER_SECOND, type Flicks, secondsToTime } from "./time.ts";

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const BLEND_CHOICES = [
  { value: "normal", label: "Normal" },
  { value: "add", label: "Add (light)" },
  { value: "screen", label: "Screen" },
  { value: "multiply", label: "Multiply (darken)" },
];

export const areaContent: RecipeDef = {
  id: "area-content",
  title: "Content in an area",
  category: "patterns",
  description: "A picture or video placed in the selected areas: repeated in each one, or spanning across them.",
  keywords: ["picture", "photo", "image", "video", "clip", "movie", "media", "footage", "content", "atmosfx", "assign", "area", "place", "put"],
  suits: ["window", "door", "wall", "column", "custom"],
  defaultSeconds: 10,
  params: [
    { key: "assetId", label: "Picture or video", control: "media", default: "", primary: true, accepts: ["image", "video"], drives: ["source", "transform", "masks"] },
    { key: "mode", label: "With several areas", control: "choice", default: "each", primary: true, choices: [{ value: "each", label: "Repeat in each area" }, { value: "across", label: "Span across areas" }], drives: ["transform", "masks"] },
    { key: "fit", label: "Fit", control: "choice", default: "fill", primary: true, choices: [{ value: "fill", label: "Fill" }, { value: "fit", label: "Fit inside" }, { value: "stretch", label: "Stretch" }], drives: ["transform.scale"] },
    { key: "scale", label: "Size", control: "slider", default: 100, min: 10, max: 400, unit: "%", primary: true, drives: ["transform.scale"] },
    { key: "offsetX", label: "Move sideways", control: "slider", default: 0, min: -100, max: 100, unit: "%", drives: ["transform.position"] },
    { key: "offsetY", label: "Move up/down", control: "slider", default: 0, min: -100, max: 100, unit: "%", drives: ["transform.position"] },
    { key: "rotation", label: "Rotate", control: "slider", default: 0, min: -180, max: 180, unit: "°", drives: ["transform.rotation"] },
    { key: "cropL", label: "Crop left", control: "slider", default: 0, min: 0, max: 45, unit: "%", drives: ["masks", "transform"] },
    { key: "cropR", label: "Crop right", control: "slider", default: 0, min: 0, max: 45, unit: "%", drives: ["masks", "transform"] },
    { key: "cropT", label: "Crop top", control: "slider", default: 0, min: 0, max: 45, unit: "%", drives: ["masks", "transform"] },
    { key: "cropB", label: "Crop bottom", control: "slider", default: 0, min: 0, max: 45, unit: "%", drives: ["masks", "transform"] },
    { key: "trim", label: "Start the clip at", control: "seconds", default: 0, min: 0, max: 3600, step: 0.1, unit: "s", help: "Skip the start of the video.", drives: ["startTime"] },
    { key: "speed", label: "Speed", control: "slider", default: 100, min: 10, max: 400, unit: "%", drives: ["stretch", "startTime"] },
    { key: "loop", label: "Loop the video", control: "toggle", default: true, drives: ["source"] },
    { key: "volume", label: "Sound level", control: "slider", default: 0, min: -60, max: 12, unit: "dB", help: "−60 is silent.", drives: ["audio"] },
    { key: "opacity", label: "Strength", control: "slider", default: 100, min: 0, max: 100, unit: "%", drives: ["transform.opacity"] },
    { key: "blend", label: "Blend", control: "choice", default: "normal", choices: BLEND_CHOICES, drives: ["blendMode"] },
    { key: "feather", label: "Soften edge (this scene)", control: "slider", default: 0, min: 0, max: 80, unit: "px", help: "Adds to the area's own soft edge, only in this scene.", drives: ["masks"] },
    { key: "expansion", label: "Grow/shrink edge (this scene)", control: "slider", default: 0, min: -40, max: 40, unit: "px", help: "Adds to the area's own edge setting, only in this scene.", drives: ["masks"] },
    { key: "fadeIn", label: "Fade in", control: "seconds", default: 0.3, min: 0, max: 10, step: 0.1, unit: "s", drives: ["transform.opacity"] },
    { key: "fadeOut", label: "Fade out", control: "seconds", default: 0.3, min: 0, max: 10, step: 0.1, unit: "s", drives: ["transform.opacity"] },
    { key: "seconds", label: "Duration", control: "seconds", default: 10, min: 0.5, max: 3600, step: 0.5, unit: "s", drives: ["outPoint"] },
  ],
  generate: (ctx) => {
    const p = ctx.params;
    const asset = typeof p.assetId === "string" ? ctx.project.assets[p.assetId] : undefined;
    if (!asset || (asset.kind !== "image" && asset.kind !== "video") || !asset.meta.width || !asset.meta.height) return [];
    const aw = asset.meta.width;
    const ah = asset.meta.height;
    const fit = String(p.fit ?? "fill");
    const cl = clamp(num(p.cropL, 0), 0, 45) / 100;
    const cr = clamp(num(p.cropR, 0), 0, 45) / 100;
    const ct = clamp(num(p.cropT, 0), 0, 45) / 100;
    const cb = clamp(num(p.cropB, 0), 0, 45) / 100;
    const cw = aw * (1 - cl - cr);
    const ch = ah * (1 - ct - cb);
    const cropped = cl + cr + ct + cb > 0;
    const k = clamp(num(p.scale, 100), 1, 1000) / 100;
    const speed = clamp(num(p.speed, 100), 1, 1000) / 100;
    const trim = Math.max(0, num(p.trim, 0));
    const isVideo = asset.kind === "video";
    const clipSeconds = asset.meta.duration ? asset.meta.duration / FLICKS_PER_SECOND : 10;
    const seconds = num(p.seconds, isVideo && p.loop === false ? Math.max(0.5, (clipSeconds - trim) / speed) : 10);
    const start = ctx.startTime;
    const end = Math.max(start + 1, Math.min(ctx.comp.duration, start + secondsToTime(seconds)));
    const groups = p.mode === "across" ? [ctx.targets] : ctx.targets.map((t) => [t]);
    const fadeIn = Math.max(0, num(p.fadeIn, 0.3));
    const fadeOut = Math.max(0, num(p.fadeOut, 0.3));
    const strength = clamp(num(p.opacity, 100), 0, 100);
    const opacityKeys = (base: string): Keyframe<number>[] => {
      const keys: Array<[Flicks, number]> = [];
      if (fadeIn > 0) keys.push([start, 0], [Math.min(end, start + secondsToTime(fadeIn)), strength]);
      if (fadeOut > 0) keys.push([Math.max(start, end - secondsToTime(fadeOut)), strength], [end, 0]);
      return keys.map(([t, v], i) => ({ id: `${base}_${i}`, t, v, in: "bezier", out: "bezier", easeIn: [EASY_EASE], easeOut: [EASY_EASE] }));
    };
    const blend = ["normal", "add", "screen", "multiply"].includes(String(p.blend)) ? (String(p.blend) as Layer["blendMode"]) : "normal";

    return groups.map((targets, gi) => {
      const b = pathBounds(targets.map((t) => t.region.path));
      const sx = b.w / cw;
      const sy = b.h / ch;
      const s = fit === "fit" ? Math.min(sx, sy) : Math.max(sx, sy);
      const scale: Vec3 = fit === "stretch" ? [sx * k * 100, sy * k * 100, 100] : [s * k * 100, s * k * 100, 100];
      const center: Vec3 = [b.x + b.w / 2 + (num(p.offsetX, 0) / 100) * b.w, b.y + b.h / 2 + (num(p.offsetY, 0) / 100) * b.h, 0];
      const feather = Math.max(0, num(p.feather, 0));
      const expansion = num(p.expansion, 0);
      const masks: Mask[] = targets
        .filter((t) => t.region.path.closed)
        .map((t, i) => ({ id: `area${i}`, name: t.region.name, source: { kind: "region", ref: t.ref }, mode: "add", inverted: false, feather: staticProp(feather), expansion: staticProp(expansion), opacity: staticProp(100) }));
      if (cropped) {
        const x0 = aw * cl;
        const y0 = ah * ct;
        masks.push({
          id: "crop",
          name: "Crop",
          source: { kind: "path", path: staticProp(packPath({ closed: true, vertices: [{ p: [x0, y0] }, { p: [x0 + cw, y0] }, { p: [x0 + cw, y0 + ch] }, { p: [x0, y0 + ch] }] })) },
          mode: "intersect",
          inverted: false,
          feather: staticProp(0),
          expansion: staticProp(0),
          opacity: staticProp(100),
        });
      }
      const keys = opacityKeys(`${ctx.instanceId}_o${gi}`);
      const layer: Omit<Layer, "id" | "generatedBy"> = {
        name: `${asset.name}${groups.length > 1 ? ` — ${targets[0]!.region.name}` : ""}`,
        source: { kind: "footage", assetId: asset.id, ...(isVideo && p.loop !== false ? { loop: true } : {}) },
        // The clip starts `trim` seconds in at the effect's start; speed is the layer stretch.
        startTime: start - Math.round(secondsToTime(trim) / speed),
        inPoint: start,
        outPoint: end,
        stretch: speed,
        enabled: true,
        solo: false,
        locked: false,
        // Repeated copies play in step, so only the first carries the sound (once, not once per area).
        audioEnabled: isVideo && gi === 0,
        ...(isVideo && gi === 0 && asset.audioPath ? { audio: { ...defaultAudio(), volume: staticProp(clamp(num(p.volume, 0), -60, 12)), ...(num(p.volume, 0) <= -60 ? { muted: true } : {}) } } : {}),
        is3D: false,
        blendMode: blend,
        transform: {
          anchor: staticProp<Vec3>([aw * cl + cw / 2, ah * ct + ch / 2, 0]),
          position: staticProp(center, true),
          scale: staticProp(scale),
          rotation: staticProp<Vec3>([0, 0, num(p.rotation, 0)]),
          opacity: keys.length ? { value: strength, keyframes: keys } : staticProp(strength),
        },
        masks,
        effects: [],
      };
      return { role: `content-${gi}`, layer };
    });
  },
};

registerRecipe(areaContent);

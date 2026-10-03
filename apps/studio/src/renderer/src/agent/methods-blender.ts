/** Agent methods for Blender: simulated effects, linked .blend files, updates after editing. */
import { BLENDER_EFFECTS } from "@be/core";
import { z } from "zod";
import { blenderEffect, linkBlendFile, openInBlender, rebuildBlenderEffect, updateFromBlender } from "../studio/blenderEffects.ts";
import { useStudio } from "../studio/store.ts";
import { AgentError, method } from "./core.ts";
import { areaIds } from "./methods-show.ts";

const linkInfo = (id: string) => {
  const l = useStudio.getState().project?.blenderLinks?.[id];
  if (!l) throw new AgentError("not_found", `No Blender link "${id}" (see blender.list).`);
  return { id: l.id, name: l.name, origin: l.origin, effect: l.effect?.kind ?? null, blendFile: l.blendFile ?? null, scene: l.compId, startSeconds: l.startSeconds, seconds: l.seconds, quality: l.quality, layer: l.layerId ?? null, renderedAt: l.result?.renderedAt ?? null };
};
const fail = (r: { ok: false; message: string; code?: string }) => {
  throw new AgentError(r.code === "no_blender" ? "unavailable" : r.code === "cancelled" ? "cancelled" : "failed", r.message);
};

method({
  name: "blender.status",
  summary: "Whether Blender was found (path, version) and which Blender jobs are running.",
  params: z.object({ refresh: z.boolean().optional() }),
  run: (p) => window.be.blender.status(!!p.refresh),
});

method({
  name: "blender.list",
  summary: "The project's Blender links (simulated effects and linked .blend files) with their result layers.",
  params: z.object({}),
  run: () => ({ links: Object.keys(useStudio.getState().project?.blenderLinks ?? {}).map(linkInfo) }),
});

method({
  name: "blender.effect",
  summary: `Simulate a physical effect on areas in Blender and add it to the current scene as a video layer lined up with the canvas: ${Object.entries(BLENDER_EFFECTS).map(([k, v]) => `${k} (${v.description})`).join("; ")}. The house blocks and hides the simulation (it flows around walls). Waits until Blender has finished (typically 1–3 minutes); progress arrives as events. Params: color ("#rrggbb"), density, swirl, linger (frames the smoke lasts) for smoke/fire; fuel (fire); push, pourFor (0..1 of the length) for liquid; revealAt (0..1, when the sheet lets go) for cloth.`,
  params: z.object({
    kind: z.enum(["smoke", "fire", "liquid", "cloth"]),
    areas: z.array(z.string()).min(1),
    seconds: z.number().min(0.5).max(30).optional(),
    startSeconds: z.number().min(0).optional(),
    quality: z.enum(["draft", "full"]).optional(),
    params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
    timeoutMs: z.number().int().optional(),
  }),
  mutates: true,
  long: true,
  run: async (p, ctx) => {
    const ids = areaIds(p.areas);
    const r = await blenderEffect(p.kind, ids, { ...(p.seconds ? { seconds: p.seconds } : {}), ...(p.startSeconds !== undefined ? { startSeconds: p.startSeconds } : {}), ...(p.quality ? { quality: p.quality } : {}), ...(p.params ? { params: p.params } : {}) });
    if (!r.ok) fail(r);
    void ctx;
    return { link: linkInfo((r as { linkId: string }).linkId) };
  },
});

method({
  name: "blender.link",
  summary: "Render a .blend file (your own Blender scene) and add it to the current scene as a video layer.",
  params: z.object({ file: z.string(), seconds: z.number().min(0.5).max(60).optional(), quality: z.enum(["draft", "full"]).optional(), timeoutMs: z.number().int().optional() }),
  mutates: true,
  long: true,
  run: async (p) => {
    const r = await linkBlendFile(p.file, { ...(p.seconds ? { seconds: p.seconds } : {}), ...(p.quality ? { quality: p.quality } : {}) });
    if (!r.ok) fail(r);
    return { link: linkInfo((r as { linkId: string }).linkId) };
  },
});

method({
  name: "blender.update",
  summary: "Render a Blender link's .blend again (after it was edited in Blender) and replace its video in place; or rebuild an effect at another length or quality (rebuilding replaces edits made in Blender).",
  params: z.object({ link: z.string(), rebuild: z.object({ seconds: z.number().min(0.5).max(30).optional(), quality: z.enum(["draft", "full"]).optional() }).optional(), timeoutMs: z.number().int().optional() }),
  mutates: true,
  long: true,
  run: async (p) => {
    const r = p.rebuild ? await rebuildBlenderEffect(p.link, p.rebuild) : await updateFromBlender(p.link);
    if (!r.ok) fail(r);
    return { link: linkInfo(p.link) };
  },
});

method({
  name: "blender.open",
  summary: "Open a Blender link's .blend in Blender's own window for editing (then call blender.update).",
  params: z.object({ link: z.string() }),
  run: async (p) => openInBlender(p.link),
});

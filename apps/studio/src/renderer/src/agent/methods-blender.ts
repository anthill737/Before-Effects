/** Agent methods for Blender: simulated effects, linked .blend files, updates after editing. */
import { BLENDER_EFFECTS, BLENDER_PARAMS, type BlenderEffectKind } from "@be/core";
import { z } from "zod";
import { blenderEffect, importBlendAsEditable, importEditable, linkBlendFile, openInBlender, rebuildBlenderEffect, updateFromBlender } from "../studio/blenderEffects.ts";
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
  summary: `Simulate a physical effect on areas in Blender and add it to the current scene as a video layer lined up with the canvas: ${Object.entries(BLENDER_EFFECTS).map(([k, v]) => `${k} (${v.description})`).join("; ")}. The house blocks and hides the simulation (it flows around walls). Waits until Blender has finished (typically 1–3 minutes); progress arrives as events. Params per kind (key: meaning, default): ${Object.entries(BLENDER_PARAMS).map(([k, ps]) => `${k} — ${ps.map((x) => `${x.key}: ${x.label.toLowerCase()}${x.unit ? ` (${x.unit})` : ""}, ${x.default}`).join("; ")}`).join(" | ")}.`,
  params: z.object({
    kind: z.enum(Object.keys(BLENDER_EFFECTS) as [BlenderEffectKind, ...BlenderEffectKind[]]),
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
  summary:
    "Render a Blender link's .blend again (after it was edited in Blender) and replace its video in place; or rebuild an effect with changed settings (params, as for blender.effect), start, length or quality — rebuilding replaces edits made in Blender.",
  params: z.object({
    link: z.string(),
    rebuild: z
      .object({
        seconds: z.number().min(0.5).max(60).optional(),
        startSeconds: z.number().min(0).optional(),
        quality: z.enum(["draft", "full"]).optional(),
        params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
      })
      .optional(),
    timeoutMs: z.number().int().optional(),
  }),
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

method({
  name: "blender.importEditable",
  summary:
    "Bring a linked .blend in as editable 3D: Blender exports its meshes, materials, lights and animation (baked over the link's length) to a model in a 3D layer you can move, retime and light. Again after editing in Blender: the model is replaced, placement kept. Returns the per-object report: editable, approximated, video-only (simulations, particles, volumes) or skipped (cameras, area lights).",
  params: z.object({ link: z.string().optional(), file: z.string().optional().describe("a .blend to bring straight in (no video needed)"), seconds: z.number().min(0.5).max(60).optional(), timeoutMs: z.number().int().optional() }),
  mutates: true,
  long: true,
  run: async (p) => {
    let linkId = p.link;
    if (!linkId) {
      if (!p.file) throw new AgentError("invalid_params", "Give a link or a file.");
      const r = await importBlendAsEditable(p.file, p.seconds ? { seconds: p.seconds } : {});
      if (!r.ok) fail(r);
      linkId = (r as { linkId: string }).linkId;
    } else {
      const r = await importEditable(linkId);
      if (!r.ok) fail(r);
    }
    const l = useStudio.getState().project!.blenderLinks![linkId]!;
    return { link: linkInfo(linkId), layer: l.editable?.layerId, scene: l.editable?.sceneId, report: l.editable?.report };
  },
});

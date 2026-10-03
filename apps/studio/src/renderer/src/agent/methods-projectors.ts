/** Agent methods for several projectors: list, add, change, remove, arrange, align, blend, and pick the one previews show. */
import { blendSetup, blendWeight, newProjector, type Projector, venueBlend } from "@be/core";
import { z } from "zod";
import { arrangeAll, currentProjector, useProjectorPick } from "../studio/projectors.ts";
import { activeVenue, useStudio } from "../studio/store.ts";
import { AgentError, currentRevision, method } from "./core.ts";

const st = () => useStudio.getState();
const venueNow = () => {
  const v = activeVenue({ project: st().project! });
  if (!v) throw new AgentError("not_found", "There's no building (venue) yet.");
  return v;
};
export const projectorRef = (ref: string): Projector => {
  const v = venueNow();
  const p = v.projectors[ref] ?? Object.values(v.projectors).find((x) => x.name.toLowerCase() === ref.toLowerCase());
  if (!p) throw new AgentError("not_found", `No projector "${ref}" (see projectors.list).`);
  return p;
};
const info = (p: Projector) => ({
  id: p.id,
  name: p.name,
  width: p.output.width,
  height: p.output.height,
  alignmentLocked: p.calibration.locked,
  points: p.calibration.points.map((x) => ({ id: x.id, content: x.content, output: x.output })),
  outputColor: p.outputColor,
});

method({
  name: "projectors.list",
  summary: "The building's projectors (order, output size, alignment points, output correction), which one previews show, edge blending, and how much of the picture overlapping projectors share.",
  params: z.object({}),
  run: () => {
    const v = venueNow();
    const setup = blendSetup(v);
    let lit = 0, shared = 0;
    const n = 40;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const c: [number, number] = [((i + 0.5) / n) * v.canvas.width, ((j + 0.5) / n) * v.canvas.height];
        const k = setup.filter((p) => blendWeight(c, 0, [p], 1) > 0).length;
        if (k) lit++;
        if (k > 1) shared++;
      }
    return {
      projectors: v.projectorOrder.map((id) => info(v.projectors[id]!)),
      current: currentProjector(v)?.id ?? null,
      blend: venueBlend(v),
      coverage: { litPercent: Math.round((lit / (n * n)) * 100), sharedPercent: Math.round((shared / (n * n)) * 100) },
    };
  },
});

method({
  name: "projectors.add",
  summary: "Add a projector (output size in pixels, default 1920×1080). Its alignment starts with the whole picture fitted; use projectors.arrange or projectors.align.",
  params: z.object({ name: z.string().optional(), width: z.number().int().min(16).max(16384).optional(), height: z.number().int().min(16).max(16384).optional() }),
  mutates: true,
  run: (p, ctx) => {
    const v = venueNow();
    const pr = newProjector(v, { name: p.name ?? `Projector ${v.projectorOrder.length + 1}`, width: p.width ?? 1920, height: p.height ?? 1080 });
    ctx.edit(() => st().apply({ type: "projector.add", args: { venueId: v.id, projector: pr } }, { label: `Add ${pr.name}` }));
    return { projector: info(pr), revision: currentRevision() };
  },
});

method({
  name: "projectors.update",
  summary: "Rename a projector, change its output size, or its output correction: gamma (1 = as is), gain [r,g,b] (1 = as is), blackLevel (0..0.5).",
  params: z.object({
    projector: z.string(),
    name: z.string().optional(),
    width: z.number().int().min(16).max(16384).optional(),
    height: z.number().int().min(16).max(16384).optional(),
    gamma: z.number().min(0.2).max(5).optional(),
    gain: z.tuple([z.number(), z.number(), z.number()]).optional(),
    blackLevel: z.number().min(0).max(0.5).optional(),
  }),
  mutates: true,
  run: (p, ctx) => {
    const v = venueNow();
    const pr = projectorRef(p.projector);
    const changes: Record<string, unknown> = {};
    if (p.name) changes.name = p.name;
    if (p.width || p.height) changes.output = { ...pr.output, width: p.width ?? pr.output.width, height: p.height ?? pr.output.height };
    if (p.gamma !== undefined || p.gain || p.blackLevel !== undefined) changes.outputColor = { gamma: p.gamma ?? pr.outputColor.gamma, gain: p.gain ? [...p.gain, 1] : pr.outputColor.gain, blackLevel: p.blackLevel ?? pr.outputColor.blackLevel };
    ctx.edit(() => st().apply({ type: "projector.update", args: { venueId: v.id, projectorId: pr.id, changes } }, { label: `Change ${pr.name}` }));
    return { projector: info(venueNow().projectors[pr.id]!), revision: currentRevision() };
  },
});

method({
  name: "projectors.remove",
  summary: "Remove a projector and its alignment.",
  params: z.object({ projector: z.string() }),
  mutates: true,
  run: (p, ctx) => {
    const v = venueNow();
    const pr = projectorRef(p.projector);
    ctx.edit(() => st().apply({ type: "projector.remove", args: { venueId: v.id, projectorId: pr.id } }, { label: `Remove ${pr.name}` }));
    return { removed: pr.id, revision: currentRevision() };
  },
});

method({
  name: "projectors.arrange",
  summary: "Starting alignment for all projectors: the picture split side by side (or one above the other) with overlapPercent of each slice shared with the neighbour, for blending.",
  params: z.object({ layout: z.enum(["side-by-side", "stacked"]), overlapPercent: z.number().min(0).max(90).optional() }),
  mutates: true,
  run: (p, ctx) => {
    const v = venueNow();
    ctx.edit(() => arrangeAll(v, p.layout, (p.overlapPercent ?? 15) / 100));
    return { projectors: venueNow().projectorOrder.map((id) => info(venueNow().projectors[id]!)), revision: currentRevision() };
  },
});

method({
  name: "projectors.align",
  summary: "Set a projector's alignment points (at least 4): where content points (canvas px) land in its output (projector px). The same as dragging the numbered points.",
  params: z.object({ projector: z.string(), points: z.array(z.object({ content: z.tuple([z.number(), z.number()]), output: z.tuple([z.number(), z.number()]) })).min(4) }),
  mutates: true,
  run: (p, ctx) => {
    const v = venueNow();
    const pr = projectorRef(p.projector);
    const points = p.points.map((x, i) => ({ id: `c${i + 1}`, label: String(i + 1), content: x.content, output: x.output }));
    ctx.edit(() => st().apply({ type: "calibration.setPoints", args: { venueId: v.id, projectorId: pr.id, mode: "corner-pin", points } }, { label: `Align ${pr.name}` }));
    return { projector: info(venueNow().projectors[pr.id]!), revision: currentRevision() };
  },
});

method({
  name: "projectors.blend",
  summary: "Edge blending where projectors overlap: on/off and the cross-fade curve (1 straight, 2 smooth, 3 softer).",
  params: z.object({ enabled: z.boolean().optional(), curve: z.number().min(0.5).max(4).optional() }),
  mutates: true,
  run: (p, ctx) => {
    const v = venueNow();
    ctx.edit(() => st().apply({ type: "venue.setBlend", args: { venueId: v.id, ...(p.enabled !== undefined ? { enabled: p.enabled } : {}), ...(p.curve !== undefined ? { curve: p.curve } : {}) } }, { label: "Edge blending" }));
    return { blend: venueBlend(venueNow()), revision: currentRevision() };
  },
});

method({
  name: "projectors.select",
  summary: "Choose which projector the preview's projector view, its alignment points and exports use (not saved in the project).",
  params: z.object({ projector: z.string() }),
  run: (p) => {
    const pr = projectorRef(p.projector);
    useProjectorPick.setState({ id: pr.id });
    return { current: pr.id };
  },
});

// ---- outputs (full-screen projector windows) -----------------------------------------------------

method({
  name: "displays.list",
  summary: "Connected displays (id, label, pixel size, main screen) — where projector outputs can open.",
  params: z.object({}),
  run: () => window.be.displays.list(),
});

method({
  name: "outputs.list",
  summary: "Open projector outputs: display, size, what each is showing (frame, frames per second, when), and outputs waiting for a disconnected display.",
  params: z.object({}),
  run: async () => ({ outputs: await window.be.windows.outputs(), at: Date.now() }),
});

method({
  name: "outputs.open",
  summary: "Open a projector's full-screen output on a display (default: the one it was last shown on, else a non-main display). The choice is remembered with the project. pattern: none (the show), identify, grid, checker, white, black, colors.",
  params: z.object({ projector: z.string(), display: z.number().int().optional(), pattern: z.enum(["none", "identify", "grid", "checker", "white", "black", "colors"]).optional() }),
  mutates: true,
  run: async (p, ctx) => {
    const v = venueNow();
    const pr = projectorRef(p.projector);
    const displays = await window.be.displays.list();
    const d = (p.display !== undefined ? displays.find((x) => x.id === p.display) : undefined) ?? displays.find((x) => String(x.id) === pr.output.displayId) ?? displays.find((x) => !x.primary) ?? displays[0];
    if (!d) throw new AgentError("unavailable", "No display found.");
    if (pr.output.displayId !== String(d.id)) ctx.edit(() => st().apply({ type: "projector.update", args: { venueId: v.id, projectorId: pr.id, changes: { output: { ...pr.output, displayId: String(d.id) } } } }, { label: `Show ${pr.name} on ${d.label}` }));
    return { output: await window.be.windows.openOutput({ venueId: v.id, projectorId: pr.id, displayId: d.id, pattern: p.pattern ?? "none" }), revision: currentRevision() };
  },
});

method({
  name: "outputs.close",
  summary: "Close a projector's output (or all of them).",
  params: z.object({ projector: z.string().optional() }),
  run: async (p) => {
    const list = await window.be.windows.outputs();
    const ids = p.projector ? [projectorRef(p.projector).id] : list.map((o) => o.projectorId);
    for (const id of ids) await window.be.windows.closeOutput(id);
    return { closed: ids };
  },
});

method({
  name: "outputs.pattern",
  summary: "Switch an open output (or all: blackout with black, back to the show with none) to a test pattern.",
  params: z.object({ projector: z.string().optional(), pattern: z.enum(["none", "identify", "grid", "checker", "white", "black", "colors"]) }),
  run: async (p) => {
    const list = await window.be.windows.outputs();
    const ids = p.projector ? [projectorRef(p.projector).id] : list.filter((o) => o.open).map((o) => o.projectorId);
    for (const id of ids) await window.be.windows.setOutputPattern(id, p.pattern);
    return { projectors: ids, pattern: p.pattern };
  },
});

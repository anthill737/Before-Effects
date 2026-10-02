/** Agent methods for automatic house setup and reshaping areas (split, join). */
import { z } from "zod";
import { mergeAreas, splitArea } from "../space/areaEdit.ts";
import { acceptProposals, addProposals, cancelDetection, discardProposals, proposedAreas, runDetection, useHouseSetup } from "../space/houseSetup.ts";
import { activeVenue, useStudio } from "../studio/store.ts";
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

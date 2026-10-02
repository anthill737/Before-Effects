/**
 * Automatic house setup: find the parts of the house in the photo (in a background process on
 * this computer), add them as proposed areas in one undo step, then review — reshape, rename,
 * re-classify, split, merge or remove — and accept. Proposed areas aren't used by effects until
 * accepted; accepting binds them to their kind's role and groups them (windows, openings, lights).
 * The facade is proposed with the openings cut out of it (the cut follows them when reshaped).
 */
import { type HouseDetection, type HouseProposal, newId, type Op, pointsBox, polygonPath, type Region, type RegionGroup, type Venue, boxIou } from "@be/core";
import { create } from "zustand";
import type { DetectStatus } from "../../../shared/api.ts";
import { activeVenue, useStudio } from "../studio/store.ts";
import { KIND_ROLE, useTrace } from "./traceStore.ts";

type Phase = "idle" | "consent" | "running" | "done" | "failed" | "cancelled";

export const useHouseSetup = create<{
  phase: Phase;
  requestId: string | null;
  fraction: number;
  text: string;
  error: string | null;
  status: DetectStatus | null;
  /** What the last run found and added (for the summary line). */
  summary: { added: number; uncertain: number; skipped: number; seconds: number; device: string; notes: readonly string[] } | null;
}>(() => ({ phase: "idle", requestId: null, fraction: 0, text: "", error: null, status: null, summary: null }));

let progressHooked = false;
const hookProgress = () => {
  if (progressHooked) return;
  progressHooked = true;
  window.be.detect.onProgress((p) => {
    if (p.requestId === useHouseSetup.getState().requestId) useHouseSetup.setState({ fraction: p.fraction, text: p.text });
  });
};

const venueNow = (): Venue | undefined => {
  const s = useStudio.getState();
  return s.project ? activeVenue({ project: s.project }) : undefined;
};

/** The placed photo detection looks at (canvas-sized, so results are in canvas pixels). */
const photoFor = (v: Venue | undefined) => {
  const a = v?.referenceAssetId ? useStudio.getState().project?.assets[v.referenceAssetId] : undefined;
  return a && !a.missing ? a : undefined;
};

export const proposedAreas = (v: Venue | undefined = venueNow()): Region[] => (v ? v.regionOrder.map((id) => v.regions[id]!).filter((r) => r?.proposal) : []);

/** Run detection on the active venue's photo. Doesn't change the show. */
export const runDetection = async (opts: { allowDownload: boolean; device?: "gpu" | "cpu"; requestId?: string }): Promise<{ ok: true; detection: HouseDetection; referenceAssetId: string } | { ok: false; code: string; message: string }> => {
  const v = venueNow();
  const photo = photoFor(v);
  if (!v || !photo) return { ok: false, code: "no_photo", message: "This show has no building photo to look at. Start a show from a photo of the building first." };
  hookProgress();
  const requestId = opts.requestId ?? newId("detect");
  useHouseSetup.setState({ phase: "running", requestId, fraction: 0, text: "Starting", error: null });
  const r = await window.be.detect.run(requestId, photo.path, { allowDownload: opts.allowDownload, ...(opts.device ? { device: opts.device } : {}) });
  if (useHouseSetup.getState().requestId === requestId) {
    if (r.ok) useHouseSetup.setState({ phase: "done", requestId: null });
    else useHouseSetup.setState({ phase: r.code === "cancelled" ? "cancelled" : r.code === "needs-download" ? "consent" : "failed", requestId: null, error: r.code === "cancelled" ? null : r.message });
  }
  return r.ok ? { ok: true, detection: r.detection, referenceAssetId: photo.id } : r;
};

export const cancelDetection = async () => {
  const id = useHouseSetup.getState().requestId;
  if (id) await window.be.detect.cancel(id);
};

/**
 * Operations adding a detection's proposals as areas: earlier unreviewed proposals are replaced,
 * and parts already traced (an area of the same kind in the same place) are skipped.
 */
export const proposalOps = (v: Venue, d: HouseDetection) => {
  const batch = newId("found");
  const earlier = proposedAreas(v);
  const kept = Object.values(v.regions).filter((r) => !r.proposal);
  const taken = new Set(kept.map((r) => r.name));
  const unique = (n: string) => {
    if (!taken.has(n)) {
      taken.add(n);
      return n;
    }
    let i = 2;
    while (taken.has(`${n} ${i}`)) i++;
    taken.add(`${n} ${i}`);
    return `${n} ${i}`;
  };
  const skipped: HouseProposal[] = [];
  const ids = new Map<string, string>();
  const regions: Region[] = [];
  for (const p of d.proposals) {
    const box = pointsBox(p.points);
    const dup = kept.find((r) => r.kind === p.kind && boxIou(pointsBox(r.path.vertices.map((x) => x.p)), box) > 0.5);
    if (dup) {
      skipped.push(p);
      continue;
    }
    const id = newId("rgn");
    ids.set(p.key, id);
    regions.push({
      id,
      name: unique(p.name),
      kind: p.kind,
      path: polygonPath(p.points.map((q) => [Math.round(q[0] * 10) / 10, Math.round(q[1] * 10) / 10] as const), p.closed),
      tags: ["found"],
      proposal: { batch, score: Math.round(p.score * 100) / 100, outline: p.outline, ...(p.uncertain ? { uncertain: p.uncertain } : {}) },
    });
  }
  // Openings are cut out of the facade.
  for (const r of regions) {
    const key = [...ids.entries()].find(([, id]) => id === r.id)![0];
    const cut = d.proposals.filter((p) => p.cutFrom === key && ids.has(p.key)).map((p) => ids.get(p.key)!);
    if (cut.length) Object.assign(r, { cutouts: cut });
  }
  const ops: Op[] = [...earlier.map((r) => ({ type: "region.remove", args: { venueId: v.id, regionId: r.id } })), ...regions.map((region) => ({ type: "region.add", args: { venueId: v.id, region } }))];
  return { ops, batch, regions, skipped, replaced: earlier.length };
};

/** Add a detection's proposals to the show (one undo step). */
export const addProposals = (d: HouseDetection, referenceAssetId: string) => {
  const v = venueNow();
  if (!v) return null;
  if (v.referenceAssetId !== referenceAssetId) {
    useStudio.getState().toast({ kind: "info", text: "The photo was moved or replaced while looking for areas, so the results were set aside. Try again." });
    return null;
  }
  const r = proposalOps(v, d);
  if (!r.ops.length) return r;
  useStudio.getState().apply(r.ops, { label: "Find areas automatically" });
  // Next comes reviewing: the Select tool lets the found outlines be clicked and reshaped.
  useTrace.getState().set({ tool: "select", draft: [], pending: null });
  useHouseSetup.setState({ summary: { added: r.regions.length, uncertain: r.regions.filter((x) => x.proposal?.uncertain).length, skipped: r.skipped.length, seconds: d.seconds, device: d.device, notes: d.notes } });
  return r;
};

/** The whole flow from the Areas panel: check the models (ask before downloading), run, add proposals. */
export const findAreasAutomatically = async (opts: { allowDownload?: boolean } = {}) => {
  const status = await window.be.detect.status();
  useHouseSetup.setState({ status, error: null });
  if (status.downloadMB > 0 && !opts.allowDownload) {
    useHouseSetup.setState({ phase: "consent" });
    return null;
  }
  const r = await runDetection({ allowDownload: !!opts.allowDownload });
  if (!r.ok) return null;
  return addProposals(r.detection, r.referenceAssetId);
};

/**
 * Accept proposals (all, or the given areas): they become ordinary areas, bound to their kind's
 * role (so effects for "all windows" use them) and grouped as Windows, Openings and Lights.
 */
export const acceptOps = (v: Venue, ids?: readonly string[]): Op[] => {
  const accept = proposedAreas(v).filter((r) => !ids || ids.includes(r.id));
  if (!accept.length) return [];
  const ops: Op[] = accept.map((r) => ({ type: "region.update", args: { venueId: v.id, regionId: r.id, changes: { proposal: null } } }));
  const project = useStudio.getState().project!;
  const roles = new Map<string, string[]>();
  for (const r of accept) {
    const role = KIND_ROLE[r.kind];
    const now = roles.get(role) ?? [...(project.bindings[v.id]?.roles[role] ?? [])];
    if (!now.includes(r.id)) now.push(r.id);
    roles.set(role, now);
  }
  for (const [role, regionIds] of roles) ops.push({ type: "binding.setRole", args: { venueId: v.id, role, regionIds } });
  // Groups over everything accepted so far (proposals still waiting aren't included).
  const settled = new Set([...Object.values(v.regions).filter((r) => !r.proposal).map((r) => r.id), ...accept.map((r) => r.id)]);
  const ofKinds = (kinds: string[]) => v.regionOrder.filter((id) => settled.has(id) && kinds.includes(v.regions[id]!.kind));
  const group = (name: string, regionIds: string[]) => {
    if (regionIds.length < 2) return;
    const existing = Object.values(v.groups).find((g) => g.name === name);
    const g: RegionGroup = { id: existing?.id ?? newId("grp"), name, regionIds: [...new Set([...(existing?.regionIds ?? []), ...regionIds])] };
    ops.push({ type: "group.set", args: { venueId: v.id, group: g } });
  };
  group("Windows", ofKinds(["window"]));
  group("Openings", ofKinds(["window", "door", "garage"]));
  group("Lights", ofKinds(["light"]));
  return ops;
};

export const acceptProposals = (ids?: readonly string[]) => {
  const v = venueNow();
  if (!v) return 0;
  const ops = acceptOps(v, ids);
  if (!ops.length) return 0;
  const n = proposedAreas(v).filter((r) => !ids || ids.includes(r.id)).length;
  useStudio.getState().apply(ops, { label: n === 1 ? "Accept a found area" : `Accept ${n} found areas` });
  return n;
};

export const discardProposals = (ids?: readonly string[]) => {
  const v = venueNow();
  if (!v) return 0;
  const drop = proposedAreas(v).filter((r) => !ids || ids.includes(r.id));
  if (!drop.length) return 0;
  useStudio.getState().apply(
    drop.map((r) => ({ type: "region.remove", args: { venueId: v.id, regionId: r.id } })),
    { label: drop.length === 1 ? "Remove a found area" : `Remove ${drop.length} found areas` },
  );
  return drop.length;
};

/**
 * Editing building areas (shared by every scene): duplicate, add/remove points, move an edge or the
 * whole area, cut holes, and name groups such as "Upstairs windows". Every action is one undo step.
 */
import { closeMask, convexHull, flattenPath, largestComponent, maskArea, newId, type Op, type PathData, polygonPath, type Region, simplify, splitOutline, traceOutline, type Vec2 } from "@be/core";
import { activeVenue, useStudio } from "../studio/store.ts";
import { KIND_ROLE } from "./traceStore.ts";

const venueNow = () => {
  const s = useStudio.getState();
  return s.project ? activeVenue({ project: s.project }) : undefined;
};

const updatePath = (r: Region, path: PathData, label: string, coalesceKey?: string) => {
  const v = venueNow();
  if (!v) return;
  useStudio.getState().apply({ type: "region.update", args: { venueId: v.id, regionId: r.id, changes: { path } } }, { label, ...(coalesceKey ? { coalesceKey } : {}), quiet: !!coalesceKey });
};

/** Copies of the areas, shifted so they're easy to see and drag into place. Returns the new ids. */
export const duplicateAreas = (ids: readonly string[], offset: Vec2 = [24, 24]): string[] => {
  const s = useStudio.getState();
  const v = venueNow();
  if (!v || !ids.length) return [];
  const made: string[] = [];
  const ops = ids.flatMap((id) => {
    const r = v.regions[id];
    if (!r) return [];
    const shift = (p: PathData): PathData => ({ ...p, vertices: p.vertices.map((x) => ({ ...x, p: [x.p[0] + offset[0], x.p[1] + offset[1]] as Vec2 })) });
    const same = Object.values(v.regions).filter((x) => x.kind === r.kind).length + made.length + 1;
    const base = r.name.replace(/\s*\d+$/, "");
    const copy: Region = { ...r, id: newId("rgn"), name: `${base} ${same}`, path: shift(r.path), ...(r.holes ? { holes: r.holes.map(shift) } : {}), tags: r.tags.filter((t) => t !== "suggested") };
    made.push(copy.id);
    return [{ type: "region.add", args: { venueId: v.id, region: copy, bindRole: KIND_ROLE[r.kind] } }];
  });
  if (!ops.length) return [];
  s.apply(ops, { label: ids.length > 1 ? `Duplicate ${ids.length} areas` : "Duplicate area" });
  // Duplicates join the same groups as their originals.
  for (const g of Object.values(v.groups)) {
    const add = ids.map((id, i) => (g.regionIds.includes(id) ? made[i]! : null)).filter((x): x is string => !!x);
    if (add.length) s.apply({ type: "group.set", args: { venueId: v.id, group: { ...g, regionIds: [...g.regionIds, ...add] } } }, { label: "Duplicate area" });
  }
  s.selectRegions(made);
  return made;
};

export const insertPoint = (r: Region, afterIndex: number, at: Vec2) => {
  const vs = [...r.path.vertices];
  vs.splice(afterIndex + 1, 0, { p: [Math.round(at[0]), Math.round(at[1])] });
  updatePath(r, { ...r.path, vertices: vs }, "Add a point");
};

export const removePoint = (r: Region, index: number): boolean => {
  const min = r.path.closed ? 3 : 2;
  if (r.path.vertices.length <= min) {
    useStudio.getState().toast({ kind: "info", text: `An area needs at least ${min} points.` });
    return false;
  }
  updatePath(r, { ...r.path, vertices: r.path.vertices.filter((_, i) => i !== index) }, "Remove a point");
  return true;
};

/** Move the edge from point `index` to the next by (dx, dy) — both of its points follow. */
export const moveEdge = (r: Region, base: PathData, index: number, d: Vec2, key: string) => {
  const n = base.vertices.length;
  const j = (index + 1) % n;
  const vertices = base.vertices.map((v, i) => (i === index || i === j ? { ...v, p: [Math.round(v.p[0] + d[0]), Math.round(v.p[1] + d[1])] as Vec2 } : v));
  updatePath(r, { ...base, vertices }, "Move an edge", key);
};

/** Move the whole area (and its holes) by (dx, dy). */
export const moveArea = (r: Region, base: { path: PathData; holes?: readonly PathData[] }, d: Vec2, key: string) => {
  const v = venueNow();
  if (!v) return;
  const shift = (p: PathData): PathData => ({ ...p, vertices: p.vertices.map((x) => ({ ...x, p: [Math.round(x.p[0] + d[0]), Math.round(x.p[1] + d[1])] as Vec2 })) });
  useStudio.getState().apply(
    { type: "region.update", args: { venueId: v.id, regionId: r.id, changes: { path: shift(base.path), ...(base.holes ? { holes: base.holes.map(shift) } : {}) } } },
    { label: "Move area", coalesceKey: key, quiet: true },
  );
};

export const addHole = (r: Region, hole: PathData) => {
  const v = venueNow();
  if (!v) return;
  useStudio.getState().apply({ type: "region.update", args: { venueId: v.id, regionId: r.id, changes: { holes: [...(r.holes ?? []), hole] } } }, { label: "Cut a hole" });
};

export const clearHoles = (r: Region) => {
  const v = venueNow();
  if (!v) return;
  useStudio.getState().apply({ type: "region.update", args: { venueId: v.id, regionId: r.id, changes: { holes: [] } } }, { label: "Remove holes" });
};

/** Name the selected areas as a group (e.g. "Upstairs windows"). Returns the group id. */
export const groupAreas = (ids: readonly string[], name: string): string | null => {
  const v = venueNow();
  if (!v || ids.length === 0) return null;
  const existing = Object.values(v.groups).find((g) => g.name.toLowerCase() === name.trim().toLowerCase());
  const id = existing?.id ?? newId("grp");
  const regionIds = existing ? [...new Set([...existing.regionIds, ...ids])] : [...ids];
  const tx = useStudio.getState().apply({ type: "group.set", args: { venueId: v.id, group: { id, name: name.trim() || "Group", regionIds } } }, { label: existing ? `Add to “${existing.name}”` : `Group as “${name.trim()}”` });
  return tx ? id : null;
};

export const renameGroup = (groupId: string, name: string) => {
  const v = venueNow();
  const g = v?.groups[groupId];
  if (!v || !g || !name.trim()) return;
  useStudio.getState().apply({ type: "group.set", args: { venueId: v.id, group: { ...g, name: name.trim() } } }, { label: "Rename group", coalesceKey: `grp-${groupId}` });
};

export const ungroup = (groupId: string) => {
  const v = venueNow();
  if (!v) return;
  useStudio.getState().apply({ type: "group.remove", args: { venueId: v.id, groupId } }, { label: "Ungroup" });
};

/** Which area is under a point (smallest first, so a window wins over the wall around it). */
export const areaAt = (p: Vec2): Region | null => {
  const v = venueNow();
  if (!v) return null;
  const inside = (pts: readonly Vec2[], x: number, y: number) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i]!;
      const [xj, yj] = pts[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const size = (r: Region) => {
    const xs = r.path.vertices.map((x) => x.p[0]);
    const ys = r.path.vertices.map((x) => x.p[1]);
    return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
  };
  const hits = v.regionOrder
    .map((id) => v.regions[id]!)
    .filter((r) => r && r.path.closed && r.kind !== "exclusion" && inside(r.path.vertices.map((x) => x.p), p[0], p[1]) && !(r.holes ?? []).some((h) => inside(h.vertices.map((x) => x.p), p[0], p[1])));
  return hits.sort((a, b) => size(a) - size(b))[0] ?? null;
};

/** A name like the area's, not used yet ("Window" → "Window 2"). */
const nextName = (name: string, taken: Set<string>) => {
  const base = name.replace(/\s*\d+$/, "");
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
};

/** The new area joins the original's roles, groups and parent cut-out, so it's used the same way. */
const sameUseOps = (venueId: string, from: string, to: string): Op[] => {
  const s = useStudio.getState();
  const v = venueNow()!;
  const ops: Op[] = [];
  for (const [role, ids] of Object.entries(s.project!.bindings[venueId]?.roles ?? {})) if (ids.includes(from)) ops.push({ type: "binding.setRole", args: { venueId, role, regionIds: [...ids, to] } });
  for (const g of Object.values(v.groups)) if (g.regionIds.includes(from)) ops.push({ type: "group.set", args: { venueId, group: { ...g, regionIds: [...g.regionIds, to] } } });
  for (const r of Object.values(v.regions)) if (r.cutouts?.includes(from)) ops.push({ type: "region.update", args: { venueId, regionId: r.id, changes: { cutouts: [...r.cutouts, to] } } });
  return ops;
};

/** Split an area in two — side by side or one above the other — e.g. a double window into its panes. */
export const splitArea = (id: string, how: "side" | "stacked", at = 0.5): [string, string] | null => {
  const v = venueNow();
  const r = v?.regions[id];
  if (!v || !r || !r.path.closed) return null;
  const pts = r.path.vertices.some((x) => x.in || x.out) ? flattenPath(r.path, 8) : r.path.vertices.map((x) => x.p);
  const [a, b] = splitOutline(pts, how, at);
  if (a.length < 3 || b.length < 3) return null;
  const round = (q: Vec2[]) => q.map((p) => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10] as Vec2);
  const second: Region = { ...r, id: newId("rgn"), name: nextName(r.name, new Set(Object.values(v.regions).map((x) => x.name))), path: polygonPath(round(b)), holes: [], tags: r.tags };
  delete (second as { cutouts?: unknown }).cutouts;
  useStudio.getState().apply(
    [
      { type: "region.update", args: { venueId: v.id, regionId: r.id, changes: { path: polygonPath(round(a)), holes: [] } } },
      { type: "region.add", args: { venueId: v.id, region: second } },
      ...sameUseOps(v.id, r.id, second.id),
    ],
    { label: `Split “${r.name}”` },
  );
  useStudio.getState().selectRegions([r.id, second.id]);
  return [r.id, second.id];
};

/**
 * Join areas into one (the first keeps its name, kind and uses): their combined outline when they
 * touch or overlap, else the outline around all of them.
 */
export const mergeAreas = (ids: readonly string[]): string | null => {
  const v = venueNow();
  const regs = ids.map((id) => v?.regions[id]).filter((r): r is Region => !!r && r.path.closed);
  if (!v || regs.length < 2) return null;
  const { width: W, height: H } = v.canvas;
  const c = new OffscreenCanvas(W, H);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#fff";
  let separate = 0;
  for (const r of regs) {
    const pts = flattenPath(r.path, 8);
    const path = new Path2D();
    pts.forEach((p, i) => (i ? path.lineTo(p[0], p[1]) : path.moveTo(p[0], p[1])));
    path.closePath();
    g.fill(path);
    separate += Math.abs(pts.reduce((a, p, i) => a + p[0] * pts[(i + 1) % pts.length]![1] - pts[(i + 1) % pts.length]![0] * p[1], 0) / 2);
  }
  const px = g.getImageData(0, 0, W, H).data;
  const data = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) data[i] = px[i * 4 + 3]! > 127 ? 1 : 0;
  const all = maskArea({ width: W, height: H, data });
  const joined = largestComponent(closeMask({ width: W, height: H, data }, 2));
  // Pieces that don't touch: use the outline around all of them.
  const outline = maskArea(joined) >= 0.97 * all ? simplify(traceOutline(joined), 1.5, true) : convexHull(regs.flatMap((r) => flattenPath(r.path, 8)));
  if (outline.length < 3 || separate <= 0) return null;
  const [first, ...rest] = regs as [Region, ...Region[]];
  const cutouts = [...new Set(regs.flatMap((r) => r.cutouts ?? []))].filter((x) => !ids.includes(x));
  useStudio.getState().apply(
    [
      ...rest.map((r) => ({ type: "region.remove", args: { venueId: v.id, regionId: r.id } })),
      { type: "region.update", args: { venueId: v.id, regionId: first.id, changes: { path: polygonPath(outline.map((p) => [Math.round(p[0]), Math.round(p[1])] as Vec2)), holes: [], ...(cutouts.length ? { cutouts } : {}) } } },
    ],
    { label: `Join ${regs.length} areas` },
  );
  useStudio.getState().selectRegions([first.id]);
  return first.id;
};

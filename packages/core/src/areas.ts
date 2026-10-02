/**
 * Building areas: traced outlines shared by every scene. Content refers to them by role, by id
 * or by group, so tracing a window once makes it available throughout the show, and reshaping it
 * updates every scene that uses it.
 */
import type { Id, PathData, Project, Region, RegionRef, Venue } from "./model.ts";

/** Region ids a reference points at (group → explicit ids → role binding), in order. */
export const refRegionIds = (project: Project, ref: RegionRef, venueId?: Id): Id[] => {
  const vid = venueId ?? project.activeVenueId;
  if (!vid) return [];
  const venue = project.venues[vid];
  if (!venue) return [];
  const list = ref.groupId ? (venue.groups[ref.groupId]?.regionIds ?? []) : ref.regionIds ? ref.regionIds : (project.bindings[vid]?.roles[ref.role] ?? []);
  const alive = list.filter((id) => !!venue.regions[id]);
  if (ref.index === undefined) return alive;
  return alive[ref.index] !== undefined ? [alive[ref.index]!] : [];
};

export const refRegions = (project: Project, ref: RegionRef, venueId?: Id): Region[] => {
  const vid = venueId ?? project.activeVenueId;
  const venue = vid ? project.venues[vid] : undefined;
  return venue ? refRegionIds(project, ref, vid).map((id) => venue.regions[id]!).filter(Boolean) : [];
};

const reversed = (p: PathData): PathData => ({
  closed: p.closed,
  vertices: [...p.vertices].reverse().map((v) => ({ p: v.p, ...(v.out ? { in: v.out } : {}), ...(v.in ? { out: v.in } : {}) })),
});

/** An area's holes: the ones cut by hand plus the current outlines of the areas cut out of it. */
export const regionHoles = (r: Region, venue?: Venue): PathData[] => [
  ...(r.holes ?? []),
  ...(venue ? (r.cutouts ?? []).map((id) => venue.regions[id]?.path).filter((p): p is PathData => !!p && p.closed) : []),
];

/** The area an area is cut out of (a window's facade), if any. */
export const cutoutParent = (venue: Venue, id: Id): Region | undefined => Object.values(venue.regions).find((r) => r.cutouts?.includes(id));

/** Outline of an area plus its holes. Holes run the other way round, so non-zero filling cuts them out. */
export const regionFillPaths = (r: Region, venue?: Venue): PathData[] => [r.path, ...regionHoles(r, venue).filter((h) => h.vertices.length >= 3).map(reversed)];

/**
 * The built-in sample: a stylised town-hall facade with traced regions (roofline, ten windows,
 * a door, two columns, the wall). It ships so a first-time user can try effects immediately,
 * before they've photographed or modelled their own building.
 */
import {
  type Composition,
  createRegistry,
  emptyProject,
  History,
  newComposition,
  newLayer,
  newProjector,
  type Op,
  type PathData,
  polygonPath,
  type Project,
  type Region,
  type RegionKind,
  secondsToTime,
  staticProp,
  type Venue,
  type Vec2,
} from "@be/core";

export const SAMPLE_W = 1920;
export const SAMPLE_H = 1080;

const rect = (x: number, y: number, w: number, h: number): Vec2[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

/** Arched door: straight sides with a Bezier half-circle top. */
const archedDoor = (x: number, y: number, w: number, h: number): PathData => {
  const r = w / 2;
  const k = 0.5523 * r;
  return {
    closed: true,
    vertices: [
      { p: [x, y + h] },
      { p: [x, y + r], out: [0, -k] },
      { p: [x + r, y], in: [-k, 0], out: [k, 0] },
      { p: [x + w, y + r], in: [0, -k] },
      { p: [x + w, y + h] },
    ],
  };
};

export interface SampleRegionSpec {
  readonly id: string;
  readonly name: string;
  readonly kind: RegionKind;
  readonly path: PathData;
  readonly role: string;
}

export const sampleRegions = (): SampleRegionSpec[] => {
  const out: SampleRegionSpec[] = [];
  out.push({ id: "wall", name: "Front wall", kind: "wall", role: "wall", path: polygonPath(rect(260, 320, 1400, 680)) });
  out.push({ id: "roofline", name: "Roofline", kind: "roofline", role: "roofline", path: polygonPath([[200, 330], [960, 96], [1720, 330]], false) });
  const cols = [340, 600, 860, 1120, 1380];
  cols.forEach((x, i) => out.push({ id: `win-top-${i + 1}`, name: `Upper window ${i + 1}`, kind: "window", role: "windows", path: polygonPath(rect(x + 15, 410, 170, 210)) }));
  [340, 600, 1120, 1380].forEach((x, i) =>
    out.push({ id: `win-low-${i + 1}`, name: `Lower window ${i + 1}`, kind: "window", role: "windows", path: polygonPath(rect(x + 15, 700, 170, 210)) }),
  );
  out.push({ id: "door", name: "Door", kind: "door", role: "door", path: archedDoor(880, 680, 160, 320) });
  out.push({ id: "col-left", name: "Left column", kind: "column", role: "columns", path: polygonPath(rect(268, 330, 52, 670)) });
  out.push({ id: "col-right", name: "Right column", kind: "column", role: "columns", path: polygonPath(rect(1600, 330, 52, 670)) });
  return out;
};

export const sampleVenue = (): Venue => {
  const specs = sampleRegions();
  const regions: Record<string, Region> = Object.fromEntries(specs.map((s) => [s.id, { id: s.id, name: s.name, kind: s.kind, path: s.path, tags: [] }]));
  const base: Venue = {
    id: "venue-sample",
    name: "Sample: Town hall",
    kind: "flat",
    canvas: { width: SAMPLE_W, height: SAMPLE_H },
    regionOrder: specs.map((s) => s.id),
    regions,
    groups: {
      "grp-windows": { id: "grp-windows", name: "All windows", regionIds: specs.filter((s) => s.kind === "window").map((s) => s.id), suggested: true },
    },
    projectorOrder: [],
    projectors: {},
  };
  const projector = newProjector(base, { id: "projector-1", name: "Projector 1", width: 1920, height: 1080 });
  return { ...base, projectors: { [projector.id]: projector }, projectorOrder: [projector.id] };
};

/** Ops that set up the sample project (venue, bindings, main scene). */
export const sampleSetupOps = (o: { withBase?: boolean; durationSeconds?: number } = {}): { ops: Op[]; compId: string; venue: Venue } => {
  const venue = sampleVenue();
  const comp: Composition = newComposition({ id: "comp-main", name: "Main show", width: SAMPLE_W, height: SAMPLE_H, durationSeconds: o.durationSeconds ?? 20, venueId: venue.id });
  const roles = new Map<string, string[]>();
  for (const s of sampleRegions()) roles.set(s.role, [...(roles.get(s.role) ?? []), s.id]);
  const ops: Op[] = [
    { type: "venue.add", args: { venue, makeActive: true } },
    { type: "comp.add", args: { comp, makeMain: true } },
    ...[...roles].map(([role, regionIds]) => ({ type: "binding.setRole", args: { venueId: venue.id, role, regionIds } })),
  ];
  if (o.withBase !== false) {
    // A gentle base wash on the wall so the building reads in the dark.
    const base = newLayer({
      id: "layer-base",
      name: "Wall wash",
      source: { kind: "solid", color: staticProp([0.05, 0.07, 0.16, 1] as const), width: SAMPLE_W, height: SAMPLE_H },
      duration: comp.duration,
    });
    ops.push({
      type: "layer.add",
      args: {
        compId: comp.id,
        layer: {
          ...base,
          masks: [{ id: "mask-wall", name: "Wall", source: { kind: "region", ref: { role: "wall" } }, mode: "add", inverted: false, feather: staticProp(6), expansion: staticProp(0), opacity: staticProp(100) }],
        },
      },
    });
  }
  return { ops, compId: comp.id, venue };
};

export const createSampleHistory = (): { history: History; compId: string } => {
  const history = new History(emptyProject("Town hall sample"), createRegistry());
  const { ops, compId } = sampleSetupOps();
  history.apply(ops, { label: "Open sample", source: "system" });
  history.markSaved();
  return { history, compId };
};

export const secondsF = secondsToTime;
export type { Project };

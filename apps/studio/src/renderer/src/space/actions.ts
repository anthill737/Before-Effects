/** Actions for "Set up the space": start from a photo, trace and name parts, find similar parts. */
import {
  type Asset,
  createRegistry,
  emptyProject,
  History,
  newComposition,
  newId,
  newProjector,
  type PathData,
  type Project,
  type Region,
  type RegionKind,
  type Venue,
} from "@be/core";
import { facadeBlob } from "../samples/facadeArt.ts";
import { activeVenue, useStudio } from "../studio/store.ts";
import { usePreview } from "../preview/settings.ts";
import { findSimilar } from "./similar.ts";
import { KIND_CHOICES, KIND_ROLE, useTrace } from "./traceStore.ts";

const registry = createRegistry();

/** Load the venue's reference photo as a Blob (imported photo, or the sample art). */
export const venuePhoto = async (project: Project): Promise<Blob | null> => {
  const venue = activeVenue({ project });
  if (!venue) return null;
  const asset = venue.referenceAssetId ? project.assets[venue.referenceAssetId] : undefined;
  if (asset) return new Blob([(await window.be.files.readFile(asset.path)) as BlobPart]);
  if (venue.id === "venue-sample") return facadeBlob();
  return null;
};

const photoUrls = new Map<string, string>();
/** Object URL for showing the photo under the preview while tracing. */
export const venuePhotoUrl = async (project: Project): Promise<string | null> => {
  const venue = activeVenue({ project });
  if (!venue) return null;
  const key = venue.referenceAssetId ? (project.assets[venue.referenceAssetId]?.path ?? "") : venue.id;
  const cached = photoUrls.get(key);
  if (cached) return cached;
  const blob = await venuePhoto(project);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  photoUrls.set(key, url);
  return url;
};

/** New show from a photo of a building or object. The photo is a tracing reference, not a 3D scan. */
export const createProjectFromPhoto = async (given?: { path: string; dataUrl: string }): Promise<boolean> => {
  const s = useStudio.getState();
  const pick = given ?? (await window.be.files.chooseImage());
  if (!pick) return false;
  try {
    const name = pick.path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
    const base = emptyProject(`${name} show`);
    const stored = await window.be.files.importAsset(pick.path, base.id);
    // Read the copied file (the page's security policy doesn't allow fetching inline data URLs).
    const bmp = await createImageBitmap(new Blob([(await window.be.files.readFile(stored)) as BlobPart]));
    const { width, height } = bmp;
    bmp.close();
    // Work at up to 1920 px on the long side: sharp enough to trace, light enough to animate.
    const k = Math.min(1, 1920 / Math.max(width, height));
    const cw = Math.max(64, Math.round((width * k) / 2) * 2);
    const ch = Math.max(64, Math.round((height * k) / 2) * 2);
    const asset: Asset = { id: newId("asset"), kind: "image", name: pick.path.split(/[\\/]/).pop()!, path: stored, meta: { width, height } };
    const venueBase: Venue = {
      id: newId("venue"),
      name,
      kind: "flat",
      canvas: { width: cw, height: ch },
      referenceAssetId: asset.id,
      regionOrder: [],
      regions: {},
      groups: {},
      projectorOrder: [],
      projectors: {},
    };
    const projector = newProjector(venueBase, { name: "Projector 1", width: 1920, height: 1080 });
    const venue: Venue = { ...venueBase, projectors: { [projector.id]: projector }, projectorOrder: [projector.id] };
    const comp = newComposition({ name: "Main show", width: cw, height: ch, durationSeconds: 30, venueId: venue.id });
    const h = new History(base, registry);
    h.apply([
      { type: "asset.add", args: { asset } },
      { type: "venue.add", args: { venue, makeActive: true } },
      { type: "comp.add", args: { comp, makeMain: true } },
    ]);
    s.openProject(h.project, null);
    useStudio.setState({ step: "space", dirty: true });
    usePreview.getState().set({ view: "show", zoom: "fit" });
    useTrace.getState().set({ tool: "rect", draft: [], pending: null, suggestions: null, photoOpacity: 1 });
    s.toast({ kind: "info", text: "Trace the parts you want to light. Drag a rectangle around a window to start." });
    return true;
  } catch (e) {
    s.toast({ kind: "error", text: "That photo couldn't be opened. Try a JPG or PNG.", details: String(e) });
    return false;
  }
};

/** Add a traced shape as a named region of the given kind (bound to the kind's role). */
export const addRegion = (path: PathData, kind: RegionKind): string | null => {
  const s = useStudio.getState();
  const venue = s.project ? activeVenue({ project: s.project }) : undefined;
  if (!venue) return null;
  const label = KIND_CHOICES.find((k) => k.kind === kind)?.label ?? "Part";
  const count = Object.values(venue.regions).filter((r) => r.kind === kind).length + 1;
  const region: Region = { id: newId("rgn"), name: `${label} ${count}`, kind, path, tags: [] };
  const tx = s.apply({ type: "region.add", args: { venueId: venue.id, region, bindRole: KIND_ROLE[kind] } }, { label: `Add ${label.toLowerCase()}` });
  if (!tx) return null;
  s.selectRegions([region.id]);
  return region.id;
};

export const deleteRegions = (ids: readonly string[]) => {
  const s = useStudio.getState();
  const venue = s.project ? activeVenue({ project: s.project }) : undefined;
  if (!venue || ids.length === 0) return;
  s.apply(
    ids.map((regionId) => ({ type: "region.remove", args: { venueId: venue.id, regionId } })),
    { label: ids.length > 1 ? `Remove ${ids.length} parts` : "Remove part" },
  );
  s.selectRegions([]);
};

/** Look for parts of the photo that resemble the given region; results become dashed suggestions. */
export const suggestSimilar = async (regionId: string): Promise<number> => {
  const s = useStudio.getState();
  const project = s.project;
  const venue = project ? activeVenue({ project }) : undefined;
  const region = venue?.regions[regionId];
  if (!project || !venue || !region) return 0;
  const photo = await venuePhoto(project);
  if (!photo) {
    s.toast({ kind: "info", text: "There's no photo to search. Trace the other parts by hand." });
    return 0;
  }
  const existing = venue.regionOrder.map((id) => venue.regions[id]!.path);
  const matches = await findSimilar(photo, venue.canvas, region.path, existing);
  useTrace.getState().set({
    suggestions: {
      kind: region.kind,
      baseName: KIND_CHOICES.find((k) => k.kind === region.kind)?.label ?? "Part",
      items: matches.map((m) => ({ id: newId("sug"), path: m.path, score: m.score, accepted: true })),
    },
    tool: "select",
  });
  if (matches.length === 0) s.toast({ kind: "info", text: "No similar parts found. You can trace the others by hand." });
  return matches.length;
};

export const acceptSuggestions = () => {
  const t = useTrace.getState();
  const s = useStudio.getState();
  const venue = s.project ? activeVenue({ project: s.project }) : undefined;
  if (!t.suggestions || !venue) return;
  const chosen = t.suggestions.items.filter((i) => i.accepted);
  const kind = t.suggestions.kind;
  let n = Object.values(venue.regions).filter((r) => r.kind === kind).length;
  const ops = chosen.map((c) => ({
    type: "region.add",
    args: { venueId: venue.id, region: { id: newId("rgn"), name: `${t.suggestions!.baseName} ${++n}`, kind, path: c.path, tags: ["suggested"] } satisfies Region, bindRole: KIND_ROLE[kind] },
  }));
  if (ops.length) s.apply(ops, { label: `Add ${ops.length} similar parts` });
  t.set({ suggestions: null });
  if (ops.length) s.toast({ kind: "success", text: `Added ${ops.length} ${t.suggestions.baseName.toLowerCase()}s. Drag any corner to correct it.` });
};

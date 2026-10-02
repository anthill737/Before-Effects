/** One shared FrameRenderer for the studio window, plus cached venue reference textures. */
import type { Project } from "@be/core";
import { FrameRenderer } from "@be/engine";
import { facadeBlob } from "../samples/facadeArt.ts";
import { MediaHost } from "./mediaHost.ts";
import { notifySimFrame, simStore } from "./simHost.ts";
import { useStudio } from "./store.ts";

let renderer: Promise<FrameRenderer> | null = null;
let media: MediaHost | null = null;

/** The window's media host (images and video frames), once the renderer exists. */
export const getMediaHost = (): MediaHost | null => media;
const references = new Map<string, Promise<GPUTexture>>();

export const getRenderer = (): Promise<FrameRenderer> => {
  renderer ??= FrameRenderer.create().then((r) => {
    // 3D scenes put the building photo on solid fronts; redraw when it (or physics motion) arrives.
    r.scenes.imageSource = async (assetId) => {
      const a = useStudio.getState().project?.assets[assetId];
      if (!a) return null;
      const bytes = await window.be.files.readFile(a.path);
      return createImageBitmap(new Blob([bytes as BlobPart]), { colorSpaceConversion: "none" });
    };
    r.scenes.onChange = notifySimFrame;
    media = new MediaHost(r);
    r.setMedia(media);
    r.setSimStore(simStore()).onFrameReady = notifySimFrame;
    media.project = useStudio.getState().project;
    useStudio.subscribe((s) => {
      if (media) media.project = s.project;
    });
    return r;
  });
  return renderer;
};

/** Reference image for a venue (sample art, or an imported photo by data URL). */
export const getReference = (key: string, source: () => Promise<Blob | string>): Promise<GPUTexture> => {
  let p = references.get(key);
  if (!p) {
    p = getRenderer().then(async (r) => r.loadImageTexture(await source()));
    references.set(key, p);
  }
  return p;
};

export const sampleReference = () => getReference("sample:facade", facadeBlob);

/** Surface colour for a project's active venue: its traced photo, the sample art, or none. */
export const venueReference = async (project: Project): Promise<GPUTexture | null> => {
  const venue = project.activeVenueId ? project.venues[project.activeVenueId] : undefined;
  if (!venue) return null;
  const asset = venue.referenceAssetId ? project.assets[venue.referenceAssetId] : undefined;
  if (asset) {
    try {
      return await getReference(`asset:${asset.path}`, async () => new Blob([(await window.be.files.readFile(asset.path)) as BlobPart]));
    } catch {
      return null;
    }
  }
  if (venue.id === "venue-sample") return sampleReference();
  return null;
};

/** Image URL for the venue reference shown in the Space step (HTML <img>). */
let sampleUrl: string | null = null;
export const sampleReferenceUrl = async (): Promise<string> => {
  sampleUrl ??= URL.createObjectURL(await facadeBlob());
  return sampleUrl;
};

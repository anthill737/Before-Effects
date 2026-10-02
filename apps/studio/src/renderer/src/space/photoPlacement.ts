/**
 * The building photo in the canvas: the original photo is kept as imported; a canvas-sized copy
 * with the chosen placement (fit or fill, size, position, crop — never stretched) is what tracing,
 * the venue preview, detection and photo-textured 3D parts use. Changing the placement makes a new
 * copy; traced areas stay where they are (they're the physical mapping targets).
 */
import { type Asset, DEFAULT_PLACEMENT, type Id, type Op, type PhotoPlacement, placePhoto } from "@be/core";
import { activeVenue, useStudio } from "../studio/store.ts";

/** Draw the photo into a canvas-sized PNG with the placement; transparent outside the photo. */
export const renderPlacedPhoto = async (photoPath: string, canvas: { width: number; height: number }, placement: PhotoPlacement): Promise<Uint8Array> => {
  const bmp = await createImageBitmap(new Blob([(await window.be.files.readFile(photoPath)) as BlobPart]));
  const { source, dest } = placePhoto({ width: bmp.width, height: bmp.height }, canvas, placement);
  const c = new OffscreenCanvas(canvas.width, canvas.height);
  const g = c.getContext("2d")!;
  g.imageSmoothingQuality = "high";
  g.drawImage(bmp, source.x, source.y, source.w, source.h, dest.x, dest.y, dest.w, dest.h);
  bmp.close();
  return new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
};

/** Write the placed copy beside the project's media and return its asset (new id each time it's made). */
export const makeReferenceAsset = async (projectId: Id, venueName: string, photo: Asset, canvas: { width: number; height: number }, placement: PhotoPlacement): Promise<Asset> => {
  const png = await renderPlacedPhoto(photo.path, canvas, placement);
  const dir = `${(await window.be.app.paths()).media}\\${projectId.replace(/[^\w.-]+/g, "_")}`;
  const path = `${dir}\\${venueName.replace(/[<>:"/\\|?*]+/g, "-")} - photo in ${canvas.width}x${canvas.height} ${Date.now().toString(36)}.png`;
  await window.be.files.writeBinary(path, png);
  return { id: `asset_ref_${Date.now().toString(36)}`, kind: "image", name: `${photo.name} (placed in ${canvas.width}×${canvas.height})`, path, purpose: "venue-reference", meta: { width: canvas.width, height: canvas.height } };
};

/** The operations that place the photo (a new placed copy, then the venue pointing at it). */
export const placementOps = async (changes: Partial<PhotoPlacement>): Promise<Op[] | null> => {
  const s = useStudio.getState();
  const venue = s.project ? activeVenue({ project: s.project }) : undefined;
  const photo = venue?.photo ? s.project!.assets[venue.photo.assetId] : undefined;
  if (!s.project || !venue?.photo || !photo) return null;
  const placement: PhotoPlacement = { ...venue.photo.placement, ...changes, crop: { ...venue.photo.placement.crop, ...(changes.crop ?? {}) } };
  const ref = await makeReferenceAsset(s.project.id, venue.name, photo, venue.canvas, placement);
  const old = venue.referenceAssetId ? s.project.assets[venue.referenceAssetId] : undefined;
  return [
    { type: "asset.add", args: { asset: ref } },
    { type: "venue.update", args: { venueId: venue.id, changes: { photo: { assetId: photo.id, placement }, referenceAssetId: ref.id } } },
    // The previous placed copy is replaced (undo brings it back).
    ...(old?.purpose === "venue-reference" ? [{ type: "asset.remove", args: { assetId: old.id } }] : []),
  ];
};

let pending: ReturnType<typeof setTimeout> | null = null;
/** Change how the photo sits in the canvas (debounced while a slider moves); one undo step per gesture. */
export const setPlacement = (changes: Partial<PhotoPlacement>, opts: { now?: boolean } = {}): Promise<void> =>
  new Promise((resolve) => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(
      () => {
        pending = null;
        void (async () => {
          const ops = await placementOps(changes);
          const venue = useStudio.getState().project ? activeVenue({ project: useStudio.getState().project! }) : undefined;
          if (ops && venue) useStudio.getState().apply(ops, { label: "Place the photo", coalesceKey: `placement-${venue.id}` });
          resolve();
        })();
      },
      opts.now ? 0 : 160,
    );
  });

export const resetPlacement = () => setPlacement({ ...DEFAULT_PLACEMENT }, { now: true });

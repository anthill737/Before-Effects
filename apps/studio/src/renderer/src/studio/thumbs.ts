/**
 * Small pictures of imported media for the Content list: images are scaled down from the file the
 * app uses (for a HEIC photo, its decoded copy), videos show a frame one second in. Made once per
 * file and kept for the session.
 */
import { type Asset } from "@be/core";
import { useEffect, useState } from "react";

const SIZE = 96;
const cache = new Map<string, Promise<string | null>>();

const toUrl = async (c: OffscreenCanvas) => URL.createObjectURL(await c.convertToBlob({ type: "image/png" }));

const make = async (a: Asset): Promise<string | null> => {
  if (a.kind === "image") {
    const bmp = await createImageBitmap(new Blob([(await window.be.files.readFile(a.path)) as BlobPart]));
    const k = SIZE / Math.max(bmp.width, bmp.height);
    const c = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return toUrl(c);
  }
  if (a.kind === "video" && a.meta.width && a.meta.height) {
    const fps = a.meta.frameRate ? a.meta.frameRate.num / a.meta.frameRate.den : 30;
    const last = Math.max(0, (a.meta.frameCount ?? 1) - 1);
    const f = await window.be.media.decodeFrame(a.path, Math.min(last, Math.round(fps)), fps, SIZE, a.meta.width, a.meta.height);
    if (!f) return null;
    const c = new OffscreenCanvas(f.width, f.height);
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0);
    return toUrl(c);
  }
  return null;
};

/** The thumbnail's object URL once it's ready (null while making it, or for kinds without one). */
export const useThumb = (a: Asset): string | null => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (a.missing || (a.kind !== "image" && a.kind !== "video")) return;
    let live = true;
    let p = cache.get(a.path);
    if (!p) {
      p = make(a).catch(() => null);
      cache.set(a.path, p);
    }
    void p.then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [a.path, a.kind, a.missing]);
  return url;
};

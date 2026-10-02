/**
 * HEIC/HEIF decoding in a worker thread (libheif, WebAssembly — no codecs to install, nothing
 * leaves the PC). libheif applies the file's orientation (rotation/mirror) and crop, assembles
 * tiled grids, and keeps transparency. Returns RGBA pixels of the primary image.
 */
import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
// @ts-expect-error the bundle has no type declarations for this entry point
import libheifModule from "libheif-js/libheif-wasm/libheif-bundle.mjs";

interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(out: { data: Uint8ClampedArray; width: number; height: number }, cb: (r: { data: Uint8ClampedArray } | null) => void): void;
  free?(): void;
}

const run = async () => {
  const { path } = workerData as { path: string };
  const lib = typeof libheifModule === "function" ? await (libheifModule as () => Promise<unknown>)() : libheifModule;
  const decoder = new (lib as { HeifDecoder: new () => { decode(b: Uint8Array): HeifImage[] } }).HeifDecoder();
  const images = decoder.decode(readFileSync(path));
  if (!images.length) throw new Error("the file contains no image libheif can read");
  const img = images[0]!;
  const width = img.get_width();
  const height = img.get_height();
  const data = await new Promise<Uint8ClampedArray>((resolve, reject) => {
    img.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (r) => (r ? resolve(r.data) : reject(new Error("libheif couldn't decode the image data"))));
  });
  let hasAlpha = false;
  for (let i = 3; i < data.length; i += 4)
    if (data[i]! < 255) {
      hasAlpha = true;
      break;
    }
  parentPort!.postMessage({ ok: true, width, height, hasAlpha, images: images.length, data: data.buffer }, [data.buffer as ArrayBuffer]);
};

run().catch((e: unknown) => parentPort!.postMessage({ ok: false, error: String((e as Error)?.message ?? e) }));

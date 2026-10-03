/**
 * Compresses preview frames for the disk cache off the main thread (see diskCache.ts).
 *
 * In: 8-bit pixels read back from the GPU (rows padded to `stride` bytes) holding encoded colour in
 * RGB and alpha in A. Out: a JPEG with the colour on top and, unless the frame is fully opaque,
 * the alpha as grey below it, so the image itself is opaque (no premultiplying on the way through
 * the canvas, and JPEG can carry it).
 */
interface Job {
  readonly id: number;
  readonly data: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly stride: number;
  readonly quality: number;
}

self.onmessage = async (e: MessageEvent<Job>) => {
  const { id, data, width: w, height: h, stride, quality } = e.data;
  const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);
  try {
    const src = new Uint8Array(data);
    let opaque = true;
    for (let y = 0; y < h && opaque; y++) {
      for (let i = y * stride + 3, end = y * stride + w * 4; i < end; i += 4) {
        if (src[i] !== 255) {
          opaque = false;
          break;
        }
      }
    }
    const rows = opaque ? h : h * 2;
    const out = new Uint8ClampedArray(w * rows * 4);
    const band = w * h * 4;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * stride + x * 4;
        const o = (y * w + x) * 4;
        out[o] = src[i]!;
        out[o + 1] = src[i + 1]!;
        out[o + 2] = src[i + 2]!;
        out[o + 3] = 255;
        if (!opaque) {
          const a = src[i + 3]!;
          out[band + o] = a;
          out[band + o + 1] = a;
          out[band + o + 2] = a;
          out[band + o + 3] = 255;
        }
      }
    }
    const canvas = new OffscreenCanvas(w, rows);
    canvas.getContext("2d")!.putImageData(new ImageData(out, w, rows), 0, 0);
    const bytes = await (await canvas.convertToBlob({ type: "image/jpeg", quality })).arrayBuffer();
    post({ id, bytes }, [bytes]);
  } catch (err) {
    post({ id, error: String(err) });
  }
};

/// <reference lib="webworker" />
/**
 * Computer vision for auto-align, off the editor's main thread: matching the camera to the house
 * photo, comparing camera pictures (did the phone move?) and checking projected outlines against the
 * building's edges. OpenCV.js (Apache-2.0) is loaded the first time it's needed.
 */
import cvModule from "@techstark/opencv-js";
import { type Cv, matchViews, readyCv } from "./autoMatch.ts";
import { cameraMoved, verifyOutlines, verifyProjectedPhoto } from "./verify.ts";

// A static import: the package's module object has a `then` of its own, so a dynamic import() (whose
// promise would follow that `then` forever) can't be used. The worker itself only starts when needed.
let cvP: Promise<Cv> | null = null;
const cv = () => (cvP ??= readyCv(cvModule));

type Req =
  | { id: number; type: "match"; args: Parameters<typeof matchViews> extends [unknown, ...infer R] ? R : never }
  | { id: number; type: "moved"; args: Parameters<typeof cameraMoved> extends [unknown, ...infer R] ? R : never }
  | { id: number; type: "verify"; args: Parameters<typeof verifyOutlines> extends [unknown, ...infer R] ? R : never }
  | { id: number; type: "verifyPhoto"; args: Parameters<typeof verifyProjectedPhoto> extends [unknown, ...infer R] ? R : never };

self.onmessage = async (e: MessageEvent<Req>) => {
  const r = e.data;
  try {
    const c = await cv();
    // biome-ignore lint/suspicious/noExplicitAny: argument tuples are checked by the caller
    const result =
      r.type === "match"
        ? matchViews(c, ...(r.args as [any, any, any, any]))
        : r.type === "moved"
          ? cameraMoved(c, ...(r.args as [any, any]))
          : r.type === "verifyPhoto"
            ? verifyProjectedPhoto(c, ...(r.args as [any]))
            : verifyOutlines(c, ...(r.args as [any]));
    (self as unknown as Worker).postMessage({ id: r.id, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: r.id, error: err instanceof Error ? err.message : String(err) });
  }
};

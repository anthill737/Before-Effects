/**
 * What decides how preview frames look: the project model and evaluation, the renderer, and how
 * frames are stored on disk. A fingerprint of their sources names the build that draws frames
 * ("render <hash>"); prepared frames carry it, so a packaged app and the same sources run from the
 * repository are the same build, and any change to these sources is another one.
 * (Read by scripts/package.mjs when packaging, and by the app when run from the repository.)
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const FILES = ["apps/studio/src/renderer/src/preview/diskCache.ts", "apps/studio/src/renderer/src/preview/diskCodec.worker.ts", "apps/studio/src/shared/diskFrames.ts"];

/** The fingerprint (16 hex digits) of the rendering sources under a repository root. */
export const renderHash = (root: string): string => {
  const h = createHash("sha256");
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|wgsl|js)$/.test(name)) h.update(relative(root, p).split(sep).join("/")).update(readFileSync(p));
    }
  };
  walk(join(root, "packages", "core", "src"));
  walk(join(root, "packages", "engine", "src"));
  for (const f of FILES) h.update(f).update(readFileSync(join(root, f)));
  return h.digest("hex").slice(0, 16);
};

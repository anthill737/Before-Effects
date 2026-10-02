/**
 * @be/aep — reads After Effects project files (.aep) without After Effects.
 *
 * File-format knowledge from py_aep (MIT, © 2023 Fortiche production, https://github.com/forticheprod/py-aep)
 * and aftereffects-aep-parser (MIT, © 2020 Boltframe). This is an independent TypeScript
 * implementation; it uses only DataView / TextDecoder, so it runs in the browser, Electron's
 * renderer and Node alike.
 *
 * `readAep` returns the same `AeJsonProject` shape the After Effects exporter script writes, so one
 * importer handles both routes. What the file doesn't let us read is listed in `notes`.
 */

import type { AeJsonProject } from "@be/core";
import { readProject, type ReadAepOptions } from "./project.ts";

export { AepReadError } from "./riff.ts";
export type { ReadAepOptions, AeVersion } from "./project.ts";
export { parseRifx, type Chunk } from "./riff.ts";

/**
 * Read an .aep file.
 * @throws AepReadError with a plain-language message when the bytes aren't an After Effects
 *   project, are damaged, or come from an After Effects version this reader can't handle.
 */
export function readAep(bytes: Uint8Array, options?: ReadAepOptions): AeJsonProject {
  return readProject(bytes, options);
}

/** Quick check (first bytes only) that a file looks like an .aep project. */
export function isAep(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x58 && bytes[8] === 0x45 && bytes[9] === 0x67 && bytes[10] === 0x67 && bytes[11] === 0x21;
}

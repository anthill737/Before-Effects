/** Reads .aep files directly (no After Effects needed). Loaded on demand. */
import type { AeJsonProject } from "@be/core";

export const readAepBytes = async (bytes: Uint8Array): Promise<AeJsonProject> => {
  const { readAep } = await import("@be/aep");
  return readAep(bytes);
};

/**
 * The sounds "Lightning & thunder" plays. The person's own recordings are analysed first so the
 * effect can start each at its biggest hit (a recording with silence before the crack still lands on
 * the flash); with none chosen, Before Effects makes a crack and a thunder roll and adds them to the
 * project once.
 */
import { type Asset, crackSamples, thunderSamples, wavFile } from "@be/core";
import { analyseBeats, importMediaFiles } from "./media.ts";
import { useStudio } from "./store.ts";

const MADE = {
  crack: { name: "Lightning crack - made by Before Effects.wav", make: () => crackSamples(1) },
  thunder: { name: "Thunder - made by Before Effects.wav", make: () => thunderSamples(1, { seconds: 8, closeness: 0.45 }) },
} as const;

const hasSound = (a: Asset | undefined): a is Asset => !!a && !a.missing && (a.kind === "audio" || !!a.audioPath);

/** Make sure a sound's hits are known (analysing it if needed). */
export const ensureHits = async (asset: Asset): Promise<void> => {
  if (!asset.analysis?.hits) await analyseBeats(asset);
};

/** The made crack or thunder: the one already in the project, or written and imported now. */
export const madeSound = async (kind: keyof typeof MADE): Promise<Asset | null> => {
  const { name, make } = MADE[kind];
  const have = Object.values(useStudio.getState().project?.assets ?? {}).find((a) => a.name === name && hasSound(a));
  if (have) return have;
  const path = `${(await window.be.app.paths()).cache}\\sounds\\${name}`;
  await window.be.files.writeBinary(path, wavFile(make(), 48000));
  const [asset] = await importMediaFiles([path], { quiet: true });
  return asset ?? null;
};

/**
 * Fill in the effect's two sounds before it's applied: analyse the chosen ones, make the missing
 * ones (unless that sound is switched off). Returns the settings to apply with.
 */
export const prepareLightning = async (params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const out = { ...params };
  for (const kind of ["crack", "thunder"] as const) {
    if (out[kind] === false) continue;
    const key = `${kind}Sound`;
    const chosen = typeof out[key] === "string" ? useStudio.getState().project?.assets[out[key] as string] : undefined;
    if (hasSound(chosen)) {
      await ensureHits(chosen);
      continue;
    }
    const made = await madeSound(kind);
    if (made) out[key] = made.id;
  }
  return out;
};

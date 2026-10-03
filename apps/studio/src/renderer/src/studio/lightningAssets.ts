/**
 * What "Lightning & thunder" needs before it's applied: its two sounds and the white house picture.
 * The person's own recordings are analysed first so the effect can start each at its biggest hit (a
 * recording with silence before the crack still lands on the flash); with none chosen, Before Effects
 * makes a crack and a thunder roll and adds them to the project once. For the flash, the building
 * photo is made into a bright, nearly grey picture of the house (made again when the photo changes).
 */
import { type Asset, crackSamples, thunderSamples, wavFile } from "@be/core";
import { analyseBeats, importMediaFiles } from "./media.ts";
import { activeVenue, useStudio } from "./store.ts";

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

const FLASH_NAME = "House in a lightning flash (made by Before Effects)";

/**
 * The house in a lightning flash: the placed building photo (canvas-sized), nearly grey, shadows
 * lifted and a touch cool, so the whole front reads as lit by a flash with its detail kept.
 */
export const madeFlashPicture = async (): Promise<Asset | null> => {
  const s = useStudio.getState();
  const venue = s.project ? activeVenue({ project: s.project }) : undefined;
  const photo = venue?.referenceAssetId ? s.project!.assets[venue.referenceAssetId] : undefined;
  if (!s.project || !venue || !photo || photo.missing) return null;
  const have = Object.values(s.project.assets).find((a) => a.name === FLASH_NAME && a.originalPath === photo.path && !a.missing);
  if (have) return have;
  const bmp = await createImageBitmap(new Blob([(await window.be.files.readFile(photo.path)) as BlobPart]));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d")!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]! / 255, gg = d[i + 1]! / 255, b = d[i + 2]! / 255;
    const y = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
    const lit = 0.3 + 0.7 * Math.pow(y, 0.75);
    const mix = (v: number, tint: number) => Math.min(255, Math.round(255 * (0.88 * lit * tint + 0.12 * Math.min(1, v * 1.4))));
    d[i] = mix(r, 0.95);
    d[i + 1] = mix(gg, 0.98);
    d[i + 2] = mix(b, 1.04);
  }
  g.putImageData(img, 0, 0);
  const png = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
  const dir = `${(await window.be.app.paths()).media}\\${s.project.id.replace(/[^\w.-]+/g, "_")}`;
  const path = `${dir}\\${FLASH_NAME} ${Date.now().toString(36)}.png`;
  await window.be.files.writeBinary(path, png);
  const asset: Asset = { id: `asset_flash_${Date.now().toString(36)}`, kind: "image", name: FLASH_NAME, path, originalPath: photo.path, meta: { width: c.width, height: c.height } };
  useStudio.getState().apply({ type: "asset.add", args: { asset } }, { label: "Make the white house picture", source: "system" });
  return asset;
};

/**
 * Fill in what the effect needs before it's applied: analyse the chosen sounds, make the missing
 * ones (unless that sound is switched off), and make the white house picture when the flash is the
 * house going white and none is chosen. Returns the settings to apply with.
 */
export const prepareLightning = async (params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const out = { ...params };
  const assets = () => useStudio.getState().project?.assets ?? {};
  for (const kind of ["crack", "thunder"] as const) {
    if (out[kind] === false) continue;
    const key = `${kind}Sound`;
    const chosen = typeof out[key] === "string" ? assets()[out[key] as string] : undefined;
    if (hasSound(chosen)) {
      await ensureHits(chosen);
      continue;
    }
    const made = await madeSound(kind);
    if (made) out[key] = made.id;
  }
  const pic = typeof out.flashPicture === "string" ? assets()[out.flashPicture] : undefined;
  if (out.look !== "light" && (!pic || pic.missing)) {
    const made = await madeFlashPicture();
    if (made) out.flashPicture = made.id;
  }
  return out;
};

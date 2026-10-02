/**
 * Project structure: folders, footage, compositions and their layers.
 *
 * File-format knowledge from py_aep (MIT, © 2023 Fortiche production, https://github.com/forticheprod/py-aep)
 * and aftereffects-aep-parser (MIT, © 2020 Boltframe).
 *
 * Layout used here (all big-endian):
 *   head          AE version (bit-packed word at offset 4)
 *   nnhd          project settings (bits per channel at 24)
 *   LIST:EfdG     effect parameter definitions for every effect used
 *   LIST:Fold     root folder; LIST:Item children, each with idta (type, id, label), a Utf8 name,
 *                 optional cmta comment, then per type:
 *                   folder   LIST:Sfdr with child items
 *                   comp     cdta settings, LIST:Layr per layer (top first), LIST:SecL comp markers
 *                   footage  LIST:Pin with sspc (dimensions/timing), opti (solid colour / placeholder),
 *                            LIST:Als2 > alas (JSON with the file path), LIST:StVc (sequence frames)
 *   LIST:Layr     ldta (timing, switches, source, parent), Utf8 name, LIST:tdgp property tree
 */

import type { AeJsonComp, AeJsonFolder, AeJsonFootage, AeJsonItem, AeJsonLayer, AeJsonMarker, AeJsonProject } from "@be/core";
import { Bin, ratio } from "./bin.ts";
import { readEffectDefinitions } from "./effects.ts";
import { type CompScope, type LayerScope, PropertyReader, type Scope } from "./props.ts";
import { AepReadError, type Chunk, DAMAGED, filter, filterList, find, findList, parseRifx } from "./riff.ts";

type Mut<T> = { -readonly [K in keyof T]: T[K] };

export interface ReadAepOptions {
  /** File name, reported as `projectName`. */
  readonly fileName?: string;
}

/** AE version that wrote the file, e.g. { major: 25, minor: 6, build: 101 }. */
export interface AeVersion {
  readonly major: number;
  readonly minor: number;
  readonly build: number;
}

/** Oldest After Effects this reader has been checked against (CC 2018 = 15). */
const OLDEST_CHECKED = 15;

export function readVersion(bin: Bin, root: Chunk): AeVersion | undefined {
  const head = find(root.children, "head");
  if (!head || !bin.has(head, 8)) return undefined;
  const w = bin.cu32(head, 4);
  return { major: ((w >>> 26) & 0x1f) * 8 + ((w >>> 19) & 0x07), minor: (w >>> 15) & 0x0f, build: w & 0xff };
}

const BLENDING: readonly number[] = (() => {
  // Binary transfer mode (PF_Xfer) → ExtendScript BlendingMode.
  const m: Record<number, number> = {
    0: 5212, 2: 5212, 3: 5213, 4: 5220, 5: 5216, 6: 5222, 7: 5226, 8: 5227, 9: 5228, 10: 5215, 11: 5221, 12: 5234, 13: 5236, 14: 5237, 15: 5238, 16: 5239,
    17: 5240, 18: 5241, 19: 5242, 20: 5243, 21: 5245, 22: 5244, 23: 5225, 24: 5219, 25: 5235, 26: 5233, 27: 5224, 28: 5218, 29: 5223, 30: 5217, 31: 5229,
    32: 5230, 33: 5231, 34: 5232, 35: 5246, 36: 5247, 37: 5248, 38: 5249,
  };
  const out: number[] = [];
  for (let i = 0; i < 64; i++) out.push(m[i] ?? 5212);
  return out;
})();

/** What a layer needs to know about its source item. */
interface SourceInfo {
  readonly kind: "comp" | "footage" | "folder";
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  readonly isStill: boolean;
}

interface PendingComp {
  readonly item: Mut<AeJsonComp>;
  readonly chunk: Chunk;
  readonly cdta: Chunk;
}

class ProjectReader implements Scope {
  readonly effectDefs;
  readonly items: AeJsonItem[] = [];
  readonly sources = new Map<number, SourceInfo>();
  private readonly comps: PendingComp[] = [];
  private readonly noteSet = new Set<string>();

  constructor(
    readonly bin: Bin,
    readonly root: Chunk,
    readonly aeMajor: number,
  ) {
    this.effectDefs = readEffectDefinitions(bin, root.children);
  }

  note(text: string): void {
    this.noteSet.add(text);
  }
  get notes(): string[] {
    return [...this.noteSet];
  }

  read(): void {
    const fold = findList(this.root.children, "Fold");
    if (!fold) throw new AepReadError(DAMAGED);
    this.readFolder(fold, undefined);
    for (const c of this.comps) this.readLayers(c);
  }

  private readFolder(container: Chunk, parentId: number | undefined): void {
    for (const c of container.children) {
      if (c.type === "LIST" && c.list === "Item") this.readItem(c, parentId);
    }
  }

  private readItem(chunk: Chunk, parentId: number | undefined): void {
    const b = this.bin;
    const idta = find(chunk.children, "idta");
    if (!idta) return;
    const type = b.cu16(idta, 0);
    const id = b.cu32(idta, 16);
    const label = b.cu8(idta, 58);
    const rawName = b.text(find(chunk.children, "Utf8"));
    const cmta = find(chunk.children, "cmta");
    const comment = cmta ? b.text(cmta).replace(/\r\n/g, "\n") : "";
    const base = { id, ...(parentId !== undefined ? { parentFolderId: parentId } : {}), ...(comment ? { comment } : {}), label };
    if (type === 1) {
      const folder: AeJsonFolder = { ...base, name: rawName, itemType: "FolderItem" };
      this.items.push(folder);
      this.sources.set(id, { kind: "folder", name: rawName, width: 0, height: 0, duration: 0, isStill: false });
      const sfdr = findList(chunk.children, "Sfdr");
      if (sfdr) this.readFolder(sfdr, id);
    } else if (type === 4) {
      this.readComp(chunk, base, rawName);
    } else if (type === 7) {
      this.readFootage(chunk, base, rawName);
    } else {
      this.note(`A project item of an unknown kind (${type}) wasn't read.`);
    }
  }

  // ---- compositions ----

  private readComp(chunk: Chunk, base: { id: number; parentFolderId?: number; comment?: string; label: number }, name: string): void {
    const b = this.bin;
    const cdta = find(chunk.children, "cdta");
    if (!cdta) {
      this.note(`Composition “${name}” has no settings and wasn't read.`);
      return;
    }
    const frameRate = b.cu16(cdta, 156) + b.cu16(cdta, 158) / 65536;
    const duration = ratio(b.cu32(cdta, 44), b.cu32(cdta, 48));
    const waStart = ratio(b.cu32(cdta, 28), b.cu32(cdta, 32));
    const waEndDividend = b.cu32(cdta, 36);
    const waDuration = waEndDividend === 0xffffffff ? duration - waStart : ratio(waEndDividend, b.cu32(cdta, 40)) - waStart;
    const flags = b.cu8(cdta, 139);
    const prin = (() => {
      const prinList = findList(chunk.children, "PRin");
      const p = prinList ? find(prinList.children, "prin") : undefined;
      if (!p) return undefined;
      const mn = b.cstr(p, 4, 48);
      return mn === "ADBE Escher" ? "ADBE Advanced 3d" : mn || undefined;
    })();
    const item: Mut<AeJsonComp> = {
      ...base,
      name,
      itemType: "CompItem",
      width: b.cu16(cdta, 140),
      height: b.cu16(cdta, 142),
      frameRate,
      frameDuration: frameRate ? 1 / frameRate : 0,
      duration,
      pixelAspect: ratio(b.cu32(cdta, 144), b.cu32(cdta, 148)) || 1,
      bgColor: [b.cu8(cdta, 52) / 255, b.cu8(cdta, 53) / 255, b.cu8(cdta, 54) / 255],
      workAreaStart: waStart,
      workAreaDuration: waDuration,
      displayStartTime: ratio(b.cs32(cdta, 164), b.cu32(cdta, 168)),
      motionBlur: (flags & 0x08) !== 0,
      frameBlending: (flags & 0x10) !== 0,
      ...(prin ? { renderer: prin } : {}),
      layers: [],
      markers: [],
    };
    this.items.push(item);
    this.sources.set(base.id, { kind: "comp", name, width: item.width, height: item.height, duration, isStill: false });
    this.comps.push({ item, chunk, cdta });
  }

  private readLayers(c: PendingComp): void {
    const b = this.bin;
    const layerChunks = filterList(c.chunk.children, "Layr");
    const idToIndex = new Map<number, number>();
    layerChunks.forEach((l, i) => {
      const ldta = find(l.children, "ldta");
      if (ldta) idToIndex.set(b.cu32(ldta, 0), i + 1);
    });
    const comp: CompScope = {
      timebase: b.cu32(c.cdta, 8) || Math.round(c.item.frameRate * 256 * 4) || 1,
      width: c.item.width,
      height: c.item.height,
      pixelAspect: c.item.pixelAspect ?? 1,
      idToIndex,
    };
    const layers: AeJsonLayer[] = [];
    layerChunks.forEach((l, i) => {
      try {
        const layer = this.readLayer(l, i + 1, comp, c.item.name);
        if (layer) layers.push(layer);
      } catch (e) {
        if (e instanceof AepReadError) throw e;
        this.note(`Layer ${i + 1} of “${c.item.name}” couldn't be read.`);
      }
    });
    c.item.layers = layers;

    const secl = findList(c.chunk.children, "SecL");
    const root = secl ? findList(secl.children, "tdgp") : undefined;
    if (secl && root) {
      // Composition markers live on a hidden marker layer with its own timing.
      const ldta = find(secl.children, "ldta");
      const div = ldta ? b.cu32(ldta, 108) : 0;
      const startTime = ldta ? ratio(b.cs32(ldta, 12), b.cu32(ldta, 16)) : 0;
      const stretch = ldta && div ? (b.cs32(ldta, 8) * 100) / div : 100;
      const scope: LayerScope = { comp, startTime, stretch, sourceSize: null, size: [comp.width, comp.height], is3D: false, nullLayer: false, kind: "other", hasSource: false, where: `“${c.item.name}”` };
      const reader = new PropertyReader(this, scope);
      reader.readChildren(root, "", null);
      c.item.markers = reader.markers ?? [];
    }
  }

  private readLayer(l: Chunk, index: number, comp: CompScope, compName: string): AeJsonLayer | undefined {
    const b = this.bin;
    const ldta = find(l.children, "ldta");
    if (!ldta) return undefined;
    const f0 = b.cu8(ldta, 37);
    const f1 = b.cu8(ldta, 38);
    const f2 = b.cu8(ldta, 39);
    const stretchDivisor = b.cu32(ldta, 108);
    const stretch = stretchDivisor === 0 ? 0 : (b.cs32(ldta, 8) * 100) / stretchDivisor;
    const startTime = ratio(b.cs32(ldta, 12), b.cu32(ldta, 16));
    const rawIn = ratio(b.cs32(ldta, 20), b.cu32(ldta, 24));
    const rawOut = ratio(b.cs32(ldta, 28), b.cu32(ldta, 32));
    const sourceId = b.cu32(ldta, 40);
    const layerType = b.cu8(ldta, 131);
    const parentId = b.cu32(ldta, 132);
    const source = sourceId ? this.sources.get(sourceId) : undefined;

    let kind: LayerScope["kind"] = "av";
    let layerTypeName = "AVLayer";
    let matchName = "ADBE AV Layer";
    switch (layerType) {
      case 1:
        kind = "light";
        layerTypeName = "LightLayer";
        matchName = "ADBE Light Layer";
        break;
      case 2:
        kind = "camera";
        layerTypeName = "CameraLayer";
        matchName = "ADBE Camera Layer";
        break;
      case 3:
        kind = "text";
        layerTypeName = "Layer";
        matchName = "ADBE Text Layer";
        break;
      case 4:
        kind = "shape";
        layerTypeName = "Layer";
        matchName = "ADBE Vector Layer";
        break;
      case 5:
        kind = "model";
        layerTypeName = "Layer";
        matchName = "ADBE 3D Model Layer";
        break;
      case 7:
        kind = "mesh";
        layerTypeName = "ParametricMeshLayer";
        matchName = "ADBE3D ParametricMeshLayer";
        break;
      default:
        break;
    }
    const isAV = kind !== "camera" && kind !== "light";
    const threeD = (f1 & 0x04) !== 0;
    const nullLayer = (f1 & 0x80) !== 0;
    const stored = b.text(find(l.children, "Utf8"));
    const name = stored || source?.name || b.cstr(ldta, 64, 32);
    const where = `“${compName}” › “${name}”`;

    const srcPixels = source && source.kind !== "folder" && source.width > 0 && source.height > 0 ? ([source.width, source.height] as const) : null;
    const scope: LayerScope = {
      comp,
      startTime,
      stretch,
      sourceSize: source && kind === "av" ? srcPixels : null,
      size: source && source.kind !== "folder" ? [source.width, source.height] : [comp.width, comp.height],
      is3D: threeD || !isAV,
      nullLayer,
      kind,
      hasSource: !!source,
      where,
    };

    const root = findList(l.children, "tdgp");
    const reader = new PropertyReader(this, scope);
    const read = root ? reader.readLayer(root) : { properties: [], markers: [], timeRemapEnabled: false };

    // In/out points, clamped to the source's extent like AE reports them.
    const sf = stretch !== 0 ? stretch / 100 : 1;
    // A reversed layer starts 1/3000 s per 100 % of stretch before its nominal start (as AE reports it).
    const reverseOffset = sf < 0 ? Math.abs(sf) / 3000 : 0;
    let inPoint = startTime + rawIn * sf - reverseOffset;
    let outPoint = startTime + rawOut * sf - reverseOffset;
    if (source && source.kind !== "folder" && !(source.kind === "footage" && source.isStill) && !read.timeRemapEnabled && source.duration > 0 && stretch >= 0) {
      inPoint = Math.max(inPoint, startTime);
      outPoint = Math.min(outPoint, startTime + source.duration * sf);
    }

    const layer: Mut<AeJsonLayer> = {
      index,
      name,
      layerType: layerTypeName,
      matchName,
      startTime,
      inPoint,
      outPoint,
      stretch,
      enabled: (f2 & 0x01) !== 0,
      solo: (f1 & 0x08) !== 0,
      locked: (f2 & 0x20) !== 0,
      shy: (f2 & 0x40) !== 0,
      label: b.cu8(ldta, 61),
    };
    const cmta = find(l.children, "cmta");
    if (cmta) {
      const comment = b.text(cmta).replace(/\r\n/g, "\n");
      if (comment) layer.comment = comment;
    }
    if (sourceId && source && kind === "av") layer.sourceId = sourceId;
    layer.parentIndex = parentId ? (comp.idToIndex.get(parentId) ?? null) : null;
    layer.adjustmentLayer = (f1 & 0x02) !== 0;
    layer.nullLayer = nullLayer;
    if (isAV) {
      layer.audioEnabled = (f2 & 0x02) !== 0;
      const blend = BLENDING[b.cu8(ldta, 99)] ?? 5212;
      layer.blendingMode = blend === 5213 && (b.cu8(ldta, 103) & 0x02) !== 0 ? 5214 : blend;
      layer.threeDLayer = threeD;
      layer.guideLayer = (f0 & 0x02) !== 0;
      const tm = b.cu8(ldta, 107);
      layer.trackMatteType = tm <= 4 ? 5012 + tm : 5012;
      if (layer.trackMatteType !== 5012) {
        const matteId = b.has(ldta, 164) ? b.cu32(ldta, 160) : 0;
        layer.trackMatteLayerIndex = matteId ? (comp.idToIndex.get(matteId) ?? null) : index > 1 ? index - 1 : null;
      }
      layer.timeRemapEnabled = read.timeRemapEnabled;
      layer.motionBlur = (f2 & 0x08) !== 0;
      layer.collapseTransformation = (f2 & 0x80) !== 0;
      layer.frameBlending = (f2 & 0x10) !== 0;
    }
    if (kind === "light") layer.lightType = 4412 + b.cu8(ldta, 139);
    layer.properties = read.properties;
    layer.markers = read.markers;
    return layer;
  }

  // ---- footage ----

  private readFootage(chunk: Chunk, base: { id: number; parentFolderId?: number; comment?: string; label: number }, rawName: string): void {
    const b = this.bin;
    const pins = filterList(chunk.children, "Pin ");
    const pin = pins[0];
    const sspc = pin ? find(pin.children, "sspc") : undefined;
    const opti = pin ? find(pin.children, "opti") : undefined;
    if (!pin || !sspc) {
      const item: AeJsonFootage = { ...base, name: rawName, itemType: "FootageItem" };
      this.items.push(item);
      this.note(`Footage “${rawName || base.id}” has no source settings.`);
      return;
    }
    const width = b.cu16(sspc, 32);
    const height = b.cu16(sspc, 36);
    const srcDuration = ratio(b.cu32(sspc, 38), b.cu32(sspc, 42));
    const native = b.cu32(sspc, 56) + b.cu16(sspc, 60) / 65536;
    const conform = b.cu16(sspc, 148) + b.cu16(sspc, 150) / 65536;
    const pulldown = b.cu8(sspc, 147);
    const loop = b.cu32(sspc, 126) || 1;
    const duration = srcDuration * (conform !== 0 ? native / conform : 1) * loop;
    const frameRate = (conform !== 0 ? conform : native) * (pulldown !== 0 ? 0.8 : 1);
    const parDivisor = b.cu32(sspc, 140);
    const pixelAspect = parDivisor ? b.cu32(sspc, 136) / parDivisor : 1;
    // With "use proxy" on, AE reports the proxy's audio.
    const idta = find(chunk.children, "idta");
    const proxySspc = idta && (b.cu8(idta, 22) & 1) && pins[1] ? find(pins[1].children, "sspc") : undefined;
    const audioSspc = proxySspc ?? sspc;
    const hasAudio = b.has(audioSspc, 168) && b.cf64(audioSspc, 160) > 0;
    const isStill = srcDuration === 0;
    const hasAlpha = b.cu8(sspc, 73) !== 3;

    const asset = opti ? b.cstr(opti, 0, 4) : "";
    const assetInt = opti ? b.cu16(opti, 4) : 0;
    let sourceType: string;
    let name = rawName;
    const mainSource: { sourceType?: string; color?: number[]; file?: string | null; isStill?: boolean; hasAlpha?: boolean; loop?: number } = {};
    if (opti && asset === "" && assetInt === 2) {
      sourceType = "PlaceholderSource";
      name = b.cstr(opti, 10, 256) || rawName;
    } else if (opti && asset.startsWith("Soli")) {
      sourceType = "SolidSource";
      name = b.cstr(opti, 26, 256) || rawName;
      mainSource.color = [b.cf32(opti, 14), b.cf32(opti, 18), b.cf32(opti, 22)];
    } else {
      sourceType = "FileSource";
      const file = filePath(b, pin, sspc, opti);
      mainSource.file = file ?? null;
      if (!name) name = fileDisplayName(b, pin, sspc, opti, file, srcDuration);
    }
    mainSource.sourceType = sourceType;
    mainSource.isStill = isStill;
    mainSource.hasAlpha = hasAlpha;
    mainSource.loop = loop;
    const item: AeJsonFootage = {
      ...base,
      name,
      itemType: "FootageItem",
      width,
      height,
      duration,
      frameRate,
      pixelAspect,
      hasAudio,
      hasVideo: width > 0 && height > 0,
      footageMissing: b.cu8(sspc, 115) !== 0,
      mainSource,
    };
    this.items.push(item);
    this.sources.set(base.id, { kind: "footage", name, width, height, duration, isStill });
  }
}

/** Absolute path of a file source (`LIST:Als2 > alas` JSON, plus the first frame of a sequence). */
function filePath(b: Bin, pin: Chunk, sspc: Chunk, opti: Chunk | undefined): string | undefined {
  const als2 = findList(pin.children, "Als2");
  const alas = als2 ? find(als2.children, "alas") : undefined;
  let full: string | undefined;
  if (alas) {
    try {
      const data = JSON.parse(b.text(alas)) as { fullpath?: unknown };
      if (typeof data.fullpath === "string") full = data.fullpath;
    } catch {
      full = undefined;
    }
  }
  if (full === undefined) return undefined;
  const stvc = findList(pin.children, "StVc");
  const frames = stvc ? filter(stvc.children, "Utf8").map((u) => b.text(u)) : [];
  let frame = frames[0];
  if (!frame) {
    // Older files list no frames; the first one is prefix + padded start frame + extension.
    const pad = b.cu32(sspc, 180);
    const start = b.cu32(sspc, 172);
    if (pad > 0 && pad < 32 && start !== 0xffffffff) {
      const kids = pin.children;
      const optiAt = opti ? kids.indexOf(opti) : -1;
      const before = kids.slice(0, optiAt < 0 ? kids.length : optiAt).filter((c) => c.type === "Utf8");
      if (before.length >= 2) {
        const prefix = b.text(before[before.length - 2]);
        const ext = b.text(before[before.length - 1]);
        if (prefix || ext) frame = `${prefix}${String(start).padStart(pad, "0")}${ext}`;
      }
    }
  }
  if (frame) {
    const sep = full.includes("\\") ? "\\" : "/";
    return full.endsWith(sep) ? full + frame : full + sep + frame;
  }
  return full;
}

/** The name AE shows for a file footage item that was never renamed. */
function fileDisplayName(b: Bin, pin: Chunk, sspc: Chunk, opti: Chunk | undefined, file: string | undefined, srcDuration: number): string {
  const als2 = findList(pin.children, "Als2");
  const alas = als2 ? find(als2.children, "alas") : undefined;
  let isFolder = false;
  if (alas) {
    try {
      isFolder = !!(JSON.parse(b.text(alas)) as { target_is_folder?: unknown }).target_is_folder;
    } catch {
      isFolder = false;
    }
  }
  if (isFolder && srcDuration !== 0) {
    const start = b.cu32(sspc, 172);
    const end = b.cu32(sspc, 176);
    const pad = b.cu32(sspc, 180);
    // Prefix and extension are the two Utf8 chunks just before opti.
    const kids = pin.children;
    const optiAt = opti ? kids.indexOf(opti) : -1;
    const before = kids.slice(0, optiAt < 0 ? kids.length : optiAt).filter((c) => c.type === "Utf8");
    if (before.length >= 2 && start !== 0xffffffff && end !== 0xffffffff) {
      const prefix = b.text(before[before.length - 2]);
      const ext = b.text(before[before.length - 1]);
      if (prefix || ext) return `${prefix}[${String(start).padStart(pad, "0")}-${String(end).padStart(pad, "0")}]${ext}`;
    }
  }
  const base = (file ?? "").split(/[\\/]/).pop() ?? "";
  let layerName = "";
  if (opti) {
    const asset = b.cstr(opti, 0, 4);
    if (asset === "8BPS" && b.has(opti, 345)) layerName = b.str(opti.start + 344, opti.end);
    else if (asset === "TEXT") layerName = b.cstr(opti, 68, 256);
  }
  return layerName ? `${layerName}/${base}` : base;
}

export function readProject(bytes: Uint8Array, options: ReadAepOptions = {}): AeJsonProject {
  const root = parseRifx(bytes);
  const bin = new Bin(bytes);
  const version = readVersion(bin, root);
  if (!version) throw new AepReadError(DAMAGED);
  const reader = new ProjectReader(bin, root, version.major);
  try {
    reader.read();
  } catch (e) {
    if (e instanceof AepReadError) throw e;
    if (version.major < OLDEST_CHECKED) throw new AepReadError(oldVersionMessage(version), { cause: e });
    throw new AepReadError(DAMAGED, { cause: e });
  }
  const nnhd = find(root.children, "nnhd");
  const bpc = nnhd ? bin.cu8(nnhd, 24) : 0;
  const notes = reader.notes;
  if (version.major < OLDEST_CHECKED) notes.unshift(`This project was saved by an old After Effects (${aeName(version.major)}); some settings may not have been read correctly.`);
  return {
    ...(options.fileName ? { projectName: options.fileName } : {}),
    bitsPerChannel: bpc === 1 ? 16 : bpc === 2 ? 32 : 8,
    items: reader.items,
    exporter: { name: "Before Effects .aep reader", version: "1", aeVersion: `${version.major}.${version.minor}` },
    ...(notes.length ? { notes } : {}),
  };
}

function aeName(major: number): string {
  if (major >= 22) return `After Effects ${major + 2000}`;
  const cc: Record<number, string> = { 13: "CC 2015", 14: "CC 2017", 15: "CC 2018", 16: "CC 2019", 17: "2020", 18: "2021" };
  return `After Effects ${cc[major] ?? major}`;
}

function oldVersionMessage(v: AeVersion): string {
  return `This project was saved by an old version of After Effects (${aeName(v.major)}) that can't be read. Open it in a newer After Effects and save it again, or export it with the Before Effects exporter script.`;
}

/**
 * Runs BeforeEffectsExport.jsx against a simulated After Effects scripting object model built
 * from a real After Effects ground-truth export (py_aep sample "versions/ae2026/complete", MIT),
 * then checks that the export reproduces the project and imports into Before Effects.
 *
 * This checks the exporter's traversal and field mapping. It can't prove behaviour inside real
 * After Effects (not installed on the build machine); see docs/06-after-effects-import.md.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { type AeJsonComp, type AeJsonLayer, type AeJsonProject, type AeJsonProperty, importAeProject } from "../../../packages/core/src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const truth = JSON.parse(readFileSync(join(here, "fixtures", "complete-ae2026.json"), "utf8")) as AeJsonProject;
const script = readFileSync(join(here, "..", "BeforeEffectsExport.jsx"), "utf8");

const PropertyType = { PROPERTY: 6212, INDEXED_GROUP: 6213, NAMED_GROUP: 6214 };
const PropertyValueType = { NO_VALUE: 6412, ThreeD_SPATIAL: 6413, ThreeD: 6414, TwoD_SPATIAL: 6415, TwoD: 6416, OneD: 6417, COLOR: 6418, CUSTOM_VALUE: 6419, MARKER: 6420, LAYER_INDEX: 6421, MASK_INDEX: 6422, SHAPE: 6423, TEXT_DOCUMENT: 6424 };

/** Build a fake After Effects DOM (classes the script checks with instanceof) from AE JSON. */
const buildDom = (p: AeJsonProject) => {
  class Item {
    id = 0;
    name = "";
    comment = "";
    label = 0;
    parentFolder: unknown = null;
  }
  class FolderItem extends Item {}
  class FootageItem extends Item {
    mainSource: unknown;
  }
  class CompItem extends Item {
    layersArr: unknown[] = [];
    get numLayers() {
      return this.layersArr.length;
    }
    layer(i: number) {
      return this.layersArr[i - 1];
    }
    markerProperty = { numKeys: 0 };
  }
  class SolidSource {}
  class FileSource {}
  class PlaceholderSource {}
  class Layer {}
  class AVLayer extends Layer {}
  class TextLayer extends AVLayer {}
  class ShapeLayer extends AVLayer {}
  class CameraLayer extends Layer {}
  class LightLayer extends Layer {}

  const prop = (j: AeJsonProperty): object => {
    const isGroup = (j.propertyType ?? "Property") !== "Property" || !!j.properties;
    if (isGroup) {
      const kids = (j.properties ?? []).map(prop);
      return {
        matchName: j.matchName,
        name: j.name ?? j.matchName,
        propertyType: j.propertyType === "IndexedGroup" ? PropertyType.INDEXED_GROUP : PropertyType.NAMED_GROUP,
        canSetEnabled: j.enabled !== undefined,
        enabled: j.enabled,
        maskMode: j.maskMode,
        inverted: j.inverted,
        numProperties: kids.length,
        property: (i: number | string) => (typeof i === "number" ? kids[i - 1] : kids.find((k) => (k as { matchName: string }).matchName === i)),
      };
    }
    const keys = j.keyframes ?? [];
    const vt = j.propertyValueType ?? PropertyValueType.NO_VALUE;
    return {
      matchName: j.matchName,
      name: j.name ?? j.matchName,
      propertyType: PropertyType.PROPERTY,
      propertyValueType: vt,
      value: j.value,
      canSetEnabled: false,
      canSetExpression: true,
      expression: j.expression ?? "",
      expressionEnabled: j.expressionEnabled ?? false,
      isSpatial: vt === PropertyValueType.ThreeD_SPATIAL || vt === PropertyValueType.TwoD_SPATIAL,
      isSeparationLeader: j.matchName === "ADBE Position",
      dimensionsSeparated: !!j.dimensionsSeparated,
      isSeparationFollower: !!j.isSeparationFollower,
      numKeys: keys.length,
      keyTime: (k: number) => keys[k - 1]!.time,
      keyValue: (k: number) => keys[k - 1]!.value,
      keyInInterpolationType: (k: number) => keys[k - 1]!.inInterpolationType,
      keyOutInterpolationType: (k: number) => keys[k - 1]!.outInterpolationType,
      keyInTemporalEase: (k: number) => keys[k - 1]!.inTemporalEase ?? [],
      keyOutTemporalEase: (k: number) => keys[k - 1]!.outTemporalEase ?? [],
      keyTemporalContinuous: (k: number) => !!keys[k - 1]!.temporalContinuous,
      keyTemporalAutoBezier: (k: number) => !!keys[k - 1]!.temporalAutoBezier,
      keyInSpatialTangent: (k: number) => keys[k - 1]!.inSpatialTangent ?? [0, 0, 0],
      keyOutSpatialTangent: (k: number) => keys[k - 1]!.outSpatialTangent ?? [0, 0, 0],
      keySpatialContinuous: (k: number) => !!keys[k - 1]!.spatialContinuous,
      keySpatialAutoBezier: (k: number) => !!keys[k - 1]!.spatialAutoBezier,
      keyRoving: (k: number) => !!keys[k - 1]!.roving,
    };
  };

  const byId = new Map<number, Item>();
  const root = new FolderItem();
  const items: Item[] = p.items.map((j) => {
    const it = j.itemType === "FolderItem" ? new FolderItem() : j.itemType === "CompItem" ? new CompItem() : new FootageItem();
    Object.assign(it, { ...j, layers: undefined });
    byId.set(j.id, it);
    if (j.itemType === "FootageItem") {
      const ms = j.mainSource ?? {};
      const src = ms.sourceType === "SolidSource" ? new SolidSource() : ms.sourceType === "FileSource" ? new FileSource() : new PlaceholderSource();
      Object.assign(src, { color: ms.color, isStill: ms.isStill, hasAlpha: ms.hasAlpha, loop: ms.loop, file: ms.file ? { fsName: ms.file } : null });
      (it as FootageItem).mainSource = src;
    }
    return it;
  });
  for (const j of p.items) byId.get(j.id)!.parentFolder = j.parentFolderId ? byId.get(j.parentFolderId) : root;
  for (const j of p.items) {
    if (j.itemType !== "CompItem") continue;
    const comp = byId.get(j.id) as CompItem;
    const layers = (j as AeJsonComp).layers.map((l: AeJsonLayer) => {
      const L = l.matchName === "ADBE Camera Layer" ? new CameraLayer() : l.matchName === "ADBE Light Layer" ? new LightLayer() : l.matchName === "ADBE Text Layer" ? new TextLayer() : l.matchName === "ADBE Vector Layer" ? new ShapeLayer() : new AVLayer();
      const props = (l.properties ?? []).map(prop);
      Object.assign(L, { ...l, properties: undefined, parentIndex: undefined, sourceId: undefined, source: l.sourceId != null ? byId.get(l.sourceId) : null, numProperties: props.length, property: (i: number | string) => (typeof i === "number" ? props[i - 1] : props.find((k) => (k as { matchName: string }).matchName === i) ?? null) });
      return L;
    });
    (j as AeJsonComp).layers.forEach((l, i) => Object.assign(layers[i]!, { parent: l.parentIndex ? layers[l.parentIndex - 1] : null }));
    comp.layersArr = layers;
  }
  let written = "";
  let alerted = "";
  const sandbox = {
    app: {
      version: "26.0x45",
      project: { numItems: items.length, item: (i: number) => items[i - 1], rootFolder: root, file: { name: "complete.aep", parent: { fsName: "C:\\Shows" } }, bitsPerChannel: p.bitsPerChannel ?? 8 },
      beginSuppressDialogs: () => undefined,
      endSuppressDialogs: () => undefined,
    },
    File: class {
      fsName: string;
      encoding = "";
      lineFeed = "";
      constructor(path: string) {
        this.fsName = path;
      }
      open() {
        return true;
      }
      write(s: string) {
        written += s;
      }
      close() {}
      static saveDialog() {
        return null;
      }
    },
    alert: (s: string) => (alerted = s),
    PropertyType,
    PropertyValueType,
    FolderItem,
    FootageItem,
    CompItem,
    SolidSource,
    FileSource,
    PlaceholderSource,
    AVLayer,
    TextLayer,
    ShapeLayer,
    CameraLayer,
    LightLayer,
  };
  return { sandbox, output: () => written, message: () => alerted };
};

describe("After Effects exporter (BeforeEffectsExport.jsx)", () => {
  const dom = buildDom(truth);
  runInNewContext(script, dom.sandbox);
  const exported = JSON.parse(dom.output()) as AeJsonProject;

  it("writes every item, composition and layer with After Effects' own field names", () => {
    expect(dom.message()).toMatch(/Exported 6 composition\(s\) and 33 layer\(s\)/);
    expect(exported.exporter?.name).toBe("Before Effects exporter");
    expect(exported.items.map((i) => [i.id, i.itemType, i.name])).toEqual(truth.items.map((i) => [i.id, i.itemType, i.name]));
    const comps = (x: AeJsonProject) => x.items.filter((i): i is AeJsonComp => i.itemType === "CompItem");
    for (const [a, b] of comps(exported).map((c, i) => [c, comps(truth)[i]!] as const)) {
      expect([a.width, a.height, a.frameRate, a.duration]).toEqual([b.width, b.height, b.frameRate, b.duration]);
      expect(a.layers.map((l) => [l.index, l.name, l.matchName, l.sourceId ?? null, l.parentIndex ?? null, l.inPoint, l.outPoint, l.startTime, l.stretch, l.blendingMode])).toEqual(
        b.layers.map((l) => [l.index, l.name, l.matchName, l.sourceId ?? null, l.parentIndex ?? null, l.inPoint, l.outPoint, l.startTime, l.stretch, l.blendingMode]),
      );
    }
  });

  it("keeps property trees, keyframes, masks, text and media paths", () => {
    const flat = (x: AeJsonProject) => {
      const out: string[] = [];
      const walk = (p: AeJsonProperty, path: string) => {
        out.push(`${path}/${p.matchName}:${p.keyframes?.length ?? 0}:${JSON.stringify(p.keyframes?.map((k) => [k.time, k.value, k.inInterpolationType, k.outInterpolationType]) ?? null)}`);
        for (const c of p.properties ?? []) walk(c, `${path}/${p.matchName}`);
      };
      for (const it of x.items) if (it.itemType === "CompItem") for (const l of it.layers) for (const p of l.properties ?? []) if (p.matchName !== "ADBE Marker") walk(p, `${it.name}/${l.name}`);
      return out;
    };
    expect(flat(exported)).toEqual(flat(truth));
    const text = JSON.stringify(exported);
    expect(text).toContain("Hello projection");
    expect(text).toContain('"vertices":[[100,100],[400,100],[400,300],[100,300]]');
    expect(text).toContain("C:\\\\Footage\\\\mov_480.mov");
  });

  it("imports into Before Effects with text, masks and media restored", () => {
    const { project, mainCompId, report } = importAeProject(exported, { route: "after-effects-exporter" });
    const main = project.compositions[mainCompId!]!;
    const byName = (n: string) => Object.values(main.layers).find((l) => l.name === n)!;
    const text = byName("Text_Styled").source;
    expect(text.kind === "text" && text.doc.text).toBe("Hello projection");
    expect(text.kind === "text" && [text.doc.font, text.doc.weight, text.doc.align]).toEqual(["Arial", 700, "center"]);
    const masked = byName("Masked_Layer");
    expect(masked.masks.length).toBe(2);
    expect(masked.masks[0]!.source.kind === "path" && masked.masks[0]!.source.path.value.slice(0, 4)).toEqual([1, 4, 100, 100]);
    expect(project.assets["asset_ae8"]?.path ?? Object.values(project.assets).find((a) => a.name === "mov_480.mov")?.path).toBe("C:\\Footage\\mov_480.mov");
    expect(report.notes.some((n) => n.level === "missing" && /mask's outline/.test(n.text))).toBe(false);
    expect(report.counts).toMatchObject({ compositions: 6, layers: 33, masks: 2, effects: 7, expressions: 4 });
  });
});

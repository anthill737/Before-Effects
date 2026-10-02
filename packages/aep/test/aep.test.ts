/**
 * @be/aep — reads real After Effects projects and checks them against After Effects' own export of
 * the same projects (fixtures/*.json, trimmed) and against py_aep for paths and text documents,
 * which After Effects' export doesn't include. Fixtures: see fixtures/README.md.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AeJsonComp, AeJsonFootage, AeJsonLayer, AeJsonProject, AeJsonProperty, AeJsonShape, AeJsonTextDocument } from "@be/core";
import { describe, expect, it } from "vitest";
import { AepReadError, isAep, readAep } from "../src/index.ts";
import { compareProject, getStats, resetStats, setFile } from "./ground-truth.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith(".aep")) out.push(relative(FIXTURES, p).replace(/\\/g, "/"));
  }
  return out;
}

const bytes = (rel: string) => new Uint8Array(readFileSync(join(FIXTURES, rel)));
const cache = new Map<string, AeJsonProject>();
const project = (rel: string): AeJsonProject => {
  let p = cache.get(rel);
  if (!p) cache.set(rel, (p = readAep(bytes(rel), { fileName: rel.split("/").pop() })));
  return p;
};
const groundTruth = (rel: string) => JSON.parse(readFileSync(join(FIXTURES, rel.replace(/\.aep$/, ".json")), "utf8"));

const comp = (p: AeJsonProject, name: string): AeJsonComp => {
  const c = p.items.find((i): i is AeJsonComp => i.itemType === "CompItem" && i.name === name);
  if (!c) throw new Error(`no comp ${name}`);
  return c;
};
const layer = (c: AeJsonComp, name: string): AeJsonLayer => {
  const l = c.layers.find((x) => x.name === name);
  if (!l) throw new Error(`no layer ${name}`);
  return l;
};
/** Property at a path of match names (first match at each level). */
const prop = (owner: { properties?: readonly AeJsonProperty[] }, ...path: string[]): AeJsonProperty => {
  let node: { properties?: readonly AeJsonProperty[] } = owner;
  let found: AeJsonProperty | undefined;
  for (const mn of path) {
    found = node.properties?.find((p) => p.matchName === mn);
    if (!found) throw new Error(`no property ${path.join(" › ")}`);
    node = found;
  }
  return found!;
};
const near = (a: unknown, b: unknown, eps = 1e-3) => expect(JSON.stringify(round(a, eps))).toBe(JSON.stringify(round(b, eps)));
const round = (v: unknown, eps: number): unknown => (typeof v === "number" ? Math.round(v / eps) * eps + 0 : Array.isArray(v) ? v.map((x) => round(x, eps)) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, round(x, eps)])) : v);

const files = walk(FIXTURES).sort();
const VERSIONS = ["ae2018", "ae2022", "ae2023", "ae2024", "ae2025", "ae2026"];

describe("fixtures", () => {
  it("has the fixture set", () => {
    expect(files.length).toBeGreaterThanOrEqual(40);
    for (const v of VERSIONS) expect(files).toContain(`versions/${v}/complete.aep`);
  });
});

describe("matches After Effects' own export of each fixture", () => {
  it.each(files.filter((f) => statSync(join(FIXTURES, f.replace(/\.aep$/, ".json")), { throwIfNoEntry: false })))("%s", (rel) => {
    resetStats(50);
    setFile(rel);
    compareProject(project(rel), groundTruth(rel));
    const mismatches: string[] = [];
    let compared = 0;
    for (const [field, s] of getStats()) {
      compared += s.total;
      // Extra defaults we report that this AE didn't (newer camera options) are harmless.
      if (field === "prop.extra(ours only)") continue;
      if (s.ok !== s.total) mismatches.push(`${field}: ${s.total - s.ok}/${s.total}\n    ${s.examples.join("\n    ")}`);
    }
    expect(compared).toBeGreaterThan(5);
    expect(mismatches).toEqual([]);
  });
});

describe.each(VERSIONS)("complete project saved by %s", (v) => {
  const rel = `versions/${v}/complete.aep`;
  const gt = groundTruth(rel);

  it("reads every item", () => {
    const p = project(rel);
    expect(p.items.length).toBe(gt.items.length);
    expect(p.items.filter((i) => i.itemType === "CompItem").map((i) => i.name).sort()).toEqual(["DropFrame_Comp", "HighFPS_Comp", "Main_Comp", "NonSquarePAR_Comp", "Pre_Comp", "Small_Comp"]);
    expect(p.items.filter((i) => i.itemType === "FootageItem").length).toBe(24);
    expect(p.bitsPerChannel).toBe(gt.bitsPerChannel);
    expect(p.exporter?.aeVersion?.split(".")[0]).toBe(String({ ae2018: 15, ae2022: 22, ae2023: 23, ae2024: 24, ae2025: 25, ae2026: 26 }[v]));
  });

  it("reads the main composition and its layers in stack order", () => {
    const main = comp(project(rel), "Main_Comp");
    const g = gt.items.find((i: { name: string }) => i.name === "Main_Comp");
    expect(main.layers.map((l) => l.name)).toEqual(g.layers.map((l: { name: string }) => l.name));
    expect(main.layers.length).toBe(27);
    expect(main.width).toBe(1920);
    expect(main.frameRate).toBe(24);
    expect(main.workAreaStart).toBe(2);
    expect(main.workAreaDuration).toBe(20);
    near(main.bgColor, [0.10196, 0.14902, 0.2]);
    expect(main.markers?.map((m) => [m.time, m.duration, m.comment])).toEqual([
      [0, 2, "Start"],
      [10, 0, "Middle"],
      [25, 0, "End"],
    ]);
    expect(main.markers?.map((m) => m.label)).toEqual(g.markers.map((m: { label: number }) => m.label));
  });

  it("reads layer kinds, sources, parents and switches", () => {
    const main = comp(project(rel), "Main_Comp");
    expect(layer(main, "Shape_Ellipse").parentIndex).toBe(22);
    expect(layer(main, "Shape_Rectangle").parentIndex).toBe(22);
    expect(layer(main, "Null_Controller").nullLayer).toBe(true);
    expect(layer(main, "Adjustment").adjustmentLayer).toBe(true);
    expect(layer(main, "Guide").guideLayer).toBe(true);
    expect(layer(main, "Solid_3D").threeDLayer).toBe(true);
    expect(layer(main, "Solid_ShyLocked")).toMatchObject({ shy: true, locked: true });
    expect(layer(main, "Text_Simple")).toMatchObject({ matchName: "ADBE Text Layer", layerType: "Layer" });
    expect(layer(main, "Shape_Star")).toMatchObject({ matchName: "ADBE Vector Layer", layerType: "Layer" });
    expect(layer(main, "Camera")).toMatchObject({ matchName: "ADBE Camera Layer", layerType: "CameraLayer" });
    expect(["Light_Ambient", "Light_Spot", "Light_Point"].map((n) => layer(main, n).lightType)).toEqual([4415, 4413, 4414]);
    const pre = comp(project(rel), "Pre_Comp");
    expect(layer(main, "Nested_Precomp").sourceId).toBe(pre.id);
    const placeholder = layer(main, "Placeholder_Layer");
    expect(placeholder).toMatchObject({ startTime: 5, stretch: 150 });
    near(placeholder.outPoint, 455);
    const video = project(rel).items.find((i): i is AeJsonFootage => i.id === layer(main, "Video_Footage").sourceId);
    expect(video?.mainSource?.sourceType).toBe("FileSource");
    expect(video?.mainSource?.file).toMatch(/mov_480\.mov$/);
    expect(video?.hasAudio).toBe(true);
    // A track matte: AE 2023+ names the matte layer, earlier versions use the layer above.
    const target = layer(main, "TrackMatte_Target");
    expect(target.trackMatteType).toBe(5013);
    expect(target.trackMatteLayerIndex).toBe(Number(v.slice(2)) >= 2023 ? layer(main, "TrackMatte_Alpha").index : target.index - 1);
  });

  it("reads keyframes the way AE reports them", () => {
    const L = layer(comp(project(rel), "Main_Comp"), "Keyframe_Demo");
    const pos = prop(L, "ADBE Transform Group", "ADBE Position");
    expect(pos.keyframes?.map((k) => k.time)).toEqual([0, 1, 2, 3, 4]);
    near(pos.keyframes?.map((k) => k.value), [
      [100, 540, 0],
      [960, 100, 0],
      [1820, 540, 0],
      [960, 980, 0],
      [100, 540, 0],
    ]);
    const scale = prop(L, "ADBE Transform Group", "ADBE Scale");
    near(scale.keyframes?.[1]?.value, [150, 150, 100]);
    near(scale.keyframes?.[1]?.outTemporalEase, [
      { speed: -25, influence: 16.6667 },
      { speed: -25, influence: 16.6667 },
      { speed: 0, influence: 16.6667 },
    ]);
    const rot = prop(L, "ADBE Transform Group", "ADBE Rotate Z");
    expect(rot.keyframes?.every((k) => k.temporalAutoBezier && k.temporalContinuous)).toBe(true);
    near(rot.keyframes?.[1]?.inTemporalEase, [{ speed: 90, influence: 16.6667 }]);
    const opacity = prop(L, "ADBE Transform Group", "ADBE Opacity");
    expect(opacity.keyframes?.map((k) => k.inInterpolationType)).toEqual([6612, 6614, 6612]);
  });

  it("reads expressions", () => {
    const L = layer(comp(project(rel), "Main_Comp"), "Expression_Demo");
    expect(prop(L, "ADBE Transform Group", "ADBE Position")).toMatchObject({ expression: "wiggle(2, 50)", expressionEnabled: true });
    expect(prop(L, "ADBE Transform Group", "ADBE Scale").expressionEnabled).toBe(false);
  });

  it("reads masks (paths checked against py_aep)", () => {
    const L = layer(comp(project(rel), "Main_Comp"), "Masked_Layer");
    const masks = prop(L, "ADBE Mask Parade").properties ?? [];
    expect(masks.map((m) => [m.name, m.maskMode, m.inverted])).toEqual([
      ["Rect_Mask", 6813, false],
      ["Ellipse_Mask", 6814, false],
    ]);
    near(prop(masks[0]!, "ADBE Mask Shape").value, { closed: true, vertices: [[200, 200], [800, 200], [800, 600], [200, 600]], inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]] });
    near(prop(masks[1]!, "ADBE Mask Shape").value, {
      closed: true,
      vertices: [[500, 300], [700, 400], [500, 500], [300, 400]],
      inTangents: [[110, 0], [0, -55], [-110, 0], [0, 55]],
      outTangents: [[-110, 0], [0, 55], [110, 0], [0, -55]],
    });
    near(prop(masks[0]!, "ADBE Mask Feather").value, [20, 20]);
    near(prop(masks[0]!, "ADBE Mask Opacity").value, 80);
  });

  it("reads text documents (checked against py_aep)", () => {
    const main = comp(project(rel), "Main_Comp");
    const styled = prop(layer(main, "Text_Styled"), "ADBE Text Properties", "ADBE Text Document").value as AeJsonTextDocument;
    expect(styled).toMatchObject({ text: "Styled Text", fontSize: 72, applyFill: true, applyStroke: false, strokeWidth: 2, justification: 7415, tracking: 50, fauxBold: false, allCaps: false, boxText: false });
    // Fonts as py_aep reads them from each version's file.
    const fonts: Record<string, [string, string]> = {
      ae2018: ["ArialMT", "TimesNewRomanPSMT"],
      ae2022: ["ArialMT", "TimesNewRomanPSMT"],
      ae2023: ["Arial", "MyriadPro-Regular"],
      ae2024: ["Arial", "TimesNewRomanPSMT"],
      ae2025: ["Arial", "TimesNewRomanPSMT"],
      ae2026: ["Arial", "MyriadPro-Regular"],
    };
    expect(styled.font).toBe(fonts[v]![0]);
    near(styled.fillColor, [1, 1, 0]);
    near(styled.leading, 86.4);
    const simple = prop(layer(main, "Text_Simple"), "ADBE Text Properties", "ADBE Text Document").value as AeJsonTextDocument;
    expect(simple).toMatchObject({ text: "Hello World", font: fonts[v]![1], fontSize: 36, justification: 7413 });
  });

  it("reads effects with their parameters", () => {
    const L = layer(comp(project(rel), "Main_Comp"), "Effect_Demo");
    const fx = prop(L, "ADBE Effect Parade").properties ?? [];
    expect(fx.slice(0, 2).map((e) => e.name)).toEqual(["Gaussian Blur", "Drop Shadow"]);
    expect(prop(fx[0]!, "ADBE Gaussian Blur 2-0001")).toMatchObject({ name: "Blurriness", value: 15 });
    near(prop(fx[1]!, "ADBE Drop Shadow-0001").value, [0, 0, 0, 1]);
    expect(prop(fx[1]!, "ADBE Drop Shadow-0004")).toMatchObject({ name: "Distance", value: 25 });
  });

  it("completes the transform group with AE's defaults", () => {
    const main = comp(project(rel), "Main_Comp");
    const t = (l: string) => prop(layer(main, l), "ADBE Transform Group");
    expect(t("Solid_Red").properties?.map((p) => p.matchName)).toEqual([
      "ADBE Anchor Point",
      "ADBE Position",
      "ADBE Position_0",
      "ADBE Position_1",
      "ADBE Position_2",
      "ADBE Scale",
      "ADBE Orientation",
      "ADBE Rotate X",
      "ADBE Rotate Y",
      "ADBE Rotate Z",
      "ADBE Opacity",
      "ADBE Envir Appear in Reflect",
    ]);
    near(prop(t("Solid_Red"), "ADBE Anchor Point").value, [960, 540, 0]);
    near(prop(t("Video_Footage"), "ADBE Anchor Point").value, [240, 135, 0]);
    near(prop(t("Shape_Star"), "ADBE Anchor Point").value, [0, 0, 0]);
    near(prop(t("Camera"), "ADBE Position").value, [960, 540, -1500]);
    expect(prop(t("Camera"), "ADBE Anchor Point").name).toBe("Point of Interest");
    expect(prop(t("Solid_3D"), "ADBE Rotate Z").name).toBe("Z Rotation");
    expect(prop(t("Solid_Red"), "ADBE Rotate Z").name).toBe("Rotation");
  });

  it("parses quickly", () => {
    const b = bytes(rel);
    readAep(b);
    const t0 = performance.now();
    readAep(b);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("paths and text against py_aep", () => {
  const compById = (rel: string, id: number): AeJsonComp => project(rel).items.find((i): i is AeJsonComp => i.itemType === "CompItem" && i.id === id)!;
  const shape = (rel: string, compId: number, layerIndex: number, mask: number): AeJsonShape => {
    const c = compById(rel, compId);
    const masks = prop(c.layers[layerIndex - 1]!, "ADBE Mask Parade").properties ?? [];
    return prop(masks[mask - 1]!, "ADBE Mask Shape").value as AeJsonShape;
  };

  it("reads Bezier mask paths", () => {
    near(shape("models/property/shape_basic.aep", 16, 1, 1), {
      closed: true,
      vertices: [[200, 50], [100, 200], [200, 350], [300, 200]],
      inTangents: [[55.23, 0], [0, -55.23], [-55.23, 0], [0, 55.23]],
      outTangents: [[-55.23, 0], [0, 55.23], [55.23, 0], [0, -55.23]],
    }, 1e-2);
    near(shape("models/property/shape_basic.aep", 30, 1, 1), {
      closed: false,
      vertices: [[50, 200], [150, 50], [250, 350], [350, 200]],
      inTangents: [[0, 0], [-30, 40], [-30, -40], [0, 0]],
      outTangents: [[30, -40], [30, 40], [30, -40], [0, 0]],
    });
    near(shape("models/property/mask.aep", 16, 1, 2), { closed: true, vertices: [[50, 50], [90, 50], [90, 90], [50, 90]], inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]], outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]] });
  });

  it("reads box text and multi-paragraph text", () => {
    const box = compById("models/text/box_overflow.aep", 1);
    const d1 = prop(box.layers[0]!, "ADBE Text Properties", "ADBE Text Document").value as AeJsonTextDocument;
    expect(d1).toMatchObject({ text: "This text is far too long to fit inside such a tiny box and must overflow it", font: "MyriadPro-Regular", fontSize: 36, boxText: true, boxTextSize: [120, 60] });
    const ranges = compById("models/text/text_ranges.aep", 1);
    const docs = ranges.layers.slice(0, 8).map((l) => (prop(l, "ADBE Text Properties", "ADBE Text Document").value as AeJsonTextDocument).text);
    expect(docs).toEqual(["New longer\rText here", "ab\u{1F600}cd\rnext line", "A\rB\r", "", "Left aligned\rRight aligned", "AVAWAY", "The quick brown fox jumps over the lazy dog\rshort tail", "Hello World\rSecond Paragraph\rEnd"]);
    // Paragraphs aligned differently report MULTIPLE_JUSTIFICATIONS like AE (py_aep reports the first).
    expect((prop(ranges.layers[4]!, "ADBE Text Properties", "ADBE Text Document").value as AeJsonTextDocument).justification).toBe(7412);
  });
});

describe("errors", () => {
  it("rejects files that aren't After Effects projects", () => {
    for (const b of [new Uint8Array(0), new TextEncoder().encode("hello world, not a project"), Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0])]) {
      expect(() => readAep(b)).toThrow(AepReadError);
      expect(() => readAep(b)).toThrow("This file isn't an After Effects project (.aep).");
      expect(isAep(b)).toBe(false);
    }
    // RIFX, but not an AE project.
    const other = Uint8Array.from([0x52, 0x49, 0x46, 0x58, 0, 0, 0, 4, 0x57, 0x41, 0x56, 0x45]);
    expect(() => readAep(other)).toThrow("This file isn't an After Effects project (.aep).");
    expect(isAep(bytes("versions/ae2025/complete.aep"))).toBe(true);
    const aepx = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?>\n<AfterEffectsProject xmlns="http://www.adobe.com/products/aftereffects">');
    expect(() => readAep(aepx)).toThrow(/XML project \(\.aepx\)/);
  });

  it("explains a truncated or damaged project", () => {
    const b = bytes("versions/ae2025/complete.aep");
    const rifxEnd = 8 + new DataView(b.buffer, b.byteOffset).getUint32(4);
    for (const n of [12, 100, 5000, Math.floor(b.length / 2), rifxEnd - 1000]) {
      expect(() => readAep(b.slice(0, n))).toThrow(/damaged or incomplete/);
    }
  });

  it("never fails with anything but a plain-language error on corrupted bytes", () => {
    const base = bytes("models/property/keyframe_BEZIER.aep");
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 60; i++) {
      const b = base.slice();
      for (let k = 0; k < 20; k++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
      try {
        const p = readAep(b);
        expect(Array.isArray(p.items)).toBe(true);
      } catch (e) {
        expect(e).toBeInstanceOf(AepReadError);
      }
    }
  });
});

describe("notes", () => {
  it("lists what couldn't be read in plain words", () => {
    const p = project("models/text/text_ranges.aep");
    expect(p.notes?.some((n) => /mixes several fonts, sizes or colours/.test(n))).toBe(true);
    expect(project("versions/ae2025/complete.aep").notes ?? []).toEqual([]);
  });
});

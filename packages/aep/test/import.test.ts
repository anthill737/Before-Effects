/**
 * The whole route without After Effects: .aep bytes → readAep → importAeProject → a Before Effects
 * project that evaluates at any time, with a report that accounts for what didn't come across.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateCompAt, importAeProject, secondsToTime } from "../../core/src/index.ts";
import { readAep } from "../src/index.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : f.endsWith(".aep") ? [join(dir, f)] : []));
const all = files(root);

describe(".aep → Before Effects project", () => {
  it.each(all.map((f) => [relative(root, f), f]))("%s imports and every composition evaluates", (_name, file) => {
    const ae = readAep(new Uint8Array(readFileSync(file)), { fileName: file });
    const { project, report } = importAeProject(ae, { route: "aep-file" });
    expect(Object.keys(project.compositions).length).toBe(ae.items.filter((i) => i.itemType === "CompItem").length);
    for (const c of Object.values(project.compositions)) {
      for (const s of [0, 0.4, 1.3, 4.2]) expect(() => evaluateCompAt(project, c, secondsToTime(Math.min(s, c.duration / 705_600_000)), {})).not.toThrow();
    }
    // Every layer is either imported or reported.
    const aeLayers = ae.items.reduce((n, i) => n + (i.itemType === "CompItem" ? i.layers.length : 0), 0);
    expect(report.counts.layers + report.notes.filter((n) => /couldn't be imported/.test(n.text)).length).toBe(aeLayers);
  });

  it("brings the complete After Effects 2026 project across with text, masks and shapes from the binary file", () => {
    const ae = readAep(new Uint8Array(readFileSync(join(root, "versions", "ae2026", "complete.aep"))));
    const { project, mainCompId, report } = importAeProject(ae, { route: "aep-file" });
    const main = project.compositions[mainCompId!]!;
    const byName = (n: string) => Object.values(main.layers).find((l) => l.name === n)!;
    const text = byName("Text_Styled").source;
    expect(text.kind).toBe("text");
    if (text.kind === "text") {
      expect(text.doc.text.length).toBeGreaterThan(0);
      expect(text.doc.font).not.toMatch(/MT$|-/);
    }
    const masked = byName("Masked_Layer");
    expect(masked.masks.length).toBe(2);
    expect(masked.masks.every((m) => m.source.kind === "path" && (m.source.path.value[1] ?? 0) >= 4)).toBe(true);
    const shape = byName("Shape_Rectangle").source;
    expect(shape.kind === "shape" && shape.contents.length).toBeGreaterThan(0);
    expect(report.notes.some((n) => /text content couldn't be read|mask's outline couldn't be read/.test(n.text))).toBe(false);
    expect(report.counts).toMatchObject({ compositions: 6, layers: 33, masks: 2, effects: 7, expressions: 4 });
    // Every layer lands in exactly one fidelity group.
    const f = report.layerFidelity;
    expect(f.drawn + f.approximated + f.preservedNotDrawn + f.notImported).toBe(33);
    expect(f.preservedNotDrawn).toBe(4); // 3 lights + 1 camera
  });

  it("reports blend modes that are kept but not drawn instead of implying they render", () => {
    const layer = (index: number, name: string, blendingMode: number) => ({ index, name, matchName: "ADBE AV Layer", sourceId: 2, inPoint: 0, outPoint: 5, blendingMode });
    const { project, report } = importAeProject(
      {
        items: [
          { id: 2, name: "Red", itemType: "FootageItem", width: 100, height: 100, mainSource: { sourceType: "SolidSource", color: [1, 0, 0] } },
          { id: 1, name: "Comp", itemType: "CompItem", width: 100, height: 100, frameRate: 30, duration: 5, layers: [layer(1, "Over", 5226), layer(2, "Dissolve", 5213), layer(3, "Screen", 5222)] },
        ],
      },
      { route: "aep-file" },
    );
    const c = Object.values(project.compositions)[0]!;
    const by = (n: string) => Object.values(c.layers).find((l) => l.name === n)!;
    expect(by("Over").blendMode).toBe("overlay"); // kept for later…
    const notes = report.notes.filter((n) => /Blend mode/.test(n.text));
    expect(notes.find((n) => n.where.endsWith("Over"))?.text).toMatch(/isn't drawn yet: the layer currently draws as Normal/);
    expect(notes.find((n) => n.where.endsWith("Dissolve"))?.text).toMatch(/no Before Effects equivalent; Normal is used/);
    expect(notes.some((n) => n.where.endsWith("Screen"))).toBe(false); // drawn as in After Effects
    expect(notes.every((n) => n.level === "approximated")).toBe(true);
    expect(report.layerFidelity).toEqual({ drawn: 1, approximated: 2, preservedNotDrawn: 0, notImported: 0 });
  });
});

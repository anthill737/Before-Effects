/** The whole house in 3D: areas at their depth, cut-outs, and one viewpoint shared by every scene. */
import { describe, expect, it } from "vitest";
import { canvasToWorld, createRegistry, emptyProject, History, houseFloorLine, houseScene, objectPose, polygonPath, type Region, regionDepth, resolveScene3D, sceneCameraDistance, type Venue } from "../src/index.ts";

const rect = (x: number, y: number, w: number, h: number) => polygonPath([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);

const setup = () => {
  const regions: Region[] = [
    { id: "wall", name: "Front wall", kind: "wall", tags: [], path: rect(100, 200, 1400, 700) },
    { id: "win", name: "Window", kind: "window", tags: [], path: rect(300, 350, 300, 250) },
    { id: "col", name: "Column", kind: "column", tags: [], path: rect(900, 300, 120, 600) },
    { id: "lamp", name: "Lantern", kind: "light", tags: [], path: rect(940, 560, 40, 80) },
    { id: "fx", name: "Effect area", kind: "custom", tags: [], path: rect(200, 250, 800, 500) },
    { id: "line", name: "Roofline", kind: "roofline", tags: [], path: { ...rect(100, 150, 1400, 10), closed: false } },
    { id: "dark", name: "Keep dark", kind: "exclusion", tags: [], path: rect(0, 0, 50, 50) },
  ];
  const venue: Venue = { id: "v", name: "House", kind: "flat", canvas: { width: 1600, height: 1000 }, regionOrder: regions.map((r) => r.id), regions: Object.fromEntries(regions.map((r) => [r.id, r])), groups: {}, projectorOrder: [], projectors: {} };
  const h = new History(emptyProject("t"), createRegistry());
  h.apply({ type: "venue.add", args: { venue, makeActive: true } });
  return h;
};

describe("the whole house in 3D", () => {
  it("makes every solid area its own piece at its kind's depth, cutting what's set in or standing out from the wall", () => {
    const h = setup();
    const s = houseScene(h.project, { sceneId: "h3d", idPrefix: "h", name: "House 3D", venueId: "v", canvas: { width: 1600, height: 1000 } });
    const areaObjs = Object.values(s.objects).filter((o) => o.geometry?.kind === "area" && o.id !== "h-inside");
    // Wall, window, column and its lantern; not the roofline (a line), the keep-dark area, or a custom effect area.
    expect(areaObjs.map((o) => o.name).sort()).toEqual(["Column", "Front wall", "Lantern", "Window"]);
    const geo = (name: string) => {
      const g = areaObjs.find((o) => o.name === name)!.geometry!;
      if (g.kind !== "area") throw new Error("not an area");
      return g;
    };
    expect(geo("Column").standOut).toBeCloseTo(0.35);
    expect(geo("Window").standOut).toBeCloseTo(-0.12);
    expect(geo("Front wall").standOut ?? 0).toBe(0);
    // The lantern stands out from its column, not from the wall (it would be buried in the column).
    expect(geo("Lantern").standOut).toBeCloseTo(0.35 + 0.06);
    expect([...(geo("Column").cut?.regionIds ?? [])]).toEqual(["lamp"]);
    // The lantern has nothing cut out of it (the column's middle being inside it doesn't count).
    expect(geo("Lantern").cut).toBeUndefined();
    // The wall has the window, the column (and the lantern in front of it) cut out, so each sits at its own depth.
    expect([...(geo("Front wall").cut?.regionIds ?? [])].sort()).toEqual(["col", "lamp", "win"]);
    // A key light that's the picture's own lighting, a soft fill, and a ground that only shows shadows.
    expect(Object.values(s.objects).some((o) => o.light?.type === "directional" && o.light.balance)).toBe(true);
    expect(Object.values(s.objects).some((o) => o.material?.style === "shadow")).toBe(true);
    // Every part is solid: fixed in place, so what's thrown or knocked loose hits it.
    expect(areaObjs.every((o) => o.physics?.body === "static")).toBe(true);
    // It follows the building's viewpoint.
    expect(s.cameraDistance).toBeUndefined();
  });

  it("uses an area's own depth when it has one", () => {
    const h = setup();
    h.apply({ type: "region.update", args: { venueId: "v", regionId: "col", changes: { depth: { standOut: 0.8 } } } });
    expect(regionDepth(h.project.venues.v!.regions.col!)).toEqual({ standOut: 0.8, thickness: 0.35 });
    const s = houseScene(h.project, { sceneId: "h3d", idPrefix: "h", name: "House 3D", venueId: "v", canvas: { width: 1600, height: 1000 } });
    const g = Object.values(s.objects).find((o) => o.name === "Column")!.geometry!;
    expect(g.kind === "area" && g.standOut).toBeCloseTo(0.8);
    h.apply({ type: "region.update", args: { venueId: "v", regionId: "col", changes: { depth: null } } });
    expect(regionDepth(h.project.venues.v!.regions.col!).standOut).toBeCloseTo(0.35);
  });

  it("shares the building's viewpoint between scenes, unless a scene has its own", () => {
    const h = setup();
    const s = houseScene(h.project, { sceneId: "h3d", idPrefix: "h", name: "House 3D", venueId: "v", canvas: { width: 1600, height: 1000 } });
    h.apply({ type: "scene3d.add", args: { scene: s } });
    const res = () => resolveScene3D(h.project, h.project.scenes3d!.h3d!, { venueId: "v", canvas: { width: 1600, height: 1000 }, fps: 30, frames: 30 });
    expect(res().cameraDistance).toBeCloseTo(1.6);
    h.apply({ type: "venue.update", args: { venueId: "v", changes: { cameraDistance: 2.4 } } });
    expect(res().cameraDistance).toBeCloseTo(2.4);
    h.apply({ type: "scene3d.update", args: { sceneId: "h3d", changes: { cameraDistance: 1.1 } } });
    expect(sceneCameraDistance(h.project, h.project.scenes3d!.h3d!, "v")).toBeCloseTo(1.1);
    h.apply({ type: "scene3d.update", args: { sceneId: "h3d", changes: { cameraDistance: null } } });
    expect(res().cameraDistance).toBeCloseTo(2.4);
  });

  it("has a room behind the front: a floor where the house meets the ground and a back wall, both unseen", () => {
    // Most of the front's bottom is at y 900; steps come forward lower (y 960) for a short stretch,
    // and an overhang at the side ends higher (y 400).
    const outlines: Array<Array<[number, number]>> = [
      [[100, 200], [1500, 200], [1500, 900], [100, 900]],
      [[700, 850], [900, 850], [900, 960], [700, 960]],
      [[1500, 200], [1600, 200], [1600, 400], [1500, 400]],
    ];
    expect(houseFloorLine(outlines)).toBe(900);
    const h = setup();
    const s = houseScene(h.project, { sceneId: "h3d", idPrefix: "h", name: "House 3D", venueId: "v", canvas: { width: 1600, height: 1000 } });
    const floor = Object.values(s.objects).find((o) => o.id === "h-floor")!;
    const g = floor.geometry!;
    if (g.kind !== "box") throw new Error("not a box");
    // Its top at the wall's bottom edge (y 900), from the house front back to the back wall; solid, unseen.
    expect(floor.position.value[1] + g.size[1] / 2).toBeCloseTo(canvasToWorld([0, 900], { width: 1600, height: 1000 })[1], 6);
    expect(floor.position.value[2] + g.size[2] / 2).toBeCloseTo(0, 6);
    expect(floor.visible).toBe(false);
    const wall = Object.values(s.objects).find((o) => o.id === "h-back")!;
    const wg = wall.geometry!;
    if (wg.kind !== "box") throw new Error("not a box");
    expect(floor.position.value[2] - g.size[2] / 2).toBeCloseTo(wall.position.value[2] + wg.size[2] / 2, 6);
    // A room's depth: room for what's knocked in to fall.
    expect(wall.position.value[2]).toBeLessThan(-3.5);
    expect(wall.visible).toBe(false);
    expect(wall.physics?.body).toBe("static");
    expect(floor.physics?.body).toBe("static");
  });

  it("shows the dark inside exactly within the house's outline, from the show's viewpoint", () => {
    const h = setup();
    const canvas = { width: 1600, height: 1000 };
    const s = houseScene(h.project, { sceneId: "h3d", idPrefix: "h", name: "House 3D", venueId: "v", canvas });
    h.apply({ type: "scene3d.add", args: { scene: s } });
    const inside = s.objects["h-inside"]!;
    expect(inside.geometry?.kind).toBe("area");
    expect(inside.physics).toBeUndefined(); // what's knocked in passes it
    expect(inside.material?.color.value.slice(0, 3)).toEqual([0, 0, 0]);
    const r = resolveScene3D(h.project, h.project.scenes3d!.h3d!, { venueId: "v", canvas, fps: 30, frames: 30 });
    const ro = r.objects.find((x) => x.object.id === "h-inside")!;
    // The wall's corner (canvas 1500, 900), seen from the camera through the inside's front, lands on
    // the canvas exactly where the wall's corner is.
    const piece = ro.pieces.find((pc) => pc.outline.length === 4 && Math.abs(pc.area - 14 * 7) < 0.5)!;
    const pose = objectPose(s, inside, 0);
    const corner = pose.place([piece.center[0] + 7, piece.center[1] - 3.5, piece.center[2] + piece.depth / 2]);
    const camZ = 1.6 * 16;
    const eyeY = 5;
    const f = camZ / (camZ - corner[2]);
    const onCanvas: [number, number] = [corner[0] * f, eyeY + (corner[1] - eyeY) * f];
    const want = canvasToWorld([1500, 900], canvas);
    expect(onCanvas[0]).toBeCloseTo(want[0], 6);
    expect(onCanvas[1]).toBeCloseTo(want[1], 6);
    expect(corner[2]).toBeLessThan(-0.3); // behind the wall's back
  });
});

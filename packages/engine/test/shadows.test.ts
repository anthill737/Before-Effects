/** Shadow maps sized for the picture being drawn. */
import { describe, expect, it } from "vitest";
import { shadowMapSize } from "../src/scene3d.ts";

describe("shadow map size", () => {
  it("keeps full detail at full size and above, and less for smaller previews", () => {
    expect(shadowMapSize(1080)).toBe(2048);
    expect(shadowMapSize(2160)).toBe(2048);
    expect(shadowMapSize(720)).toBe(2048); // rounds up: never less detail than the picture can show
    expect(shadowMapSize(540)).toBe(1024);
    expect(shadowMapSize(270)).toBe(512);
    expect(shadowMapSize(135)).toBe(512);
  });
});

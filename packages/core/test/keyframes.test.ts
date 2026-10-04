import { describe, expect, it } from "vitest";
import { type AnimProp, evalProp } from "../src/anim.ts";
import { keyAt, keyEase, setKeyEase, setPropAt, toggleKeyAt } from "../src/keyframes.ts";
import { FLICKS_PER_SECOND } from "../src/time.ts";

const s = (x: number) => Math.round(x * FLICKS_PER_SECOND);
/** Add a key at `t` with `v` and set how it leaves, the way the agent API and the key menu do. */
const key = (p: AnimProp<number>, t: number, v: number, ease: "linear" | "ease") => {
  const next = setPropAt(p.keyframes?.length ? p : toggleKeyAt(p, s(t)), s(t), v);
  return setKeyEase(next, keyAt(next, s(t))!.id, ease);
};

describe("keyframes added one after another keep the timing chosen", () => {
  it("a path built key by key with Steady stays steady to the last key", () => {
    let p: AnimProp<number> = { value: 0 };
    p = key(p, 0, 0, "linear");
    p = key(p, 0.75, 0, "linear");
    p = key(p, 1, 10, "linear");
    // Steady from 0.75 s to 1 s: halfway there at 0.875 s, and still moving at full speed at 1 s.
    expect(evalProp(p, s(0.875))).toBeCloseTo(5, 6);
    expect(evalProp(p, s(1)) - evalProp(p, s(1 - 1 / 30))).toBeCloseTo(10 / 7.5, 6);
    expect(keyEase(p, p.keyframes![1]!.id)).toBe("linear");
  });

  it("a key added inside a steady stretch leaves the motion unchanged", () => {
    let p: AnimProp<number> = { value: 0 };
    p = key(p, 0, 0, "linear");
    p = key(p, 2, 20, "linear");
    const before = [0.3, 0.9, 1.7].map((t) => evalProp(p, s(t)));
    p = toggleKeyAt(p, s(1));
    expect([0.3, 0.9, 1.7].map((t) => evalProp(p, s(t)))).toEqual(before.map((v) => expect.closeTo(v, 6)));
  });

  it("smooth keys stay smooth", () => {
    let p: AnimProp<number> = { value: 0 };
    p = key(p, 0, 0, "ease");
    p = key(p, 1, 10, "ease");
    expect(keyEase(p, p.keyframes![0]!.id)).toBe("ease");
    // Easing into the last key: barely moving at the end.
    expect(evalProp(p, s(1)) - evalProp(p, s(1 - 1 / 30))).toBeLessThan(0.1);
  });
});

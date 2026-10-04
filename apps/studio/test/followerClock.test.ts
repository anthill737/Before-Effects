/**
 * The clock projector outputs play by: following the editor's sound clock from its reports without
 * ever putting the picture back a frame, holding with it, and jumping only for seeks and loops.
 */
import { describe, expect, it } from "vitest";
import { FLICKS_PER_SECOND } from "@be/core";
import { FollowerClock } from "../src/shared/followerClock.ts";
import type { TransportState } from "../src/shared/api.ts";

const F = FLICKS_PER_SECOND;
const ms = (flicks: number) => (flicks / F) * 1000;
const frameAt30 = (flicks: number) => Math.floor((flicks / F) * 30);

/** A small deterministic random sequence (so the jitter is the same every run). */
const random = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};

/**
 * The editor: a sound clock that moves in 10 ms steps from `start` (show seconds) at wall time 0 (so a
 * reading lags the moment it's taken by up to 10 ms), and reports about every 40 ms (its timer is a
 * few ms late at times), stamped when sent and arriving 1–6 ms later. Returns reports by arrival.
 */
const editorReports = (opts: { start: number; untilMs: number; held?: (wallMs: number) => boolean; range?: { start: number; end: number } | null }) => {
  const rnd = random(7);
  const out: Array<{ arrives: number; t: TransportState }> = [];
  let heldSince: number | null = null;
  let heldAt = 0;
  let offset = 0;
  for (let beat = 0; beat <= opts.untilMs; beat += 40) {
    const sent = beat + rnd() * 8;
    const held = opts.held?.(sent) ?? false;
    // While held the sound clock stands still; afterwards it goes on from there.
    if (held && heldSince === null) {
      heldSince = sent;
      heldAt = Math.floor((sent - offset) / 10) * 10;
    }
    if (!held && heldSince !== null) {
      offset += sent - heldSince;
      heldSince = null;
    }
    const soundMs = held ? heldAt : Math.floor((sent - offset - 3.7) / 10) * 10 + 3.7;
    out.push({ arrives: sent + 1 + rnd() * 5, t: { playing: true, time: opts.start * F + (soundMs / 1000) * F, at: sent, loop: false, range: opts.range ?? null, ...(held ? { held } : {}) } });
  }
  return out;
};

/** Play the follower through the reports, reading every 7 ms (a 144 Hz display); returns what it read. */
const follow = (reports: Array<{ arrives: number; t: TransportState }>, untilMs: number, clock = new FollowerClock()) => {
  const reads: Array<{ at: number; time: number }> = [];
  let next = 0;
  for (let now = 0; now <= untilMs; now += 7) {
    while (next < reports.length && reports[next]!.arrives <= now) {
      clock.apply(reports[next]!.t, reports[next]!.arrives);
      next++;
    }
    const time = clock.read(now);
    if (time !== null) reads.push({ at: now, time });
  }
  return { reads, clock };
};

describe("following the editor's sound clock", () => {
  it("stays within a few ms of the sound and never goes back a frame, though each report is off by a few ms", () => {
    const reports = editorReports({ start: 100, untilMs: 20_000 });
    const { reads, clock } = follow(reports, 20_000);
    let back = 0;
    let worst = 0;
    for (let i = 1; i < reads.length; i++) {
      if (reads[i]!.time < reads[i - 1]!.time) back++;
      // The true sound clock at this moment (it started at wall 0).
      const truth = 100 * F + (reads[i]!.at / 1000) * F;
      if (reads[i]!.at > 200) worst = Math.max(worst, Math.abs(ms(reads[i]!.time - truth)));
    }
    expect(back).toBe(0);
    expect(worst).toBeLessThan(15);
    expect(clock.error(20_000).maxMs).toBeLessThan(15);
    // Every frame shown, none skipped: consecutive reads never pass over a frame.
    const frames = reads.map((r) => frameAt30(r.time));
    for (let i = 1; i < frames.length; i++) expect(frames[i]! - frames[i - 1]!).toBeLessThanOrEqual(1);
  });

  it("holds when the editor holds, and after it goes on a little behind, waits on its frame instead of going back", () => {
    // Held from 2 s to 2.6 s (reading ahead, or the sound card waking): the editor reports the clock standing still.
    const reports = editorReports({ start: 50, untilMs: 5000, held: (w) => w >= 2000 && w < 2600 });
    const { reads, clock } = follow(reports, 5000);
    for (let i = 1; i < reads.length; i++) expect(reads[i]!.time).toBeGreaterThanOrEqual(reads[i - 1]!.time);
    // While held it stays put (at most the few ms it got ahead before hearing of the hold).
    const during = reads.filter((r) => r.at > 2100 && r.at < 2600).map((r) => r.time);
    expect(Math.max(...during) - Math.min(...during)).toBe(0);
    // A second after, it's back with the sound (which lost the 0.6 s it stood still).
    const end = reads.at(-1)!;
    const truth = 50 * F + ((end.at - 600) / 1000) * F;
    expect(Math.abs(ms(end.time - truth))).toBeLessThan(15);
    expect(clock.error(5000).maxMs).toBeLessThan(15);
  });

  it("would have run on and gone back if the editor stood still without saying so: the clock error shows it", () => {
    // The editor's clock stands still 2 s to 2.5 s but its reports don't say "held".
    const reports = editorReports({ start: 10, untilMs: 4000 });
    const silentStall = reports.map(({ arrives, t }) => {
      const sent = t.at;
      const soundMs = sent < 2000 ? Math.floor(sent / 10) * 10 : sent < 2500 ? 2000 : Math.floor((sent - 500) / 10) * 10;
      return { arrives, t: { ...t, time: 10 * F + (soundMs / 1000) * F } };
    });
    const { clock } = follow(silentStall, 4000);
    // The follower can't know; what it can do is report it, so a test can't pass it as smooth.
    expect(clock.error(4000).maxMs).toBeGreaterThan(100);
  });

  it("jumps for a seek or round the loop, both ways", () => {
    const clock = new FollowerClock();
    const at = (time: number, sent: number): TransportState => ({ playing: true, time, at: sent, loop: true, range: { start: 0, end: 60 * F } });
    clock.apply(at(30 * F, 0), 1);
    expect(ms(clock.read(500)! - 30 * F)).toBeCloseTo(500, -1);
    // Seek back 10 s while playing.
    clock.apply(at(20 * F + 0.5 * F, 500), 501);
    expect(ms(clock.read(510)! - 20.5 * F)).toBeLessThan(15);
    // Round the loop (end of range back to its start).
    clock.apply(at(59.99 * F, 1000), 1001);
    expect(clock.read(1005)!).toBeGreaterThan(59.9 * F);
    clock.apply(at(0.01 * F, 1040), 1041);
    expect(clock.read(1045)!).toBeLessThan(0.1 * F);
  });

  it("never plays past the end of the range", () => {
    const clock = new FollowerClock();
    clock.apply({ playing: true, time: 9.9 * F, at: 0, loop: false, range: { start: 0, end: 10 * F } }, 0);
    expect(clock.read(1000)).toBe(10 * F - 1);
  });

  it("gives no clock when the editor isn't playing, and starts afresh on play", () => {
    const clock = new FollowerClock();
    expect(clock.read(0)).toBeNull();
    clock.apply({ playing: false, time: 5 * F, at: 0, loop: false, range: null }, 0);
    expect(clock.read(10)).toBeNull();
    clock.apply({ playing: true, time: 5 * F, at: 100, loop: false, range: null }, 100);
    expect(ms(clock.read(200)! - 5 * F)).toBeCloseTo(100, -1);
    clock.apply({ playing: false, time: 5.1 * F, at: 200, loop: false, range: null }, 200);
    // Paused, then played from an earlier point: no clinging to the later time it showed before.
    clock.apply({ playing: true, time: 1 * F, at: 300, loop: false, range: null }, 300);
    expect(ms(clock.read(300)! - 1 * F)).toBeLessThan(1);
  });
});

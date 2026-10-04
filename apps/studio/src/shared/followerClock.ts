/**
 * The clock a projector output (or pop-out) plays by: the editor's clock, carried forward between its
 * reports.
 *
 * The editor reports its sound card's clock 25 times a second. Each report is off by a few ms (the
 * sound card's clock moves in steps, and the report takes a moment to arrive), and snapping to each
 * would now and then put the picture back a frame. So the follower runs its own clock and eases it
 * toward each report (a fifth of the difference at a time), and never goes back: when the editor
 * holds (reading ahead, sound starting, the sound card standing still) or goes on after holding a
 * little behind where the follower got to, the follower stays on its frame until the editor catches
 * up. It jumps only for a seek or round the loop (over a quarter second off).
 *
 * Pure (times are passed in) so it can be tested; the windows use one with the computer's clock.
 */
import { FLICKS_PER_SECOND } from "@be/core";
import type { TransportState } from "./api.ts";

/** Further off than this (ms) is a seek or round the loop: jump instead of easing. */
export const SNAP_MS = 250;
/** Part of the difference to each report taken at once. */
const EASE = 0.2;
/** Clock error is kept for this long (ms) for the "recent" figure. */
const RECENT_MS = 2000;

export class FollowerClock {
  private following: TransportState | null = null;
  /** Its own clock: show time `time` at ms `at`; null to take the next report as it is. */
  private own: { time: number; at: number } | null = null;
  /** The latest time it gave (it never gives an earlier one while playing, except for a seek or loop). */
  private shown = -Infinity;
  private errors: Array<[number, number]> = [];
  private errorMax = 0;

  private near(a: number, b: number): boolean {
    return Math.abs(a - b) < (SNAP_MS / 1000) * FLICKS_PER_SECOND;
  }
  private ownAt(now: number): number {
    return this.own!.time + ((now - this.own!.at) / 1000) * FLICKS_PER_SECOND;
  }
  private static reported(t: TransportState, now: number): number {
    return t.time + ((now - t.at) / 1000) * FLICKS_PER_SECOND;
  }

  /** The editor's latest report. */
  get transport(): TransportState | null {
    return this.following;
  }

  /** Take a report from the editor, received at `now` (ms, the same clock as its `at`). */
  apply(t: TransportState, now: number): void {
    const prev = this.following;
    if (t.playing && !(prev?.playing ?? false)) {
      this.errors = [];
      this.errorMax = 0;
    }
    const sameRange = prev?.range?.start === t.range?.start && prev?.range?.end === t.range?.end;
    if (!t.playing || t.held || !prev?.playing || prev.held || !this.own || !sameRange) {
      // Stopped, held, starting or a new range: take the report as it is (still not going back for
      // a hold or start a little behind the frame on screen).
      this.own = t.playing && !t.held ? { time: FollowerClock.reported(t, now), at: now } : null;
      if (!t.playing || !this.near(t.time, this.shown)) this.shown = -Infinity;
    } else {
      const off = FollowerClock.reported(t, now) - this.ownAt(now);
      const ms = Math.abs((off / FLICKS_PER_SECOND) * 1000);
      // Seconds apart: a seek or round the loop, not clock error.
      if (ms < 3000) {
        this.errors.push([now, ms]);
        this.errorMax = Math.max(this.errorMax, ms);
      }
      if (ms > SNAP_MS) {
        this.own = { time: FollowerClock.reported(t, now), at: now };
        this.shown = -Infinity;
      } else this.own = { time: this.ownAt(now) + off * EASE, at: now };
    }
    this.following = t;
  }

  /** Show time (flicks) to play at `now`, or null when the editor isn't playing. */
  read(now: number): number | null {
    const t = this.following;
    if (!t || !t.playing) return null;
    if (t.held || !this.own) return this.near(t.time, this.shown) ? Math.max(this.shown, t.time) : t.time;
    const time = Math.max(this.shown, Math.round(this.ownAt(now)));
    this.shown = time;
    return t.range ? Math.min(time, t.range.end - 1) : time;
  }

  /**
   * How far its clock was from each report while both said playing (ms): largest in the last two
   * seconds and since playback started. A few ms when it follows the sound; a hold or jump it wasn't
   * told about shows here even when its picture-to-clock offset looks fine.
   */
  error(now: number): { recentMs: number; maxMs: number } {
    this.errors = this.errors.filter(([at]) => now - at < RECENT_MS);
    return { recentMs: Math.round(Math.max(0, ...this.errors.map(([, e]) => e))), maxMs: Math.round(this.errorMax) };
  }
}

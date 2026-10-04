/**
 * Counting playback honestly from the frames actually put on screen: frames never shown between two
 * shown one after the other (passed over by the clock, or not ready in time), and the picture going
 * back to an earlier frame (it shows frames again). Counting clock steps instead misses frames that
 * weren't ready, and counting draws counts the same frame redrawn.
 */

/**
 * Between the last frame shown (`last`; -1 for none yet) and the one being shown while playing.
 * `wrappedAt`: the range's last frame when playback went round the loop in between (null if not);
 * `rangeStart`: the range's first frame. Frames seconds apart are a seek, not frames passed over.
 */
export const unshownBetween = (last: number, frame: number, wrappedAt: number | null, rangeStart: number, fps: number): { unshown: number; back: boolean } => {
  if (last < 0 || frame === last) return { unshown: 0, back: false };
  const gap = wrappedAt !== null ? wrappedAt - last + frame - rangeStart : frame - last - 1;
  return { unshown: gap > 0 && gap < fps * 5 ? gap : 0, back: wrappedAt === null && frame < last && last - frame < fps * 5 };
};

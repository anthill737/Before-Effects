/**
 * What's going on in the editor, for work done in the background to give way to: a preparation job
 * running, and the last time the person did something (played, moved the playhead, edited).
 */
export const activity = { preparing: false, lastInteraction: 0 };

/** The person just did something: background work waits a moment. */
export const touched = (): void => {
  activity.lastInteraction = performance.now();
};

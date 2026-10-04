/**
 * Keeps windows in step. The editor publishes the project (with exact invalidation info) and the
 * playback clock. Pop-out and projector windows follow, and their transport buttons publish back.
 * Echoes are suppressed so a change never bounces between windows.
 */
import { affectedByPatches, type Affected, type Project, FLICKS_PER_SECOND } from "@be/core";
import type { TransportState } from "../../../shared/api.ts";
import { FollowerClock } from "../../../shared/followerClock.ts";
import { previewAudio } from "../studio/audioEngine.ts";
import { useStudio } from "../studio/store.ts";
import { usePreviewStats } from "./loop.ts";
import { currentPreviewLoop } from "./PreviewPanel.tsx";

interface ProjectMessage {
  readonly project: Project;
  readonly compId: string | null;
  readonly affected: Affected;
  /** What the change did to each of the other compositions (a scene edit also changes the show around it). */
  readonly others?: Readonly<Record<string, Affected>>;
}

const ALL: Affected = { all: true, ranges: [] };

/** The change's effect on every composition other than `compId`. */
const othersOf = (prev: Project | null, next: Project, patches: Parameters<typeof affectedByPatches>[2] | null, compId: string | null): Record<string, Affected> =>
  Object.fromEntries(Object.keys(next.compositions).filter((c) => c !== compId).map((c) => [c, prev && patches ? affectedByPatches(prev, next, patches, c) : ALL]));

let applyingRemote = false;

/**
 * The editor's clock now. While sound plays it is the sound card's clock (also when the editor's own
 * window is hidden behind a full-screen output and draws nothing); while the editor reads frames
 * ahead before going on, it's held.
 */
const transportOf = (): TransportState => {
  const s = useStudio.getState();
  const sound = s.playing ? previewAudio.now() : null;
  // Held while reading ahead, and while its sound gets ready to start or waits for the sound card
  // (the picture waits for it; a follower carrying the clock on would run ahead, then go back).
  const held = s.playing && (usePreviewStats.getState().mode === "preparing" || previewAudio.starting || previewAudio.waiting);
  // Without sound the clock is the picture's, set once per frame drawn: the time is for when it was
  // set (a slow frame would otherwise report a clock that stands still, then jumps).
  const setAt = currentPreviewLoop()?.clockAt ?? 0;
  const at = sound === null && s.playing && !held && Date.now() - setAt < 1000 ? setAt : Date.now();
  return { playing: s.playing, time: sound ?? s.time, at, loop: s.loop, range: s.range, ...(held ? { held } : {}) };
};

/**
 * Editor: publish transport changes (play/pause, seeks while paused, loop, range, holding) and,
 * while playing, the clock about 25 times a second, so outputs follow the sound closely.
 */
const startTransportPublishing = (): (() => void) => {
  let last = transportOf();
  const send = () => window.be.sync.publishTransport((last = transportOf()));
  const unsub = useStudio.subscribe((s) => {
    if (applyingRemote) return;
    const changed = s.playing !== last.playing || s.loop !== last.loop || s.range !== last.range || (!s.playing && s.time !== last.time);
    if (changed) send();
  });
  const unsubHeld = usePreviewStats.subscribe((st) => {
    if (useStudio.getState().playing && (st.mode === "preparing" || previewAudio.starting) !== !!last.held) send();
  });
  // Sound starting or starting to play: at once (followers hold, then go on from the same moment).
  const unsubSound = previewAudio.onChange(() => {
    if (useStudio.getState().playing) send();
  });
  const beat = setInterval(() => {
    if (useStudio.getState().playing) send();
  }, 40);
  return () => {
    unsub();
    unsubHeld();
    unsubSound();
    clearInterval(beat);
  };
};

/**
 * Editor: open projector outputs that play prepared frames, and how many they have ready ahead
 * (checked four times a second while playing). Playback starts once each has a second ready.
 */
let outputsAhead: number[] = [];
export const followersReady = (): boolean => outputsAhead.every((n) => n >= 30);
const watchOutputs = (): (() => void) => {
  const timer = setInterval(() => {
    if (!useStudio.getState().playing) return;
    void window.be.windows.outputs().then(
      (list) => (outputsAhead = list.filter((o) => o.open && o.showing && Date.now() - o.showing.at < 1000 && (o.showing.framesOnDisk ?? 0) > 0).map((o) => o.showing!.ahead ?? 0)),
      () => (outputsAhead = []),
    );
  }, 250);
  return () => clearInterval(timer);
};

/** Follower: the editor's clock carried forward between its reports (see FollowerClock). */
const follower = new FollowerClock();
/** Follower: the editor's clock now (null when it isn't playing). */
export const followerClock = (): number | null => follower.read(Date.now());
/** Follower: how far its clock was from the editor's reports (ms): largest recently and since playback started. */
export const followerClockError = (): { recentMs: number; maxMs: number } => follower.error(Date.now());

const applyTransport = (t: TransportState) => {
  follower.apply(t, Date.now());
  applyingRemote = true;
  const elapsed = t.playing && !t.held ? Math.round(((Date.now() - t.at) / 1000) * FLICKS_PER_SECOND) : 0;
  useStudio.setState({ playing: t.playing, time: t.time + elapsed, loop: t.loop, range: t.range });
  applyingRemote = false;
};

/** Editor side: publish project changes with the frames they affect, and follow remote transport. */
export const startEditorSync = (): (() => void) => {
  const unsubProject = useStudio.subscribe((s, prev) => {
    const loop = currentPreviewLoop();
    if (s.hoverPreview !== prev.hoverPreview) loop?.invalidateView();
    if (s.project === prev.project || !s.project) return;
    const compId = s.compId;
    // Another show (opened or started): nothing from before carries over.
    const same = prev.project?.id === s.project.id ? prev.project : null;
    let affected: Affected = ALL;
    if (same && compId && s.lastTx) affected = affectedByPatches(same, s.project, s.lastTx.patches, compId);
    const others = othersOf(same, s.project, s.lastTx?.patches ?? null, compId);
    if (compId) loop?.invalidate(compId, affected, others);
    window.be.sync.publishProject({ project: s.project, compId, affected, others } satisfies ProjectMessage);
  });
  const unsubTransport = startTransportPublishing();
  const unwatch = watchOutputs();
  const offRemote = window.be.sync.onTransport(applyTransport);
  // Publish the current state once so windows opened later start correctly.
  const s = useStudio.getState();
  if (s.project) window.be.sync.publishProject({ project: s.project, compId: s.compId, affected: { all: true, ranges: [] } } satisfies ProjectMessage);
  window.be.sync.publishTransport(transportOf());
  return () => {
    unsubProject();
    unwatch();
    unsubTransport();
    offRemote();
  };
};

/**
 * Follower: publish only what its own user did (play/pause, seek while paused, loop, range, from the
 * pop-out's keys): the editor takes it up and its clock leads from there. Never its clock (followers
 * would echo the editor's to each other).
 */
const startFollowerPublishing = (): (() => void) => {
  let last = useStudio.getState();
  return useStudio.subscribe((s) => {
    const changed = s.playing !== last.playing || s.loop !== last.loop || s.range !== last.range || (!s.playing && s.time !== last.time);
    last = s;
    if (changed && !applyingRemote) window.be.sync.publishTransport({ playing: s.playing, time: s.time, at: Date.now(), loop: s.loop, range: s.range });
  });
};

/** Follower side (pop-out preview, projector output): mirror the editor's project and clock. */
export const startFollowerSync = async (onProject?: (m: ProjectMessage) => void): Promise<() => void> => {
  const applyProject = (m: ProjectMessage) => {
    useStudio.setState({ project: m.project, compId: m.compId ?? m.project.mainCompId ?? m.project.compositionOrder[0] ?? null, screen: "studio" });
    if (m.compId) currentPreviewLoop()?.invalidate(m.compId, m.affected, m.others);
    onProject?.(m);
  };
  const hello = await window.be.sync.hello();
  if (hello.project) applyProject(hello.project as ProjectMessage);
  if (hello.transport) applyTransport(hello.transport);
  const off1 = window.be.sync.onProject((m) => applyProject(m as ProjectMessage));
  const off2 = window.be.sync.onTransport(applyTransport);
  const off3 = startFollowerPublishing();
  return () => {
    off1();
    off2();
    off3();
  };
};

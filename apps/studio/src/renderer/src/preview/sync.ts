/**
 * Keeps windows in step. The editor publishes the project (with exact invalidation info) and the
 * playback clock. Pop-out and projector windows follow, and their transport buttons publish back.
 * Echoes are suppressed so a change never bounces between windows.
 */
import { affectedByPatches, type Affected, type Project, FLICKS_PER_SECOND } from "@be/core";
import type { TransportState } from "../../../shared/api.ts";
import { useStudio } from "../studio/store.ts";
import { currentPreviewLoop } from "./PreviewPanel.tsx";

interface ProjectMessage {
  readonly project: Project;
  readonly compId: string | null;
  readonly affected: Affected;
}

let applyingRemote = false;

const transportOf = (): TransportState => {
  const s = useStudio.getState();
  return { playing: s.playing, time: s.time, at: Date.now(), loop: s.loop, range: s.range };
};

/** Publish transport changes (play/pause, seeks while paused, loop, range) and a heartbeat while playing. */
const startTransportPublishing = (): (() => void) => {
  let last = transportOf();
  const unsub = useStudio.subscribe((s) => {
    if (applyingRemote) return;
    const changed = s.playing !== last.playing || s.loop !== last.loop || s.range !== last.range || (!s.playing && s.time !== last.time);
    if (!changed) return;
    last = transportOf();
    window.be.sync.publishTransport(last);
  });
  const beat = setInterval(() => {
    if (useStudio.getState().playing) window.be.sync.publishTransport((last = transportOf()));
  }, 1000);
  return () => {
    unsub();
    clearInterval(beat);
  };
};

const applyTransport = (t: TransportState) => {
  applyingRemote = true;
  const elapsed = t.playing ? Math.round(((Date.now() - t.at) / 1000) * FLICKS_PER_SECOND) : 0;
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
    let affected: Affected = { all: true, ranges: [] };
    if (prev.project && compId && s.lastTx) affected = affectedByPatches(prev.project, s.project, s.lastTx.patches, compId);
    if (compId) loop?.invalidate(compId, affected);
    window.be.sync.publishProject({ project: s.project, compId, affected } satisfies ProjectMessage);
  });
  const unsubTransport = startTransportPublishing();
  const offRemote = window.be.sync.onTransport(applyTransport);
  // Publish the current state once so windows opened later start correctly.
  const s = useStudio.getState();
  if (s.project) window.be.sync.publishProject({ project: s.project, compId: s.compId, affected: { all: true, ranges: [] } } satisfies ProjectMessage);
  window.be.sync.publishTransport(transportOf());
  return () => {
    unsubProject();
    unsubTransport();
    offRemote();
  };
};

/** Follower side (pop-out preview, projector output): mirror the editor's project and clock. */
export const startFollowerSync = async (onProject?: (m: ProjectMessage) => void): Promise<() => void> => {
  const applyProject = (m: ProjectMessage) => {
    useStudio.setState({ project: m.project, compId: m.compId ?? m.project.mainCompId ?? m.project.compositionOrder[0] ?? null, screen: "studio" });
    if (m.compId) currentPreviewLoop()?.invalidate(m.compId, m.affected);
    onProject?.(m);
  };
  const hello = await window.be.sync.hello();
  if (hello.project) applyProject(hello.project as ProjectMessage);
  if (hello.transport) applyTransport(hello.transport);
  const off1 = window.be.sync.onProject((m) => applyProject(m as ProjectMessage));
  const off2 = window.be.sync.onTransport(applyTransport);
  const off3 = startTransportPublishing();
  return () => {
    off1();
    off2();
    off3();
  };
};

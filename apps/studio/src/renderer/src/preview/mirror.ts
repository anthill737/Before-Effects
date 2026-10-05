/**
 * The preview on the projector shows what the editor's preview shows: the same view, overlays,
 * preview size, selection, hovered area, step and projector. The editor publishes them whenever they
 * change; the window on the projector follows. (Project and clock come through sync.ts.)
 */
import { useStudio } from "../studio/store.ts";
import { useProjectorPick } from "../studio/projectors.ts";
import { type PreviewSettings, usePreview } from "./settings.ts";

const CHANNEL = "be-preview-mirror";
const PREVIEW_KEYS = ["view", "overlays", "orbit", "resolution", "autoFraction"] as const satisfies ReadonlyArray<keyof PreviewSettings>;

interface MirrorState {
  readonly preview: Partial<PreviewSettings>;
  readonly selection: ReturnType<typeof useStudio.getState>["selection"];
  readonly hoverRegionId: string | null;
  readonly step: ReturnType<typeof useStudio.getState>["step"];
  readonly projectorId: string | null;
}

const current = (): MirrorState => {
  const p = usePreview.getState();
  const s = useStudio.getState();
  return {
    preview: Object.fromEntries(PREVIEW_KEYS.map((k) => [k, p[k]])) as Partial<PreviewSettings>,
    selection: s.selection,
    hoverRegionId: s.hoverRegionId,
    step: s.step,
    projectorId: useProjectorPick.getState().id,
  };
};

/** Editor: publish what the preview shows. Returns a function that stops. */
export const publishMirror = (): (() => void) => {
  const ch = new BroadcastChannel(CHANNEL);
  let last = "";
  const send = (force = false) => {
    const state = current();
    const text = JSON.stringify(state);
    if (!force && text === last) return;
    last = text;
    ch.postMessage(state);
  };
  ch.onmessage = (e) => e.data === "hello" && send(true);
  const offs = [usePreview.subscribe(() => send()), useStudio.subscribe(() => send()), useProjectorPick.subscribe(() => send())];
  return () => {
    offs.forEach((off) => off());
    ch.close();
  };
};

/** The window on the projector: follow the editor's preview. Returns a function that stops. */
export const followMirror = (): (() => void) => {
  const ch = new BroadcastChannel(CHANNEL);
  ch.onmessage = (e) => {
    const m = e.data as MirrorState | "hello";
    if (m === "hello") return;
    usePreview.getState().set(m.preview);
    useStudio.setState({ selection: m.selection, hoverRegionId: m.hoverRegionId, step: m.step });
    useProjectorPick.setState({ id: m.projectorId });
  };
  ch.postMessage("hello");
  return () => ch.close();
};

/**
 * The pop-out preview window: the same preview panel, following the editor's project, clock and what
 * its preview shows. Full-screen on a projector ("clean") it is only the picture, with no controls.
 */
import { useEffect, useState } from "react";
import "../studio/styles.css";
import { useStudio } from "../studio/store.ts";
import { editorSource, PreviewPanel } from "./PreviewPanel.tsx";
import { followMirror } from "./mirror.ts";
import { startFollowerSync } from "./sync.ts";

const clean = !!(window as unknown as { beClean?: boolean }).beClean;

export const PopoutWindow = () => {
  const [ready, setReady] = useState(false);
  // On the projector the mouse shows while it moves (to point at the house) and hides when still.
  const [cursorShown, setCursorShown] = useState(true);
  useEffect(() => {
    if (!clean) return;
    let t = 0;
    const moved = () => {
      setCursorShown(true);
      clearTimeout(t);
      t = window.setTimeout(() => setCursorShown(false), 3000);
    };
    moved();
    window.addEventListener("mousemove", moved);
    return () => {
      clearTimeout(t);
      window.removeEventListener("mousemove", moved);
    };
  }, []);
  const project = useStudio((s) => s.project);
  useEffect(() => {
    let off: (() => void) | null = null;
    void startFollowerSync().then((o) => {
      off = o;
      setReady(true);
    });
    const offMirror = followMirror();
    const onKey = (e: KeyboardEvent) => {
      const s = useStudio.getState();
      if (e.key === "Escape" && clean) window.close();
      else if (e.key === " ") {
        e.preventDefault();
        s.setPlaying(!s.playing);
      } else if (e.key === "ArrowRight") s.stepFrames(e.shiftKey ? 10 : 1);
      else if (e.key === "ArrowLeft") s.stepFrames(e.shiftKey ? -10 : -1);
      else if (e.key === "Home") s.restart();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off?.();
      offMirror();
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  if (!ready || !project) return <div className="window-wait">Connecting to the editor…</div>;
  return (
    <div className={`popout ${clean ? "clean" : ""} ${cursorShown ? "" : "cursor-hidden"}`}>
      <PreviewPanel role="popout" source={editorSource} clean={clean} />
    </div>
  );
};

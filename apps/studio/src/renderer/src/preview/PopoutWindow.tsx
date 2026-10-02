/** The pop-out preview window: the same preview panel, following the editor's project and clock. */
import { useEffect, useState } from "react";
import "../studio/styles.css";
import { useStudio } from "../studio/store.ts";
import { editorSource, PreviewPanel } from "./PreviewPanel.tsx";
import { startFollowerSync } from "./sync.ts";

export const PopoutWindow = () => {
  const [ready, setReady] = useState(false);
  const project = useStudio((s) => s.project);
  useEffect(() => {
    let off: (() => void) | null = null;
    void startFollowerSync().then((o) => {
      off = o;
      setReady(true);
    });
    const onKey = (e: KeyboardEvent) => {
      const s = useStudio.getState();
      if (e.key === " ") {
        e.preventDefault();
        s.setPlaying(!s.playing);
      } else if (e.key === "ArrowRight") s.stepFrames(e.shiftKey ? 10 : 1);
      else if (e.key === "ArrowLeft") s.stepFrames(e.shiftKey ? -10 : -1);
      else if (e.key === "Home") s.restart();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off?.();
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  if (!ready || !project) return <div className="window-wait">Connecting to the editor…</div>;
  return (
    <div className="popout">
      <PreviewPanel role="popout" source={editorSource} />
    </div>
  );
};

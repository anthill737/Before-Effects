/** The guided route (Space → Content → Effects → Preview → Export/Play), undo/redo, and save state. */
import { usePreview } from "../preview/settings.ts";
import { type Step, useStudio } from "./store.ts";
import { saveProject } from "./persistence.ts";
import { AgentButton } from "./AgentPanel.tsx";
import { RendersButton } from "./RendersPanel.tsx";
import { DriveButton } from "./DrivePanel.tsx";
import { AssistantButton } from "./assistant/AssistantPanel.tsx";

const STEPS: Array<{ id: Step; label: string; hint: string }> = [
  { id: "space", label: "Areas", hint: "Trace the building's areas once — every scene uses them — and line up the projector" },
  { id: "content", label: "Content", hint: "Drag pictures, videos and animations onto areas" },
  { id: "animate", label: "Effects", hint: "Every effect in one place — light, 3D blocks, breaking apart, particles, picture effects — for parts of the building" },
  { id: "preview", label: "Preview", hint: "Watch the show on the building or as the projector sees it" },
  { id: "export", label: "Export or play", hint: "Save videos and projector files" },
];

/** Show or hide the side panels, as in other editors: one button for each, lit while it's shown. */
const PanelToggles = () => {
  const left = !usePreview((s) => s.leftCollapsed);
  const right = !usePreview((s) => s.rightCollapsed);
  const set = (k: "leftCollapsed" | "rightCollapsed", v: boolean) => usePreview.getState().set({ [k]: v });
  return (
    <div className="panel-toggles" role="group" aria-label="Panels">
      <button className={`panel-toggle ${left ? "on" : ""}`} aria-pressed={left} onClick={() => set("leftCollapsed", left)} title={`${left ? "Hide" : "Show"} the left panel (Ctrl+[)`} aria-label="Left panel">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" /><rect x="2" y="3" width="4" height="10" fill={left ? "currentColor" : "none"} /><line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" /></svg>
      </button>
      <button className={`panel-toggle ${right ? "on" : ""}`} aria-pressed={right} onClick={() => set("rightCollapsed", right)} title={`${right ? "Hide" : "Show"} the right panel (Ctrl+])`} aria-label="Right panel">
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" /><rect x="10" y="3" width="4" height="10" fill={right ? "currentColor" : "none"} /><line x1="10" y1="3" x2="10" y2="13" stroke="currentColor" /></svg>
      </button>
    </div>
  );
};

export const TopBar = () => {
  const step = useStudio((s) => s.step);
  const dirty = useStudio((s) => s.dirty);
  const filePath = useStudio((s) => s.filePath);
  const version = useStudio((s) => s.version);
  const h = useStudio((s) => s.history);
  void version;
  const fileName = filePath ? filePath.split(/[\\/]/).pop() : "Unsaved show";
  return (
    <header className="topbar">
      <div className="brand" aria-label="Before Effects">
        <span className="brand-mark" aria-hidden="true">◐</span> Before Effects
      </div>
      <nav className="route" aria-label="Steps">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            className={`route-step ${step === s.id ? "on" : ""}`}
            aria-current={step === s.id ? "step" : undefined}
            title={s.hint}
            onClick={() => {
              if (s.id === "export") useStudio.getState().setExportOpen(true);
              else useStudio.getState().setStep(s.id);
            }}
          >
            <span className="route-num">{i + 1}</span>
            {s.label}
          </button>
        ))}
      </nav>
      <div className="top-actions">
        <PanelToggles />
        <AssistantButton />
        <AgentButton />
        <DriveButton />
        <RendersButton />
        <button className="icon" disabled={!h?.canUndo} onClick={() => useStudio.getState().undo()} title={h?.undoLabel ? `Undo “${h.undoLabel}” (Ctrl+Z)` : "Nothing to undo"} aria-label="Undo">
          ↶
        </button>
        <button className="icon" disabled={!h?.canRedo} onClick={() => useStudio.getState().redo()} title={h?.redoLabel ? `Redo “${h.redoLabel}” (Ctrl+Y)` : "Nothing to redo"} aria-label="Redo">
          ↷
        </button>
        <button className="ghost" onClick={() => void saveProject(false)} title="Save (Ctrl+S)">
          {fileName}
          <span className={`save-state ${dirty || !filePath ? "dirty" : "clean"}`}>{!filePath ? "• not saved to a file yet" : dirty ? "• unsaved changes (backed up)" : "✓ saved"}</span>
        </button>
      </div>
    </header>
  );
};

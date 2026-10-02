/** The guided route (Space → Content → Animate → Preview → Export/Play), undo/redo, and save state. */
import { type Step, useStudio } from "./store.ts";
import { saveProject } from "./persistence.ts";
import { RendersButton } from "./RendersPanel.tsx";
import { AssistantButton } from "./assistant/AssistantPanel.tsx";

const STEPS: Array<{ id: Step; label: string; hint: string }> = [
  { id: "space", label: "Areas", hint: "Trace the building's areas once — every scene uses them — and line up the projector" },
  { id: "content", label: "Content", hint: "Drag pictures, videos and animations onto areas" },
  { id: "animate", label: "Animate", hint: "Pick effects for parts of the building" },
  { id: "preview", label: "Preview", hint: "Watch the show on the building or as the projector sees it" },
  { id: "export", label: "Export or play", hint: "Save videos and projector files" },
];

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
        <AssistantButton />
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

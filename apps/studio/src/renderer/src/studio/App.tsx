import { useEffect } from "react";
import "./styles.css";
import { editorSource, PreviewPanel } from "../preview/PreviewPanel.tsx";
import { usePreview } from "../preview/settings.ts";
import { startEditorSync } from "../preview/sync.ts";
import { startAudioSync } from "./audioEngine.ts";
import { AssistantPanel, startAssistant } from "./assistant/AssistantPanel.tsx";
import { useAssistant } from "./assistant/state.ts";
import { AeImportDialog } from "./AeImportDialog.tsx";
import { DropChooser } from "./DropChooser.tsx";
import { ScenesBar } from "./ScenesBar.tsx";
import { ExportDialog } from "./ExportDialog.tsx";
import { getRenderer } from "./engineHost.ts";
import { startSimHost } from "./simHost.ts";
import { Inspector } from "./Inspector.tsx";
import { Library } from "./Library.tsx";
import { openProjectFile, saveProject, startAutosave } from "./persistence.ts";
import { SpacePanel } from "../space/SpacePanel.tsx";
import { togglePlay } from "../preview/PreviewPanel.tsx";
import { ContentPanel } from "./ContentPanel.tsx";
import { PreviewSidePanel } from "./SidePanels.tsx";
import { useStudio } from "./store.ts";
import { Timeline } from "./Timeline.tsx";
import { TopBar } from "./TopBar.tsx";
import { Welcome } from "./Welcome.tsx";
import { startAgentHost } from "../agent/index.ts";
import { startFileDrop } from "./fileDrop.ts";

const Toasts = () => {
  const toasts = useStudio((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        // Passing notices never block clicks underneath; errors and notices with an action stay clickable.
        <div key={t.id} className={`toast ${t.kind} ${t.kind !== "error" && !t.action && !t.details ? "passing" : ""}`}>
          <span>{t.text}</span>
          {t.details && (
            <details>
              <summary>Details</summary>
              <pre>{t.details}</pre>
            </details>
          )}
          {t.action && (
            <button className="link" onClick={t.action.run}>
              {t.action.label}
            </button>
          )}
          <button className="icon small" aria-label="Dismiss" onClick={() => useStudio.getState().dismissToast(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
};

const isTyping = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

const useShortcuts = () => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStudio.getState();
      if (s.screen !== "studio" || s.exportOpen) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === "z" && !e.shiftKey) {
        if (isTyping(e)) return;
        e.preventDefault();
        s.undo();
      } else if (mod && (k === "y" || (k === "z" && e.shiftKey))) {
        if (isTyping(e)) return;
        e.preventDefault();
        s.redo();
      } else if (mod && k === "s") {
        e.preventDefault();
        void saveProject(e.shiftKey);
      } else if (mod && k === "k") {
        e.preventDefault();
        useAssistant.setState({ open: true });
        setTimeout(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask the assistant"]')?.focus(), 50);
      } else if (mod && k === "o") {
        e.preventDefault();
        void openProjectFile();
      } else if (isTyping(e)) {
        return;
      } else if (e.key === " " && !(e.target as HTMLElement)?.closest("button")) {
        e.preventDefault();
        togglePlay();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        s.stepFrames(e.shiftKey ? 10 : 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        s.stepFrames(e.shiftKey ? -10 : -1);
      } else if (e.key === "Home") {
        s.restart();
      } else if (k === "l" && !mod) {
        s.setLoop(!s.loop);
      } else if (k === "i" && !mod) {
        const c = s.project && s.compId ? s.project.compositions[s.compId] : undefined;
        if (c) s.setRange({ start: s.time, end: s.range?.end ?? c.duration });
      } else if (k === "o" && !mod) {
        s.setRange({ start: s.range?.start ?? 0, end: s.time });
      } else if (e.key === "`") {
        usePreview.getState().set({ maximized: !usePreview.getState().maximized });
      } else if (e.key === "Escape") {
        s.selectRegions([]);
        s.selectRecipe(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && s.selection.recipeId) {
        const inst = s.project?.recipes[s.selection.recipeId];
        if (inst) {
          s.apply({ type: "recipe.remove", args: { instanceId: inst.id } }, { label: `Remove ${inst.label}` });
          s.selectRecipe(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
};

const LeftPanel = () => {
  const step = useStudio((s) => s.step);
  const assistant = useAssistant((s) => s.open);
  if (assistant) return <AssistantPanel />;
  if (step === "space") return <SpacePanel />;
  if (step === "content") return <ContentPanel />;
  if (step === "preview") return <PreviewSidePanel />;
  return <Library />;
};

export const App = () => {
  const screen = useStudio((s) => s.screen);
  const maximized = usePreview((s) => s.maximized);
  const assistantOpen = useAssistant((s) => s.open);
  useShortcuts();
  useEffect(() => startAutosave(), []);
  // Photos and media dragged in from Explorer (works on the welcome screen too).
  useEffect(() => (window.be.app.kind === "editor" || window.be.app.kind === "uitest" ? startFileDrop() : undefined), []);
  // External agents (when Agent access is on) are served by the editor window, even before a show is open.
  useEffect(() => (window.be.app.kind === "editor" || window.be.app.kind === "uitest" ? startAgentHost() : undefined), []);
  useEffect(() => (screen === "studio" ? startEditorSync() : undefined), [screen]);
  useEffect(() => (screen === "studio" ? startAudioSync() : undefined), [screen]);
  useEffect(() => (screen === "studio" ? startAssistant() : undefined), [screen]);
  useEffect(() => (screen === "studio" ? startSimHost(getRenderer) : undefined), [screen]);
  if (screen === "welcome")
    return (
      <>
        <Welcome />
        <Toasts />
      </>
    );
  return (
    <div className={`studio ${maximized ? "maximized" : ""} ${assistantOpen ? "assistant-open" : ""}`}>
      <TopBar />
      <div className="workspace">
        {!maximized && <LeftPanel />}
        <main className="center">
          <PreviewPanel role="editor" source={editorSource} />
        </main>
        {!maximized && <Inspector />}
      </div>
      <ScenesBar />
      <Timeline />
      <ExportDialog />
      <AeImportDialog />
      <DropChooser />
      <Toasts />
    </div>
  );
};

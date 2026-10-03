/** First launch: one question — what would you like to make? */
import type { Project } from "@be/core";
import { useEffect, useState } from "react";
import { createProjectFromPhoto } from "../space/actions.ts";
import { openAfterEffectsProject } from "./aeImport.ts";
import { AeImportDialog } from "./AeImportDialog.tsx";
import { openPackageFromDrive, plainError } from "./drive.ts";
import { checkRecovery, openProjectFile } from "./persistence.ts";
import { useStudio } from "./store.ts";

export const Welcome = () => {
  const [recovery, setRecovery] = useState<{ project: Project; savedAt: string } | null>(null);
  useEffect(() => {
    void checkRecovery().then(setRecovery);
  }, []);
  return (
    <main className="welcome">
      <h1>
        <span className="brand-mark" aria-hidden="true">◐</span> Before Effects
      </h1>
      <p className="lede">Make buildings, rooms and objects come alive with projected light.</p>
      <h2>What would you like to make?</h2>
      <div className="welcome-cards">
        <button className="welcome-card featured" onClick={() => useStudio.getState().openSample()} autoFocus>
          <span className="wc-icon" aria-hidden="true">▶</span>
          <strong>Try the sample town hall</strong>
          <span>Opens already playing. Click any window or edge to change it.</span>
        </button>
        <button className="welcome-card" onClick={() => void createProjectFromPhoto()} aria-describedby="photo-note">
          <span className="wc-icon" aria-hidden="true">📷</span>
          <strong>My building or object, from a photo</strong>
          <span id="photo-note">Choose a straight-on photo, then trace windows, edges and surfaces over it.</span>
        </button>
        <button className="welcome-card" onClick={() => void openAfterEffectsProject()}>
          <span className="wc-icon" aria-hidden="true">Ae</span>
          <strong>An After Effects project</strong>
          <span>Opens .aep files directly, no After Effects needed. You get a report of anything that differs.</span>
        </button>
        <button className="welcome-card" disabled>
          <span className="wc-icon" aria-hidden="true">⬚</span>
          <strong>A 3D model of my venue</strong>
          <span>Import glTF / OBJ / FBX — coming in a later version.</span>
        </button>
      </div>
      <div className="welcome-secondary">
        <button className="ghost" onClick={() => void openProjectFile()}>
          Open a saved show…
        </button>
        <button
          className="ghost"
          title="A show saved to Google Drive with “Save show to Drive”: its media are copied to this computer"
          onClick={() => void openPackageFromDrive().catch((e) => useStudio.getState().toast({ kind: "error", text: plainError(e) }))}
        >
          Open a show from Google Drive…
        </button>
        {recovery && (
          <button
            className="ghost warn-ghost"
            onClick={() => {
              useStudio.getState().openProject(recovery.project, null);
              useStudio.getState().toast({ kind: "info", text: "Recovered your unsaved work. Save it to keep it." });
            }}
          >
            Recover unsaved work from {new Date(recovery.savedAt).toLocaleString()}
          </button>
        )}
      </div>
      <AeImportDialog />
      <p className="muted small foot">A photo helps you trace surfaces; it doesn't measure the building in 3D. You'll line things up with the projector later — or skip that and just export videos.</p>
    </main>
  );
};

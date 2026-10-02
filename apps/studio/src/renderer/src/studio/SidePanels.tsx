/** Left panels for the Space, Content and Preview steps (Animate uses the effects library). */
import { newLayer, type RegionKind, secondsToTime, staticProp } from "@be/core";
import { usePreview } from "../preview/settings.ts";
import { applyRecipeToSelection, KIND_LABEL } from "./actions.ts";
import { activeVenue, currentComp, useStudio } from "./store.ts";


export const PreviewSidePanel = () => {
  const comp = currentComp(useStudio.getState());
  const view = usePreview((s) => s.view);
  return (
    <aside className="panel" aria-label="Preview">
      <div className="panel-head">
        <h2>Preview</h2>
      </div>
      <ul className="plain small">
        <li>
          <strong>Show preview</strong> is the show exactly as it will be exported.
        </li>
        <li>
          <strong>3D projection</strong> puts your light on a model of the building. Drag to orbit, right-drag to pan, use the wheel to zoom.
        </li>
        <li>
          <strong>Projector output</strong> is what the projector receives, after alignment and output corrections.
        </li>
      </ul>
      <p className="muted small">
        The 3D view multiplies your light by the photo's colours to suggest the look. It's a design aid: a real wall, projector brightness and street lighting will differ.
      </p>
      <div className="row gap wrap">
        <button
          className="primary"
          onClick={() => {
            useStudio.getState().restart();
            useStudio.getState().setPlaying(true);
          }}
        >
          ▶ Play from the start
        </button>
        {view !== "3d" && (
          <button className="ghost" onClick={() => usePreview.getState().set({ view: "3d" })}>
            See it in 3D
          </button>
        )}
      </div>
      <label className="row-field" title="How much street or room light falls on the building in the 3D view">
        <span>Surroundings in 3D</span>
        <input type="range" min={0} max={0.4} step={0.01} value={usePreview.getState().ambient} onChange={(e) => usePreview.getState().set({ ambient: Number(e.target.value) })} aria-label="Ambient light in the 3D view" />
      </label>
      {comp && <p className="muted small">Show length: {Math.round(comp.duration / secondsToTime(1))} s</p>}
    </aside>
  );
};

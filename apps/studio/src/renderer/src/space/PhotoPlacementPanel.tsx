/**
 * "Photo in the frame": how the building photo sits in the show's canvas — fit (all of it) or fill
 * (cover), size, position and crop. Never stretched. Best done before tracing: traced areas are the
 * physical mapping targets and don't move with the photo.
 */
import { DEFAULT_PLACEMENT, placePhoto } from "@be/core";
import { useState } from "react";
import { Slider } from "../studio/controls.tsx";
import { activeVenue, useStudio } from "../studio/store.ts";
import { resetPlacement, setPlacement } from "./photoPlacement.ts";

export const PhotoPlacementPanel = () => {
  const project = useStudio((s) => s.project)!;
  const venue = activeVenue({ project });
  const [open, setOpen] = useState(false);
  if (!venue?.photo) return null;
  const photo = project.assets[venue.photo.assetId];
  const p = venue.photo.placement;
  if (!photo?.meta.width || !photo.meta.height) return null;
  const placed = placePhoto({ width: photo.meta.width, height: photo.meta.height }, venue.canvas, p);
  const cropped = p.crop.left + p.crop.right + p.crop.top + p.crop.bottom > 0;
  const bars = placed.dest.x > 1 || placed.dest.y > 1 || placed.dest.x + placed.dest.w < venue.canvas.width - 1 || placed.dest.y + placed.dest.h < venue.canvas.height - 1;
  const pct = (v: number) => Math.round(v * 100);
  return (
    <section className="param-group photo-placement">
      <button className="disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
        Photo in the frame
      </button>
      {open && (
        <>
          <p className="muted small">
            {photo.meta.width}×{photo.meta.height} photo in a {venue.canvas.width}×{venue.canvas.height} show{bars ? " (dark bars where the shapes differ)" : ""}{cropped ? ", cropped" : ""}. Never stretched. The original file is kept unchanged.
          </p>
          {venue.regionOrder.length > 0 && <p className="warn small">Your traced areas stay put when the photo moves — they're the projector's targets. Place the photo first, then trace.</p>}
          <div className="segmented" role="radiogroup" aria-label="Photo fit">
            {(["fit", "fill"] as const).map((f) => (
              <button key={f} role="radio" aria-checked={p.fit === f} className={p.fit === f ? "on" : ""} onClick={() => void setPlacement({ fit: f }, { now: true })}>
                {f === "fit" ? "Show all of it" : "Fill the frame"}
              </button>
            ))}
          </div>
          <label className="field-label small">Size</label>
          <Slider label="Photo size" value={p.scale} min={50} max={300} step={1} unit="%" onChange={(v) => void setPlacement({ scale: v })} />
          <label className="field-label small">Left / right</label>
          <Slider label="Photo left/right" value={p.offsetX} min={-venue.canvas.width / 2} max={venue.canvas.width / 2} step={1} unit="px" onChange={(v) => void setPlacement({ offsetX: v })} />
          <label className="field-label small">Up / down</label>
          <Slider label="Photo up/down" value={p.offsetY} min={-venue.canvas.height / 2} max={venue.canvas.height / 2} step={1} unit="px" onChange={(v) => void setPlacement({ offsetY: v })} />
          {(["left", "right", "top", "bottom"] as const).map((edge) => (
            <div key={edge}>
              <label className="field-label small">Crop {edge}</label>
              <Slider label={`Crop photo ${edge}`} value={pct(p.crop[edge])} min={0} max={45} step={1} unit="%" onChange={(v) => void setPlacement({ crop: { ...p.crop, [edge]: v / 100 } })} />
            </div>
          ))}
          <button className="ghost small-btn" disabled={JSON.stringify(p) === JSON.stringify(DEFAULT_PLACEMENT)} onClick={() => void resetPlacement()}>
            Reset placement
          </button>
        </>
      )}
    </section>
  );
};

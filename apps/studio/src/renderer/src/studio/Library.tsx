/**
 * Effects library: organised by what people want to create, searchable in everyday words,
 * with animated thumbnails and a live preview on the selected regions while hovering.
 */
import { listRecipes, plannedFor, type RecipeCategory, type RecipeDef, searchRecipes } from "@be/core";
import { useMemo, useState } from "react";
import { applyEffect, applyRecipeToSelection, previewRecipe } from "./actions.ts";
import { setDragPayload } from "./assign.ts";
import { useStudio } from "./store.ts";

const CATEGORY_LABEL: Partial<Record<RecipeCategory, string>> = {
  light: "Light",
  color: "Color",
  water: "Water",
  fire: "Fire-like",
  cracks: "Cracks & breaking",
  movement: "Movement",
  patterns: "Patterns",
  depth: "Depth",
  text: "Text",
  particles: "Particles",
  transitions: "Transitions",
};

/** Small looping animations that show what an effect does (pure CSS/SVG, no video files). */
export const Thumb = ({ id }: { id: string }) => {
  const win = (x: number, y: number, i: number, cls: string) => <rect key={i} x={x} y={y} width="14" height="18" rx="1.5" className={cls} style={{ animationDelay: `${i * 0.18}s` }} />;
  const grid = (cls: string) => [0, 1, 2, 3].flatMap((c) => [0, 1].map((r) => win(10 + c * 22, 12 + r * 26, c * 2 + r, cls)));
  return (
    <svg className={`thumb thumb-${id}`} viewBox="0 0 100 64" aria-hidden="true">
      <rect x="4" y="6" width="92" height="54" rx="3" className="thumb-wall" />
      {id === "edge-trace" && <rect x="10" y="12" width="80" height="42" rx="2" className="thumb-trace" pathLength={100} />}
      {id === "neon-outline" && <rect x="10" y="12" width="80" height="42" rx="2" className="thumb-neon" />}
      {id === "sequence-light-up" && grid("thumb-seq")}
      {id === "pulse" && grid("thumb-pulse")}
      {id === "color-wash" && grid("thumb-wash")}
    </svg>
  );
};

export const Library = () => {
  const [q, setQ] = useState("");
  const selection = useStudio((s) => s.selection.regionIds);
  const hits = useMemo(() => searchRecipes(q), [q]);
  const groups = useMemo(() => {
    const m = new Map<RecipeCategory, RecipeDef[]>();
    for (const h of hits) m.set(h.recipe.category, [...(m.get(h.recipe.category) ?? []), h.recipe]);
    return [...m];
  }, [hits]);
  const planned = q.trim() && hits.length === 0 ? plannedFor(q) : null;

  return (
    <aside className="panel library" aria-label="Effects">
      <div className="panel-head">
        <h2>Effects</h2>
        <span className="muted small">{listRecipes().length} available</span>
      </div>
      <input
        id="library-search"
        className="search"
        type="search"
        placeholder="Describe it… e.g. “glowing edges”"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search effects in your own words"
      />
      <p className="muted small hint">{selection.length ? `Click an effect to add it to the ${selection.length} selected part${selection.length > 1 ? "s" : ""}. Hover to preview.` : "Select areas first, then pick an effect — or drag an effect onto an area."}</p>
      {hits.length === 0 && (
        <div className="empty">
          <p>No effect matches “{q}” yet.</p>
          {planned && <p className="muted small">{planned}</p>}
        </div>
      )}
      {groups.map(([cat, recipes]) => (
        <section key={cat} className="lib-group">
          <h3>{CATEGORY_LABEL[cat] ?? cat}</h3>
          {recipes.map((r) => (
            <button
              key={r.id}
              className="lib-card"
              draggable
              onDragStart={(e) => setDragPayload(e, { kind: "effect", id: r.id })}
              onClick={() => void applyEffect(r.id)}
              onPointerEnter={() => previewRecipe(r.id)}
              onPointerLeave={() => previewRecipe(null)}
              onFocus={() => previewRecipe(r.id)}
              onBlur={() => previewRecipe(null)}
              aria-label={`${r.title}: ${r.description}`}
            >
              <Thumb id={r.id} />
              <span className="lib-text">
                <strong>{r.title}</strong>
                <span className="muted small">{r.description}</span>
              </span>
            </button>
          ))}
        </section>
      ))}
    </aside>
  );
};

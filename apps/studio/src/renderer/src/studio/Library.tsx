/**
 * The Effects tab: every effect in one place — light recipes, 3D blocks, breaking apart, particles and
 * picture effects — organised by what people want to create, searchable in everyday words, with
 * thumbnails and (for light recipes) a live preview on the selected regions while hovering.
 */
import { listRecipes, plannedFor, type RecipeCategory, type RecipeDef, searchRecipes } from "@be/core";
import { useMemo, useState } from "react";
import { applyEffect, applyRecipeToSelection, previewRecipe } from "./actions.ts";
import { setDragPayload } from "./assign.ts";
import { CATALOG, type CatalogEffect, EFFECT_GROUPS, searchCatalog } from "./effectCatalog.ts";
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
      {id.startsWith("blocks-") &&
        [0, 1, 2, 3, 4, 5].flatMap((c) => [0, 1, 2].map((r) => <rect key={`${c}-${r}`} x={11 + c * 13.5} y={12 + r * 14} width="11" height="11.5" className={(c + r) % 3 === 0 ? "thumb-block up" : "thumb-block"} />))}
      {(id.endsWith("-3d") || id === "collapse-3d") && <path d="M20 14 L38 30 L30 44 L50 52 M38 30 L62 24 L80 40 M62 24 L58 12" className="thumb-crack" />}
      {id.startsWith("particles-") && [12, 28, 44, 60, 76, 22, 52, 70, 36].map((x, i) => <circle key={i} cx={x + 4} cy={14 + ((i * 17) % 40)} r={i % 2 ? 1.6 : 2.4} className="thumb-dot" />)}
      {id === "melt-area" && <path d="M14 14 H86 V30 Q80 44 74 30 Q68 52 60 30 Q52 40 44 30 Q36 56 28 30 Q22 40 14 30 Z" className="thumb-melt" />}
      {id === "ripple-area" && [6, 13, 20].map((r) => <ellipse key={r} cx="50" cy="33" rx={r * 1.6} ry={r * 0.8} className="thumb-ripple" />)}
      {id === "glitch-area" && [14, 24, 34, 44].map((y, i) => <rect key={y} x={10 + ((i * 13) % 20)} y={y} width={60 - i * 6} height="6" className={i % 2 ? "thumb-glitch b" : "thumb-glitch"} />)}
      {id === "lightning" && (
        <>
          <rect x="4" y="6" width="92" height="54" rx="3" className="thumb-flash" />
          <path d="M52 4 L44 22 L54 26 L40 46 L48 49 L38 62 M44 22 L34 30 M54 26 L64 34 L60 40" className="thumb-bolt" />
        </>
      )}
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
  const extra = useMemo(() => searchCatalog(q), [q]);
  const extraGroups = EFFECT_GROUPS.map((g) => [g, extra.filter((e) => e.group === g)] as const).filter(([, list]) => list.length > 0);
  const planned = q.trim() && hits.length === 0 && extra.length === 0 ? plannedFor(q) : null;
  const applyExtra = (e: CatalogEffect) => {
    if (e.needsAreas && !selection.length) return useStudio.getState().toast({ kind: "info", text: `Select areas first, or drag “${e.title}” onto an area.` });
    e.apply(selection);
  };

  return (
    <aside className="panel library" aria-label="Effects">
      <div className="panel-head">
        <h2>Effects</h2>
        <span className="muted small">{listRecipes().length + CATALOG.length} available</span>
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
      {hits.length === 0 && extra.length === 0 && (
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
      {extraGroups.map(([group, list]) => (
        <section key={group} className="lib-group">
          <h3>{group}</h3>
          {list.map((e) => (
            <button
              key={e.id}
              className="lib-card"
              draggable
              onDragStart={(ev) => setDragPayload(ev, { kind: "effect", id: e.id })}
              onClick={() => applyExtra(e)}
              aria-label={`${e.title}: ${e.description}`}
              title={`${e.description} (${e.kind})`}
            >
              <Thumb id={e.id} />
              <span className="lib-text">
                <strong>
                  {e.title} <span className="badge">{e.kind.startsWith("physical") ? "physical" : "procedural"}</span>
                </strong>
                <span className="muted small">{e.description}</span>
              </span>
            </button>
          ))}
        </section>
      ))}
    </aside>
  );
};

/**
 * Property paths: dotted addresses into a layer such as "transform.opacity", "source.color",
 * "effects.fx_12.params.radius" or "masks.mask_3.feather". When a segment meets an array, it
 * matches an element by `id`, or by index when the segment is numeric. Paths are stable across
 * reordering, which keeps override records and AI references valid.
 */
export const splitPath = (path: string): string[] => path.split(".").filter(Boolean);

const step = (node: unknown, seg: string): unknown => {
  if (node == null) return undefined;
  if (Array.isArray(node)) {
    if (/^\d+$/.test(seg)) return node[Number(seg)];
    return node.find((x) => x && typeof x === "object" && (x as { id?: unknown }).id === seg);
  }
  if (typeof node === "object") return (node as Record<string, unknown>)[seg];
  return undefined;
};

export const getAt = (root: unknown, path: string | readonly string[]): unknown => {
  const segs = typeof path === "string" ? splitPath(path) : path;
  let node = root;
  for (const s of segs) node = step(node, s);
  return node;
};

/** Set a value at a path inside a mutable (Immer draft) object. Returns false if the parent is missing. */
export const setAt = (root: unknown, path: string | readonly string[], value: unknown): boolean => {
  const segs = typeof path === "string" ? splitPath(path) : [...path];
  const last = segs.pop();
  if (last === undefined) return false;
  const parent = getAt(root, segs);
  if (parent == null || typeof parent !== "object") return false;
  if (Array.isArray(parent)) {
    if (/^\d+$/.test(last)) {
      parent[Number(last)] = value;
      return true;
    }
    const i = parent.findIndex((x) => x && typeof x === "object" && (x as { id?: unknown }).id === last);
    if (i < 0) return false;
    parent[i] = value;
    return true;
  }
  (parent as Record<string, unknown>)[last] = value;
  return true;
};

/** True if `path` equals `prefix` or lies underneath it ("transform" covers "transform.opacity"). */
export const pathCovers = (prefix: string, path: string): boolean => path === prefix || path.startsWith(`${prefix}.`);

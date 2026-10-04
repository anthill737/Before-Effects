/**
 * Simulations in the studio: prepared frames live on disk (Cache\sims\<key>\), and the editor
 * window prepares any simulation in the show in the background — a few milliseconds per tick,
 * pausing briefly after each edit so dragging a slider doesn't restart work on every step.
 * Progress is shown in the Inspector and the preview; preview and export read the same frames.
 */
import { type ResolvedPhysics, resolveScene3DLayer, resolveSimulationLayer, type ResolvedSim, scene3dLayers, simulationLayers } from "@be/core";
import type { SimStore } from "@be/engine";
import { create } from "zustand";
import { useStudio } from "./store.ts";

export interface SimStatus {
  readonly done: number;
  readonly total: number;
  readonly preparing: boolean;
}

/** Progress per simulation layer id. */
export const useSims = create<{ status: Record<string, SimStatus> }>(() => ({ status: {} }));

let cacheDir: Promise<string> | null = null;
const dirFor = () => (cacheDir ??= window.be.app.paths().then((p) => `${p.cache}\\sims`));

export const simStore = (): SimStore => ({
  async read(key, name) {
    const path = `${await dirFor()}\\${key}\\${name}`;
    if (!(await window.be.files.exists(path))) return null;
    try {
      return await window.be.files.readFile(path);
    } catch {
      return null;
    }
  },
  async write(key, name, data) {
    await window.be.files.writeBinary(`${await dirFor()}\\${key}\\${name}`, data);
  },
});

const frameListeners = new Set<() => void>();
/** Redraw views when simulation frames arrive (prepared or loaded). Returns an unsubscribe. */
export const onSimFrame = (cb: () => void): (() => void) => {
  frameListeners.add(cb);
  return () => frameListeners.delete(cb);
};
let notifyQueued = false;
export const notifySimFrame = () => {
  if (notifyQueued) return;
  notifyQueued = true;
  setTimeout(() => {
    notifyQueued = false;
    for (const cb of frameListeners) cb();
  }, 33);
};

/** Background preparation in the editor window. */
export const startSimHost = (getRenderer: () => Promise<{ sims: import("@be/engine").SimEngine | null; physics: import("@be/engine").PhysicsEngine | null }>): (() => void) => {
  let stopped = false;
  let lastVersion = -1;
  let changedAt = 0;
  // What the show needs prepared, worked out again only when the show changes: resolving every
  // simulation and 3D layer on each tick (every 16 ms while playing) takes the editor's time from
  // playback itself.
  let resolvedFor: unknown = null;
  let simsNow: Array<{ layerId: string; sim: ResolvedSim }> = [];
  let worldsNow: Array<{ layerId: string; p: ResolvedPhysics }> = [];
  const tick = async () => {
    if (stopped) return;
    let delay = 120;
    try {
      const s = useStudio.getState();
      const r = await getRenderer();
      const engine = r.sims;
      if (s.project && engine) {
        if (s.version !== lastVersion) {
          lastVersion = s.version;
          changedAt = performance.now();
        }
        const physics = r.physics;
        if (resolvedFor !== s.project || simsNow.length + worldsNow.length === 0) {
          resolvedFor = s.project;
          // The scene being edited first.
          const first = <T extends { compId: string }>(list: T[]) => list.sort((a, b) => Number(b.compId === s.compId) - Number(a.compId === s.compId));
          simsNow = [];
          for (const l of first(simulationLayers(s.project))) {
            const sim = resolveSimulationLayer(s.project, l.compId, l.layerId);
            if (sim) simsNow.push({ layerId: l.layerId, sim });
          }
          worldsNow = [];
          if (physics)
            for (const l of first(scene3dLayers(s.project))) {
              const p = resolveScene3DLayer(s.project, l.compId, l.layerId)?.physics;
              if (p) worldsNow.push({ layerId: l.layerId, p });
            }
        }
        const sims = simsNow;
        engine.retain(new Set(sims.map((x) => x.sim.key)));
        const status: Record<string, SimStatus> = {};
        let next: ResolvedSim | null = null;
        for (const { layerId, sim } of sims) {
          const st = await engine.status(sim);
          status[layerId] = { done: st.done, total: st.total, preparing: false };
          if (!next && st.done < st.total) next = sim;
        }
        const settled = performance.now() - changedAt > 450;
        // 3D physics motion: prepared the same way, after the simulations.
        const worlds = worldsNow;
        if (physics) {
          physics.retain(new Set(worlds.map((w) => w.p.key)));
          for (const { layerId, p } of worlds) {
            const pr = physics.progress(p);
            status[layerId] = { done: pr.done, total: pr.total, preparing: false };
          }
        }
        const nextWorld = worlds.find((w) => physics!.progress(w.p).done < w.p.frames);
        if (next && settled) {
          // Leave room for smooth playback while preparing.
          const p = await engine.prepare(next, s.playing ? 8 : 24);
          for (const { layerId, sim } of sims) if (sim.key === next.key) status[layerId] = { done: p.done, total: p.total, preparing: p.done < p.total };
          delay = s.playing ? 16 : 0;
        } else if (nextWorld && physics && settled) {
          const p = await physics.prepare(nextWorld.p, s.playing ? 8 : 30);
          for (const w of worlds) if (w.p.key === nextWorld.p.key) status[w.layerId] = { done: p.done, total: p.total, preparing: p.done < p.total };
          notifySimFrame();
          delay = s.playing ? 16 : 0;
        } else if (next || nextWorld) delay = 100;
        useSims.setState({ status });
      }
    } catch (e) {
      window.be.app.log(`simulation preparation stopped: ${String((e as Error)?.message ?? e)}`);
      delay = 2000;
    }
    if (!stopped) setTimeout(() => void tick(), delay);
  };
  void tick();
  return () => {
    stopped = true;
  };
};

/** Combined progress of the given simulation layers (or all), for status lines. */
export const simProgress = (status: Record<string, SimStatus>, layerIds?: readonly string[]): { done: number; total: number; count: number } | null => {
  const list = Object.entries(status).filter(([id]) => !layerIds || layerIds.includes(id)).map(([, v]) => v);
  if (!list.length) return null;
  return { done: list.reduce((s, v) => s + v.done, 0), total: list.reduce((s, v) => s + v.total, 0), count: list.length };
};

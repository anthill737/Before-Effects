/**
 * Cache recommendations for this computer (shared/cachePlan.ts), with what the editor knows: the
 * graphics card and memory, the drive preview frames go on, the scene being edited and the show,
 * and how large prepared frames have turned out to be.
 */
import type { Project } from "@be/core";
import { useEffect, useState } from "react";
import type { CacheSpace, MachineMemory } from "../../../shared/api.ts";
import { type CachePlan, type Footage, type Hardware, recommendCache } from "../../../shared/cachePlan.ts";
import { useStudio } from "../studio/store.ts";
import { measuredBytesPerPixel } from "./prepare.ts";
import { usePreview } from "./settings.ts";

let machine: Promise<MachineMemory | null> | null = null;
export const machineInfo = (): Promise<MachineMemory | null> => (machine ??= window.be.cache.machine().catch(() => null));

/** The scene being edited and the show (when there is one), as things to prepare. */
export const footageOf = (project: Project | null, compId: string | null): Footage[] => {
  if (!project) return [];
  const out: Footage[] = [];
  const add = (id: string | null | undefined, label: (n: string) => string) => {
    const c = id ? project.compositions[id] : undefined;
    if (!c || out.some((f) => f.name === label(c.name))) return;
    out.push({ name: label(c.name), width: c.width, height: c.height, fps: c.frameRate.num / c.frameRate.den, seconds: c.duration / 705_600_000 });
  };
  const show = project.compositionOrder.map((id) => project.compositions[id]).find((c) => c?.show);
  if (compId && compId !== show?.id) add(compId, (n) => n);
  add(show?.id, (n) => n);
  return out;
};

export interface PlanContext {
  readonly hardware: Hardware;
  readonly space: CacheSpace | null;
  readonly plan: CachePlan;
}

/** The recommendation now (asks the desktop process for the machine and drive). */
export const computePlan = async (): Promise<PlanContext> => {
  const [m, space] = await Promise.all([machineInfo(), window.be.cache.space().catch(() => null)]);
  const s = useStudio.getState();
  const bpp = measuredBytesPerPixel();
  const hardware: Hardware = {
    ramBytes: m?.ramBytes ?? 8 * 1024 ** 3,
    gpu: m?.gpu ?? null,
    ...(m?.cpuCores ? { cpuCores: m.cpuCores } : {}),
    drive: space ? { path: space.drive.replace(/\\$/, ""), freeBytes: space.freeBytes, totalBytes: space.totalBytes } : null,
    cacheUsedBytes: space?.usedBytes ?? 0,
    ...(bpp ? { diskBytesPerPixel: bpp } : {}),
  };
  return { hardware, space, plan: recommendCache(hardware, footageOf(s.project, s.compId)) };
};

/** The recommendation, kept current while the settings are open. */
export const useCachePlan = (): PlanContext | null => {
  const [ctx, setCtx] = useState<PlanContext | null>(null);
  const project = useStudio((s) => s.project);
  const compId = useStudio((s) => s.compId);
  const diskGB = usePreview((s) => s.diskCacheGB);
  useEffect(() => {
    let live = true;
    void computePlan().then((c) => live && setCtx(c));
    return () => {
      live = false;
    };
    // The show's length and the disk cache's use change the recommendation.
  }, [project?.id, compId, project && compId ? project.compositions[compId]?.duration : 0, diskGB]);
  return ctx;
};

/** Use the recommended amounts (every one stays adjustable afterwards). */
export const applyPlan = (plan: CachePlan) =>
  usePreview.getState().set({ cacheBudgetMB: plan.frameCacheMB, videoCacheMB: plan.videoCacheMB, diskCache: true, diskCacheGB: plan.diskCacheGB, playbackMode: plan.playbackMode });

/** Do the current settings already match the recommendation? */
export const matchesPlan = (plan: CachePlan): boolean => {
  const s = usePreview.getState();
  return s.cacheBudgetMB === plan.frameCacheMB && s.videoCacheMB === plan.videoCacheMB && s.diskCache && s.diskCacheGB === plan.diskCacheGB;
};

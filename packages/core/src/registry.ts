import { projectionOps } from "./projection.ts";
import { coreOps } from "./ops-library.ts";
import { type OpDef, OpRegistry } from "./ops.ts";
import { recipeOps } from "./recipes.ts";
import { sceneOps } from "./scenes.ts";
import { world3dOps } from "./world3d.ts";
import { blenderOps } from "./blender.ts";
import "./recipes-builtin.ts";

/** Every operation available to the UI, scripts and the assistant. */
export const createRegistry = (): OpRegistry => new OpRegistry().register(...([...coreOps, ...recipeOps, ...sceneOps, ...world3dOps, ...blenderOps, ...projectionOps] as readonly OpDef[]));

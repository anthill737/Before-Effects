/** External-agent API (editor side): registers every method and starts serving calls. */
import "./methods-show.ts";
import "./methods-media.ts";
import "./methods-house.ts";
import "./methods-blender.ts";
import "./methods-projectors.ts";
export { currentRevision, dispatch, startAgentHost } from "./core.ts";

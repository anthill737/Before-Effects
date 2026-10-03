/**
 * A separate profile: with BE_PROFILE_DIR set, settings, logs, the one-at-a-time lock and the agent
 * connection file live there instead — so a second copy (e.g. a build being tested) can run beside
 * the one in use without touching it. Imported first, before anything reads these paths.
 */
import { join } from "node:path";
import { app } from "electron";

const dir = process.env.BE_PROFILE_DIR;
if (dir) {
  app.setPath("appData", dir);
  app.setPath("userData", join(dir, "Before Effects"));
}

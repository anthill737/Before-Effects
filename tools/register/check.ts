/** pnpm register:check — validate the capability register; exits non-zero on errors. */
import { loadRegister } from "./load.ts";

const { entries, errors, warnings } = loadRegister();
for (const w of warnings) console.warn(`warning: ${w}`);
for (const e of errors) console.error(`error: ${e}`);
console.log(`${entries.length} entries, ${errors.length} errors, ${warnings.length} warnings`);
process.exit(errors.length ? 1 : 0);

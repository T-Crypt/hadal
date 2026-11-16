// The isolated HADAL install and folders the tests share. `helpers.ts` imports this first, before anything from src/
// loads: a static import of the app after it (not a dynamic one) is what Node 26 orders correctly when a test also
// imports src/ modules that import the app.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const root = mkdtempSync(join(tmpdir(), "hadal-test-"));
// Isolate from the real HADAL install: its auth, settings, skills, and Lancet Guard.
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

// HADAL reads `HADAL_<name>` before the `PI_POCKET_<name>` it still honours, and `npm test` run from inside HADAL
// inherits its server's environment: HADAL_DIR there names the real data folder, HADAL_GUARD its guard, and the rest say
// the process runs under the launcher. A test that means to set one of these under the older name would otherwise lose
// to the inherited one. Cleared, not copied: the opt-ins a person sets for a test run (PI_POCKET_SHOTS, the Anthropic
// client version) are left alone.
for (const name of [
    "DIR",
    "GUARD",
    "BROWSER_ARGS",
    "LAUNCHER",
    "SUPERVISED",
    "ROLLBACK",
    "NPM_ROLLBACK",
]) {
    delete process.env[`HADAL_${name}`];
    delete process.env[`PI_POCKET_${name}`];
}

process.env.PI_POCKET_GUARD = "off";
// And from the real data folder, for code that reads its default rather than the app's own `dataDir`. Both names, or the
// inherited `HADAL_DIR` wins and the tests write into the running install.
process.env.HADAL_DIR = join(root, "hadal");
process.env.PI_POCKET_DIR = join(root, "hadal");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
/** The folder test sessions work in. */
export const work = join(root, "work");
mkdirSync(work);
/** The home folder the app finds `~/.agents/skills` in, for the same isolation. */
export const home = join(root, "home");
mkdirSync(home);

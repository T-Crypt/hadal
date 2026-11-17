/**
 * Every user-visible name in one place, so the product can be renamed in one change. Stored ids keep their old names
 * on purpose (see the note in docs.ts): `pocket.*` document kinds, the `pocket_auth` cookie, `pocket.*` localStorage
 * keys and `pocket-*` reserved extension names.
 */
export const NAME = "HADAL";
/** The agent, in copy. */
export const AGENT = "Hadal";
/** The assistant that watches the other sessions (was PiP). */
export const ASSISTANT = "Lantern";
export const TAGLINE = "A self-hosted agent harness, built for local models.";
/** The command that starts it. */
export const CLI = "hadal";
/**
 * The npm package people install. It is scoped because the plain `hadal` name on npm belongs to
 * another project. The registry URL, the folder npm installs it into, and the command the update
 * sheet suggests all read it here. `PACKAGE_NAMES` in `update-state.ts` lists the names published
 * so far, so an install of an older one can still update.
 */
export const PACKAGE = "@t-crypt/hadal";

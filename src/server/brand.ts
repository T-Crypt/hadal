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

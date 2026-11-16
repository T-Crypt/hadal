// Every user-visible name in the web app, in one place. Mirrors src/server/brand.ts. Stored ids (pocket.* keys, the
// pocket_auth cookie) keep their old names on purpose.
export const NAME = "HADAL";
/** The agent, in copy. */
export const AGENT = "Hadal";
/** The assistant that watches the other sessions (was PiP). */
export const ASSISTANT = "Lantern";
export const TAGLINE = "A self-hosted agent harness, built for local models.";
/**
 * HADAL's mark: two uprights, the sounding line, one point of light. The strokes take the surrounding color
 * (`currentColor`); the point takes the brand color (`.mark-light`). The `pathLength` is for the boot's draw-in.
 */
export const MARK = `<svg viewBox="0 0 32 32" width="1em" height="1em" aria-hidden="true" focusable="false">
    <path class="mark-line" d="M8 5V27" pathLength="1" />
    <path class="mark-line" d="M24 5V27" pathLength="1" />
    <path class="mark-line" d="M8 12L16 21L24 12" pathLength="1" />
    <circle class="mark-light" cx="16" cy="26.5" r="1.7" />
</svg>`;

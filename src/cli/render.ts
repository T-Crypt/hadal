/**
 * How the CLI draws: one palette taken from HADAL's own tokens, a status line on the terminal's last row while a run
 * works, and plain text when colour or a terminal is missing. No per-person themes: a terminal has 256 colours and no
 * cascade, so the CLI uses the one palette and stops there.
 */
const PALETTE = {
    ink: "229;241;252",
    muted: "129;152;173",
    signal: "101;217;255",
    second: "155;138;255",
    ok: "114;230;193",
    warn: "240;198;116",
    err: "255;138;155",
} as const;

export type Colour = keyof typeof PALETTE;

/** True when this process may colour its output: a terminal, no `NO_COLOR`, and not `TERM=dumb`. */
export const colour = Boolean(
    process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb",
);

/** True when the CLI may rewrite a status line: a terminal, and no `TERM=dumb`. */
const status = Boolean(process.stdout.isTTY && process.env.TERM !== "dumb");

export function paint(text: string, colourName: Colour): string {
    return colour && text !== "" ? `\u001b[38;2;${PALETTE[colourName]}m${text}\u001b[0m` : text;
}

export function dim(text: string): string {
    return colour && text !== "" ? `\u001b[38;2;${PALETTE.muted}m${text}\u001b[0m` : text;
}

let statusShown = "";

/** Put `text` on the terminal's last row, replacing the last status. Nothing is drawn without a terminal. */
export function showStatus(text: string): void {
    if (!status || text === statusShown) {
        return;
    }

    statusShown = text;
    process.stdout.write(`\r\u001b[2K${dim(text)}`);
}

/** Remove the status line, so the next printed line starts clean. */
export function clearStatus(): void {
    if (statusShown === "") {
        return;
    }

    statusShown = "";
    process.stdout.write("\r\u001b[2K");
}

/** Print a whole line, after clearing the status line. */
export function say(text: string): void {
    clearStatus();
    process.stdout.write(`${text}\n`);
}

/** Print text that has no newline of its own, such as a streamed answer's next characters. */
export function write(text: string): void {
    if (text === "") {
        return;
    }

    clearStatus();
    process.stdout.write(text);
}

/** Finish a streamed line. */
export function endLine(): void {
    clearStatus();
    process.stdout.write("\n");
}

/** The first line of some text, cut to `max` characters with an ellipsis. */
export function oneLine(text: string, max = 120): string {
    const line = text.split("\n", 1)[0]!.trim();

    return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A figure in compact form for a status line: 1234 tokens is "1.2k". */
export function figures(value: number): string {
    return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

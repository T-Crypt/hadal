/**
 * What a session's view means on a terminal: new transcript entries as they arrive, the answer as it is written, tool
 * calls as one line each, and a status line while the run works. The state that matters (entries, the run, approvals)
 * lives on the server; this file only remembers how much of it this terminal has already drawn.
 */
import { dim, endLine, figures, oneLine, paint, say, showStatus, write } from "./render.ts";

type Block = {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    args?: Record<string, unknown>;
    partial?: boolean;
};

type Entry = {
    id: number;
    kind: string;
    text?: string;
    name?: string;
    blocks?: Block[];
    isError?: boolean;
    stopReason?: string;
    error?: string;
    command?: string;
    summary?: string;
    title?: string;
    file?: string;
    output?: string;
    images?: number;
};

type Approval = { id: string; tool: string; subject: string; reason?: string; form?: true };

type Live = {
    busy: boolean;
    generation?: {
        attempt: number;
        message?: { blocks: Block[] };
        retry?: { at: number; error: string };
    };
    tools?: { callId: string; name: string; status: string; output?: string }[];
    limit?: { until?: number; reason?: string };
};

type View = {
    conversation?: { id: number; title?: string; cwd?: string };
    entries?: Entry[];
    live?: Live;
    approvals?: Approval[];
    agent?: { model?: { provider: string; modelId: string } | null; modelName?: string };
};

export class Printer {
    readonly #thinking: boolean;
    readonly #verbose: boolean;
    readonly #session: number;
    /** The newest entry this terminal has drawn. Entries with a lower or equal id are already on screen. */
    #lastEntry = 0;
    /** The text of the answer being written that this terminal has already drawn, for the run in progress. */
    #streamed = "";
    /** The newest message the person sent, and the newest answer, so a run can end on the answer that follows it. */
    #lastUser = 0;
    #lastAssistant = 0;
    #failed = false;
    /** Tool calls announced, so a call block that arrived live is not announced again in the entry. */
    readonly #calls = new Set<string>();
    /** Approval ids shown, and the one waiting for a y/n answer. */
    readonly #approvals = new Set<string>();
    #pending: Approval | undefined;
    #busySince: number | undefined;
    #busy = false;
    #title: string | undefined;

    constructor(options: { thinking: boolean; verbose: boolean; session: number }) {
        this.#thinking = options.thinking;
        this.#verbose = options.verbose;
        this.#session = options.session;
    }

    /** The session's title, once the view says it. */
    get title(): string | undefined {
        return this.#title;
    }

    /** An approval waiting for an answer, if one was shown and not answered. */
    get approval(): Approval | undefined {
        return this.#pending;
    }

    /** Whether an answer arrived after the newest message the person sent. */
    get answered(): boolean {
        return this.#lastAssistant > this.#lastUser;
    }

    /** Whether the last view said a run is working in this session. */
    get busy(): boolean {
        return this.#busy;
    }

    /** Whether the last answer HADAL gave ended in a failure. */
    get failed(): boolean {
        return this.#failed;
    }

    /** Forget the answer marker before a new send, so `answered` means this send's answer. */
    sent(): void {
        this.#lastAssistant = 0;
        this.#lastUser = 0;
        this.#failed = false;
    }

    /** Answer the waiting approval: takes it, so the caller can post the answer. */
    takeApproval(): Approval | undefined {
        const approval = this.#pending;

        this.#pending = undefined;

        return approval;
    }

    /** Draw what changed in a view: new entries, the answer being written, tool calls, approvals, the status line. */
    view(data: unknown): void {
        const view = data as View;

        if (view.conversation?.title !== undefined) {
            this.#title = view.conversation.title;
        }

        if (view.entries !== undefined) {
            this.#entries(view.entries);
        }

        if (view.live !== undefined) {
            this.#live(view.live, view.agent?.modelName);
        }

        for (const approval of view.approvals ?? []) {
            this.#approval(approval);
        }

        if (view.approvals !== undefined && view.approvals.length === 0) {
            this.#pending = undefined;
        }
    }

    /** The run is over: finish the answer's line, and stop the status line. */
    settle(): void {
        if (this.#streamed !== "") {
            endLine();
            this.#streamed = "";
        }

        this.#busySince = undefined;
    }

    #entries(entries: Entry[]): void {
        const fresh = entries
            .filter((entry) => entry.id > this.#lastEntry)
            .sort((a, b) => a.id - b.id);

        for (const entry of fresh) {
            this.#entry(entry);
            this.#lastEntry = Math.max(this.#lastEntry, entry.id);
        }
    }

    #entry(entry: Entry): void {
        switch (entry.kind) {
            case "user":
                this.#lastUser = Math.max(this.#lastUser, entry.id);
                say(`${paint("▸", "signal")} ${paint("you", "signal")} ${entry.text ?? ""}`);

                if (entry.images !== undefined && entry.images > 0) {
                    say(
                        `  ${paint(`${entry.images} image${entry.images === 1 ? "" : "s"}`, "muted")}`,
                    );
                }

                return;

            case "assistant": {
                this.#lastAssistant = Math.max(this.#lastAssistant, entry.id);
                const text = (entry.blocks ?? [])
                    .filter((block) => block.type === "text")
                    .map((block) => block.text ?? "")
                    .join("");

                // What the live view already drew is not drawn twice: only the rest of the answer goes out here.
                if (text !== "" && !(this.#streamed !== "" && text.startsWith(this.#streamed))) {
                    if (this.#streamed !== "") {
                        endLine();
                        this.#streamed = "";
                    }

                    write(text.endsWith("\n") ? text : `${text}\n`);
                } else if (this.#streamed !== "") {
                    // The live view drew this answer: the entry only says it is done, so its line ends here.
                    endLine();
                }

                for (const block of entry.blocks ?? []) {
                    if (block.type === "thinking" && this.#thinking) {
                        say(paint(`  thinking: ${oneLine(block.text ?? "", 200)}`, "muted"));
                    } else if (block.type === "toolCall") {
                        this.#call(block);
                    }
                }

                this.#streamed = "";

                if (entry.error !== undefined) {
                    this.#failed = true;
                    say(paint(`  ✗ run failed: ${oneLine(entry.error, 300)}`, "err"));
                }

                return;
            }

            case "toolResult": {
                const mark = entry.isError === true ? paint("✗", "err") : paint("✓", "ok");
                const detail = entry.isError === true ? `: ${oneLine(entry.text ?? "", 200)}` : "";

                say(`  ${mark} ${entry.name ?? "tool"}${detail}`);

                if (this.#verbose && (entry.text ?? "") !== "") {
                    say(indent(entry.text ?? ""));
                }

                return;
            }

            case "shell":
                say(`  ${paint("$", "second")} ${entry.command ?? ""}`);

                return;

            case "command":
                say(
                    `  ${paint("!", "second")} ${entry.name ?? "command"} ${oneLine(entry.output ?? "", 100)}`,
                );

                return;

            case "compaction":
                say(dim(`  … compacted: ${oneLine(entry.summary ?? "", 120)}`));

                return;

            case "reset":
                say(dim("  … context reset"));

                return;

            case "note":
                say(
                    `${paint("▸", "second")} ${paint(`note from ${entry.name ?? "someone"}`, "second")} ${entry.text ?? ""}`,
                );

                return;

            case "fromPi":
                say(dim(`  … continued from ${entry.file ?? "a terminal session"}`));

                return;

            default:
                return;
        }
    }

    #call(block: Block): void {
        const id = block.id ?? `${block.name}:${JSON.stringify(block.args ?? {})}`;

        if (this.#calls.has(id)) {
            return;
        }

        this.#calls.add(id);
        say(`  ${paint("⚙", "second")} ${block.name ?? "call"} ${dim(preview(block.args))}`);
    }

    #live(live: Live, modelName: string | undefined): void {
        this.#busy = live.busy;

        if (live.generation?.message !== undefined) {
            const text = live.generation.message.blocks
                .filter((block) => block.type === "text")
                .map((block) => block.text ?? "")
                .join("");

            if (text.length > this.#streamed.length && text.startsWith(this.#streamed)) {
                write(text.slice(this.#streamed.length));
                this.#streamed = text;
            } else if (text !== "" && this.#streamed === "") {
                write(text);
                this.#streamed = text;
            }

            for (const block of live.generation.message.blocks) {
                if (block.type === "toolCall") {
                    this.#call(block);
                }
            }
        }

        if (live.generation?.retry !== undefined) {
            say(paint(`  … retrying: ${oneLine(live.generation.retry.error, 160)}`, "warn"));
        }

        if (live.limit !== undefined && live.limit.until !== undefined) {
            say(
                paint(
                    `  … waiting for the limit to reset: ${new Date(live.limit.until).toLocaleTimeString()}`,
                    "warn",
                ),
            );
        }

        if (live.busy) {
            this.#busySince ??= Date.now();
            const seconds = Math.round((Date.now() - this.#busySince) / 1000);
            const tools = live.tools?.length ?? 0;
            const parts = [`working ${seconds}s`];

            if (tools > 0) {
                parts.push(`${figures(tools)} call${tools === 1 ? "" : "s"}`);
            }

            if (modelName !== undefined) {
                parts.push(modelName);
            }

            showStatus(`  ${parts.join(" · ")}`);
        } else {
            this.#busySince = undefined;

            if (this.#streamed !== "") {
                endLine();
                this.#streamed = "";
            }

            showStatus("");
        }
    }

    #approval(approval: Approval): void {
        if (this.#approvals.has(approval.id)) {
            return;
        }

        this.#approvals.add(approval.id);
        endLine();
        say("");
        say(paint("  approval needed", "warn"));
        say(`  ${paint(approval.tool, "ink")} ${oneLine(approval.subject, 300)}`);

        if (approval.reason !== undefined) {
            say(dim(`  ${oneLine(approval.reason, 300)}`));
        }

        if (approval.form === true) {
            say(
                paint(
                    `  This one asks for fields: answer it in the browser at /s/${this.#session}.`,
                    "warn",
                ),
            );

            return;
        }

        this.#pending = approval;
        say(`  ${paint("y", "ok")} allow, ${paint("n", "err")} deny, then Enter.`);
    }
}

/** A call's arguments in one line: the command for a shell, the path for a file, else the JSON. */
function preview(args: Record<string, unknown> | undefined): string {
    if (args === undefined) {
        return "";
    }

    for (const key of ["command", "path", "file_path", "query", "url", "pattern"]) {
        const value = args[key];

        if (typeof value === "string" && value !== "") {
            return oneLine(value, 120);
        }
    }

    try {
        return oneLine(JSON.stringify(args), 120);
    } catch {
        return "";
    }
}

/** Text indented by four spaces, for a tool's output under its line. */
function indent(text: string): string {
    return text
        .split("\n")
        .slice(0, 40)
        .map((line) => `    ${dim(line)}`)
        .join("\n");
}

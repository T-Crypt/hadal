// What a working subagent does this moment, from its peek: the call it waits on, the call it runs, or its words. The
// subagents bar and the peek tiles both say it, for a row each.
import { describeCall } from "./calls.js";
import { store } from "./store.js";

/** What a working subagent does this moment: its peek's waiting call, running call, or words. */
export function nowDoing(agent, peek = store.state.peeks?.[agent.conversationId]) {
    // Its request waits for its provider's limit to clear: that is what it does, whatever its peek last showed.
    if (agent.limited !== undefined) {
        return "Waiting for a usage limit to clear";
    }

    const waiting = peek?.approvals?.[0];

    if (waiting) {
        return `Waiting for approval: ${waiting.tool} ${waiting.subject}`.trim();
    }

    const last = (peek?.lines ?? []).at(-1);

    if (last?.kind === "tool" && last.status === "running") {
        const call = describeCall({ name: last.name, args: last.args });

        return [call.icon, call.label, call.subject].filter(Boolean).join(" ");
    }

    if (last?.kind === "shell") {
        return `$ ${last.command}`;
    }

    if (last?.kind === "text") {
        return last.text;
    }

    // Before its peek arrives, nothing is known but that it works.
    return peek === undefined ? "Working…" : "Thinking…";
}

/** A call block by its id: in the answer that streams, else in the session's newest entries. */
function callBlock(view, id) {
    for (const block of view.live?.generation?.message?.blocks ?? []) {
        if (block.type === "toolCall" && block.id === id) {
            return block;
        }
    }

    const order = view.order ?? [];

    for (let i = order.length - 1, seen = 0; i >= 0 && seen < 12; i--, seen++) {
        for (const block of view.entries?.get(order[i])?.blocks ?? []) {
            if (block.type === "toolCall" && block.id === id) {
                return block;
            }
        }
    }

    return undefined;
}

/**
 * What the open session's agent does this moment, for the top bar's readout: the call that runs (as its row in the
 * log names it), else thinking or writing. Null while it does not work.
 */
export function sessionNow(view) {
    if (view.live?.busy !== true) {
        return null;
    }

    const running = (view.live.tools ?? []).find((slot) => slot.status !== "done");

    if (running) {
        const block = callBlock(view, running.callId);

        if (block) {
            const call = describeCall(block);

            return [call.label, call.subject].filter(Boolean).join(" ") || block.name;
        }

        return "running a tool";
    }

    const last = (view.live.generation?.message?.blocks ?? []).at(-1);

    return last?.type === "text" ? "writing" : "thinking";
}

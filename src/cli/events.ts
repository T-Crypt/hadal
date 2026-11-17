/**
 * The tab's event stream, and the tab's second try at it. A CLI tab that loses its stream (the server restarted, or the
 * link slept) reattaches by itself: every attach starts with the session's full view, so what happened meanwhile shows
 * up then. The session lives on the server, so nothing is lost while the tab is away.
 */
export interface TabEvent {
    name: string;
    data: unknown;
}

/** A stream the server refused for its token: retrying cannot fix it, so the CLI says so and stops. */
export class SignInRefused extends Error {}

const FIRST_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

/**
 * Read `/api/events` for one conversation, and read it again after a drop, until `signal` aborts. `onLost` is told the
 * wait before each try, so the terminal can say it is reconnecting rather than look hung.
 */
export async function followStream(options: {
    url: string;
    token: string;
    conversation: number;
    signal: AbortSignal;
    onEvent: (event: TabEvent) => void;
    onLost: (retryInMs: number) => void;
}): Promise<void> {
    const tab = crypto.randomUUID();
    let delay = FIRST_DELAY_MS;

    while (!options.signal.aborted) {
        try {
            const response = await fetch(
                `${options.url}/api/events?c=${options.conversation}&p=1&tab=${tab}`,
                {
                    headers: {
                        Authorization: `Bearer ${options.token}`,
                        Accept: "text/event-stream",
                    },
                    signal: options.signal,
                },
            );

            if (response.status === 401 || response.status === 403) {
                throw new SignInRefused(`The server refused this token (${response.status}).`);
            }

            if (!response.ok || response.body === null) {
                throw new Error(`the server answered ${response.status}`);
            }

            // A stream that opened is a stream that works: the next drop waits one second again.
            if (delay !== FIRST_DELAY_MS) {
                delay = FIRST_DELAY_MS;
            }

            for await (const event of readEvents(response.body)) {
                options.onEvent(event);
            }
        } catch (error) {
            if (options.signal.aborted) {
                return;
            }

            if (error instanceof SignInRefused) {
                throw error;
            }
        }

        if (options.signal.aborted) {
            return;
        }

        options.onLost(delay);
        await wait(delay, options.signal);
        delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
}

/** One text/event-stream body, as the events it carries. Multiple `data:` lines of one event join with a newline. */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<TabEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        for (;;) {
            const { value, done } = await reader.read();

            if (done) {
                return;
            }

            buffer += decoder.decode(value, { stream: true });
            let end = buffer.indexOf("\n\n");

            while (end !== -1) {
                const frame = buffer.slice(0, end);

                buffer = buffer.slice(end + 2);
                const event = parseFrame(frame);

                if (event !== undefined) {
                    yield event;
                }

                end = buffer.indexOf("\n\n");
            }
        }
    } finally {
        reader.releaseLock();
    }
}

/** One frame (the lines between two blank lines) as an event, or undefined for a comment or an empty frame. */
export function parseFrame(frame: string): TabEvent | undefined {
    let name = "message";
    const data: string[] = [];

    for (const line of frame.split("\n")) {
        if (line.startsWith(":")) {
            continue;
        }

        if (line.startsWith("event:")) {
            name = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
            data.push(line.slice(5).replace(/^ /, ""));
        }
    }

    if (data.length === 0) {
        return undefined;
    }

    const text = data.join("\n");

    try {
        return { name, data: JSON.parse(text) };
    } catch {
        return { name, data: text };
    }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(done, ms);

        function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        }

        signal.addEventListener("abort", done, { once: true });
    });
}

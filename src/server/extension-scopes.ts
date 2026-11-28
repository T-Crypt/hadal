/**
 * Folder-scoped extensions: the owner's `extensionScopes` in `config.json` names, for a module file (or a glob such as
 * `enyo-*.ts`), the folders it works in. What a scoped module installs then acts only in conversations whose working
 * folder is inside one of them: its prompt sections render nothing elsewhere, its hooks do nothing, its wraps leave the
 * tool or section as it was, and its tools refuse. The registry is shared by every conversation, so a scoped tool is
 * still offered everywhere; outside its folders a call returns a refusal that says why.
 *
 * Not scoped: what a module adds to the app (routes, browser modules, commands), its tasks (they run by name, started
 * by the module itself), and what its default export does when it loads.
 */
import { homedir } from "node:os";
import { isAbsolute, normalize } from "node:path";
import type {
    ConversationId,
    Extension,
    HookRegistration,
    PromptSection,
    ToolRegistration,
    Wrap,
} from "@earendil-works/pi-durable";
import { canonical, within } from "./folder-lock.ts";

/** Module file name or glob to the absolute folders it works in. */
export type ExtensionScopes = Readonly<Record<string, readonly string[]>>;

/**
 * Read `extensionScopes` from the config file. A folder may start with `~/`. A folder that is not absolute is left out,
 * and a key whose folders are all left out keeps an empty list: its modules then act nowhere, not everywhere.
 */
export function parseExtensionScopes(raw: unknown, home: string = homedir()): ExtensionScopes {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return {};
    }

    const out: Record<string, string[]> = {};

    for (const [pattern, folders] of Object.entries(raw as Record<string, unknown>)) {
        if (pattern === "") {
            continue;
        }

        const list = Array.isArray(folders) ? folders : [folders];

        out[pattern] = list
            .filter((each): each is string => typeof each === "string")
            .map((each) => (each === "~" || each.startsWith("~/") ? home + each.slice(1) : each))
            .filter((each) => isAbsolute(each))
            .map((each) => normalize(each).replace(/(.)\/+$/, "$1"));
    }

    return out;
}

/** Whether a file name matches a pattern: `*` stands for any run of characters, `?` for one. */
function matches(pattern: string, file: string): boolean {
    const source = pattern
        .split("")
        .map((char) =>
            char === "*" ? ".*" : char === "?" ? "." : char.replace(/[\\^$.|+()[\]{}]/g, "\\$&"),
        )
        .join("");

    return new RegExp(`^${source}$`).test(file);
}

/** The folders a module file works in, from every pattern that names it; undefined when none does (it works anywhere). */
export function scopeOf(scopes: ExtensionScopes, file: string): readonly string[] | undefined {
    let found: string[] | undefined;

    for (const [pattern, folders] of Object.entries(scopes)) {
        if (matches(pattern, file)) {
            found = [...(found ?? []), ...folders];
        }
    }

    return found === undefined ? undefined : [...new Set(found)];
}

/** Whether a working folder is inside one of `folders`, by its real path and as written. */
export function inScope(cwd: string, folders: readonly string[]): boolean {
    if (!isAbsolute(cwd)) {
        // A workspace URI (`ssh://...`) is another machine's folder: no local scope covers it.
        return false;
    }

    const real = canonical(cwd);
    const literal = normalize(cwd);

    return folders.some(
        (folder) =>
            within(real, folder) || within(literal, folder) || within(real, canonical(folder)),
    );
}

/** The api argument a hook handler gets: the one object among its arguments that names a conversation. */
function conversationOf(args: readonly unknown[]): ConversationId | undefined {
    for (let index = args.length - 1; index >= 0; index--) {
        const each = args[index] as { conversationId?: unknown } | null;

        if (typeof each === "object" && each !== null && each.conversationId !== undefined) {
            return each.conversationId as ConversationId;
        }
    }

    return undefined;
}

/** A copy of `object` with these values replaced: its prototype, getters, and other properties stay as they were. */
function withValues<T extends object>(object: T, values: Partial<T>): T {
    return Object.create(Object.getPrototypeOf(object), {
        ...Object.getOwnPropertyDescriptors(object),
        ...Object.fromEntries(
            Object.entries(values).map(([key, value]) => [
                key,
                { value, enumerable: true, writable: true, configurable: true },
            ]),
        ),
    }) as T;
}

/**
 * What an extension installs, acting only where `here(conversationId)` is true. `file` names the module in a refusal.
 * A hook whose arguments name no conversation runs as it is: nothing tells where it runs.
 */
export function scopeExtension(
    extension: Extension,
    file: string,
    here: (conversationId: ConversationId) => boolean,
): Extension {
    const refusal = (name: string) =>
        `The tool ${name} (extension ${file}) works only in sessions whose folder is inside the folders the owner set for it in extensionScopes. This session's folder is not.`;

    const tools = extension.tools?.map((tool) =>
        withValues(tool, {
            execute: async (...args: Parameters<ToolRegistration["execute"]>) => {
                if (!here(args[1].conversationId)) {
                    throw new Error(refusal(tool.name));
                }

                return tool.execute(...args);
            },
        }),
    );

    const sections = extension.sections?.map((section) => scopeSection(section, undefined, here));

    const hooks = extension.hooks?.map((registration): HookRegistration => ({
        ...registration,
        handlers: Object.fromEntries(
            Object.entries(registration.handlers).map(([name, handler]) => [
                name,
                typeof handler !== "function"
                    ? handler
                    : (...args: unknown[]) => {
                          const id = conversationOf(args);

                          return id !== undefined && !here(id)
                              ? undefined
                              : (handler as (...each: unknown[]) => unknown).apply(
                                    registration.handlers,
                                    args,
                                );
                      },
            ]),
        ),
    }));

    const wraps = extension.wraps?.map((each): Wrap => {
        if ("tool" in each) {
            return {
                tool: each.tool,
                wrap: (tool: ToolRegistration) => {
                    const wrapped = each.wrap(tool);

                    return withValues(wrapped, {
                        execute: async (...args: Parameters<ToolRegistration["execute"]>) =>
                            here(args[1].conversationId)
                                ? wrapped.execute(...args)
                                : tool.execute(...args),
                    });
                },
            };
        }

        return {
            section: each.section,
            wrap: (section: PromptSection) => scopeSection(each.wrap(section), section, here),
        };
    });

    return withValues(extension, {
        ...(tools === undefined ? {} : { tools }),
        ...(sections === undefined ? {} : { sections }),
        ...(hooks === undefined ? {} : { hooks }),
        ...(wraps === undefined ? {} : { wraps }),
    });
}

/** `inside` where the conversation is in scope, `outside` elsewhere (undefined `outside`: nothing). */
function scopeSection(
    inside: PromptSection,
    outside: PromptSection | undefined,
    here: (conversationId: ConversationId) => boolean,
): PromptSection {
    return withValues(inside, {
        render: (input, context) =>
            here(input.conversationId)
                ? inside.render(input, context)
                : outside?.render(input, context),
    });
}

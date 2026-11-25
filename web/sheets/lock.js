// The folder lock sheet: who may see a folder. Local models only, local and Claude, local and US cloud models, or a
// custom set of US companies. The server enforces the policy; this sheet chooses it and says what it blocks.
import { useState } from "preact/hooks";
import { closeSheet, lockFolder, store, unlockFolder } from "../store.js";
import { html, Sheet } from "../ui.js";

const PRESETS = [
    ["local", "Local", "Local models only. No cloud model sees the folder."],
    ["anthropic", "Claude", "Local models and Anthropic only."],
    [
        "us",
        "US",
        "Local models and US cloud models: Claude, GPT, Gemini, Grok, and other US makers.",
    ],
    ["custom", "Custom", "Local models and the US companies you pick."],
];

const CHIP = { local: "local", anthropic: "claude", us: "us", custom: "custom" };

/** Whether a policy lets this model see the folder. */
function allows(policy, model) {
    if (model.local === true) {
        return true;
    }

    const origin = model.origin;

    if (origin === undefined) {
        return false;
    }

    if (policy.scope === "local") {
        return false;
    }

    if (policy.scope === "anthropic") {
        return origin.company === "Anthropic";
    }

    if (policy.scope === "us") {
        return origin.region === "us";
    }

    return policy.companies.includes(origin.company);
}

/** US companies in the model list, whether the policy allows each one, and how many models it has. */
function makers(models, policy) {
    const seen = new Map();

    for (const model of models) {
        const origin = model.origin;

        if (model.local === true || origin === undefined || origin.region === "unknown") {
            continue;
        }

        const entry = seen.get(origin.company) ?? {
            company: origin.company,
            region: origin.region,
            allowed: allows(policy, model),
            count: 0,
        };

        entry.count += 1;
        seen.set(origin.company, entry);
    }

    return [...seen.values()].sort((a, b) => a.company.localeCompare(b.company));
}

/** The policy a preset button asks for. */
function policyOf(scope, companies) {
    return scope === "custom" ? { scope: "custom", companies } : { scope };
}

/** The policy in one line, whatever models are installed. */
function policyWords(policy) {
    if (policy.scope === "local") {
        return "Local models only.";
    }

    if (policy.scope === "anthropic") {
        return "Local models and Anthropic.";
    }

    if (policy.scope === "us") {
        return "Local models and US cloud models.";
    }

    return `Local models and ${policy.companies.join(", ")}.`;
}

export function LockSheet() {
    const path = store.state.sheet?.path ?? "";
    const lock = store.state.folderLocks?.locks?.find((each) => each.path === path);
    const models = store.state.models ?? [];
    const [scope, setScope] = useState(lock?.policy?.scope ?? "us");
    const [companies, setCompanies] = useState(
        lock?.policy?.scope === "custom" ? lock.policy.companies : ["Anthropic"],
    );
    const [hide, setHide] = useState((lock?.hide ?? []).join("\n"));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const policy = policyOf(scope, companies);
    const listed = makers(models, policy);
    const us = makers(models, { scope: "us" });
    const blocked = listed.filter((entry) => !entry.allowed);
    const unknown = models.filter(
        (model) => model.local !== true && model.origin?.region === "unknown",
    ).length;
    const allowedWords = listed
        .filter((entry) => entry.allowed)
        .map((entry) => `${entry.company} (${entry.count})`)
        .join(", ");
    const blockedWords = blocked.map((entry) => `${entry.company} (${entry.count})`).join(", ");

    const toggle = (company) =>
        setCompanies((current) =>
            current.includes(company)
                ? current.filter((each) => each !== company)
                : [...current, company],
        );

    const save = async () => {
        setBusy(true);
        setError(null);

        try {
            const paths = hide
                .split("\n")
                .map((each) => each.trim())
                .filter((each) => each.startsWith("/"));

            await lockFolder(path, policy, paths);
            closeSheet();
        } catch (failure) {
            setError(failure.message);
        } finally {
            setBusy(false);
        }
    };

    const unlock = async () => {
        if (!confirm(`Unlock ${path}?\n\nSessions that worked there stay sealed to its policy.`)) {
            return;
        }

        setBusy(true);
        setError(null);

        try {
            await unlockFolder(path);
            closeSheet();
        } catch (failure) {
            setError(failure.message);
        } finally {
            setBusy(false);
        }
    };

    return html`<${Sheet} title="Folder lock" onClose=${closeSheet}>
        <p class="mono small">${path}</p>
        <p class="muted small">
            A session working here can use only the models this policy allows. The seal lasts after an unlock. A session
            outside the folder cannot read it or its copies.
        </p>
        <div class="field">
            <div class="label">Who may see it</div>
            <div class="segmented">
                ${PRESETS.map(
                    ([value, label]) => html`<button
                        class=${scope === value ? "on" : ""}
                        aria-pressed=${scope === value}
                        onClick=${() => setScope(value)}
                    >
                        ${label}
                    </button>`,
                )}
            </div>
            <div class="muted small">${PRESETS.find(([value]) => value === scope)?.[2]}</div>
        </div>
        ${
            scope === "custom" &&
            html`<div class="field">
                <div class="label">US companies</div>
                <div class="lock-makers">
                    ${us.map(
                        (entry) => html`<label class="lock-maker" key=${entry.company}>
                            <input
                                type="checkbox"
                                checked=${companies.includes(entry.company)}
                                onChange=${() => toggle(entry.company)}
                            />
                            <span>${entry.company}</span>
                        </label>`,
                    )}
                </div>
            </div>`
        }
        <div class="group">
            <div class="group-title">What this allows</div>
            <p class="small">${policyWords(policy)}</p>
            ${
                allowedWords !== "" &&
                html`<p class="small muted">Installed and allowed: ${allowedWords}.</p>`
            }
            ${blockedWords !== "" && html`<p class="small muted">Blocked: ${blockedWords}.</p>`}
            ${
                unknown > 0 &&
                html`<p class="warn small">
                    ${unknown} models have no reviewed maker. They stay blocked in every policy.
                </p>`
            }
        </div>
        <div class="field">
            <div class="label">Copies to hide</div>
            <textarea
                rows="3"
                spellcheck="false"
                placeholder="/another/copy/of/this/folder"
                value=${hide}
                onInput=${(event) => setHide(event.currentTarget.value)}
            ></textarea>
            <div class="muted small">
                Worktrees and harness logs are hidden on their own. Name any other copy here, one path per line.
            </div>
        </div>
        ${error && html`<div class="error-box">${error}</div>`}
        <div class="row">
            ${lock && html`<button class="button ghost" disabled=${busy} onClick=${unlock}>Unlock</button>`}
            <button class="button primary" disabled=${busy || path === ""} onClick=${save}>
                ${busy ? "Saving…" : lock ? "Update policy" : "Lock folder"}
            </button>
        </div>
        ${
            lock &&
            html`<p class="muted small">
                Locked on ${new Date(lock.at).toLocaleDateString()} with the
                ${CHIP[lock.policy?.scope ?? "local"]} policy.
            </p>`
        }
    </${Sheet}>`;
}

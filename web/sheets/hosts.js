// The owner's SSH hosts: other machines HADAL may work on (bash, read, write and edit with `host`). Each row says
// where it is, how its calls are treated, and whether it answers; the run log shows what ran there.
import { useState } from "preact/hooks";
import { api, attempt, closeSheet, notify, store } from "../store.js";
import { html, Icon, Sheet } from "../ui.js";

const MODES = [
    ["allow", "Allow", "HADAL's calls there run."],
    ["ask", "Ask", "Each call waits for someone here to allow it."],
    ["off", "Off", "HADAL is not offered this host."],
];

const blank = { name: "", target: "", cwd: "", shell: "", note: "", mode: "allow" };

/** One host being added or changed: its fields, then Save or Cancel. */
function HostForm({ initial, onSave, onCancel }) {
    const [host, setHost] = useState({ ...blank, ...initial });
    const set = (key) => (event) => setHost({ ...host, [key]: event.currentTarget.value });
    const field = (key, label, placeholder, hint, autofocus = false) => html`<div class="field">
        <div class="label">${label}</div>
        <input
            class=${key === "note" ? "" : "mono"}
            placeholder=${placeholder}
            value=${host[key]}
            autocapitalize="off"
            spellcheck=${false}
            autofocus=${autofocus || undefined}
            onInput=${set(key)}
        />
        ${hint && html`<div class="muted small">${hint}</div>`}
    </div>`;

    return html`<div class="host-form">
        <p class="muted small">
            HADAL reaches the machine with the system's ssh, so your keys, agent, and ~/.ssh/config apply. It never types
            ssh itself.
        </p>
        ${field("name", "Name", "gpu", "What HADAL passes as host: lowercase letters, digits and dashes.", true)}
        ${field("target", "SSH destination", "user@192.168.1.20", "An address, user@address, or a Host from ~/.ssh/config. Its key must already work without a password.")}
        ${field("cwd", "Folder", "the SSH user's home", "Where relative paths and commands start.")}
        ${field("shell", "Shell", "sh -c", "How commands run there. bash -lc gives them the login PATH.")}
        ${field("note", "Note for HADAL", "GPU box: llama-swap and the model files")}
        <div class="field">
            <div class="label">HADAL's calls</div>
            <div class="segmented">
                ${MODES.map(
                    ([mode, label]) => html`<button
                        class=${host.mode === mode ? "on" : ""}
                        aria-pressed=${host.mode === mode}
                        onClick=${() => setHost({ ...host, mode })}
                    >
                        ${label}
                    </button>`,
                )}
            </div>
            <div class="muted small">${MODES.find(([mode]) => mode === host.mode)?.[2]}</div>
        </div>
        <div class="row">
            <button class="button ghost" onClick=${onCancel}>Cancel</button>
            <button
                class="button primary"
                disabled=${host.name.trim() === "" || host.target.trim() === ""}
                onClick=${() => onSave({ ...host, name: host.name.trim(), target: host.target.trim() })}
            >
                Save
            </button>
        </div>
    </div>`;
}

/** One host: its name and mode, where it is, its note, the last test, and what can be done with it. */
function HostRow({ host, index, tests, onTest, onEdit, onRemove }) {
    const mode = MODES.find(([name]) => name === host.mode) ?? MODES[0];
    const result = tests[host.name];
    const said =
        result === undefined
            ? null
            : result.running
              ? { tone: "", text: "Connecting…" }
              : result.ok
                ? { tone: "ok", text: `Answered in ${result.ms} ms · ${result.cwd}` }
                : { tone: "err", text: result.error };

    return html`<div class="host-row" data-mode=${host.mode} data-part="host-row">
        <div class="host-row-head">
            <span class="host-row-name mono" title=${host.target}>
                <${Icon} name="server" size=${13} />
                <b>@${host.name}</b>
            </span>
            <span class=${`host-mode ${host.mode}`} title=${mode[2]}>${mode[1]}</span>
            <span class="host-row-actions">
                <button
                    class="button small ghost"
                    disabled=${result?.running === true}
                    onClick=${() => onTest(host.name)}
                >
                    Test
                </button>
                <button class="button small ghost" onClick=${() => onEdit(index)}>Change</button>
                <button class="button small ghost" onClick=${() => onRemove(index)}>Remove</button>
            </span>
        </div>
        <div class="host-where">
            <span class="mono">${host.target}</span>
            ${host.cwd && html`<span class="mono">${host.cwd}</span>`}
            ${host.shell && html`<span class="mono">${host.shell}</span>`}
        </div>
        ${host.note && html`<div class="host-note-line">${host.note}</div>`}
        ${
            said &&
            html`<div class=${`host-test ${said.tone}`} data-part="host-test">${said.text}</div>`
        }
    </div>`;
}

/** The hosts, a Test button each, and adding, changing and removing them. */
export function HostsSheet() {
    const hosts = store.state.server?.hosts ?? [];
    const machine = store.state.server?.hostname;
    const [editing, setEditing] = useState(undefined);
    const [tests, setTests] = useState({});
    const [testingAll, setTestingAll] = useState(false);
    const counts = MODES.map(([mode, label]) => [
        label,
        hosts.filter((host) => host.mode === mode).length,
    ]).filter(([, count]) => count > 0);
    const save = (next) =>
        attempt(async () => {
            const answer = await api("hosts", { hosts: next });

            store.set((state) => ({ server: { ...state.server, hosts: answer.hosts } }));
            setEditing(undefined);
        });

    const probe = async (name) => {
        setTests((all) => ({ ...all, [name]: { running: true } }));

        const answer = await api("hosts/test", { name });

        setTests((all) => ({ ...all, [name]: answer }));

        return answer;
    };

    const test = (name) =>
        attempt(async () => {
            const answer = await probe(name);

            if (!answer.ok) {
                notify("error", answer.error);
            }
        });
    const testAll = () =>
        attempt(async () => {
            setTestingAll(true);

            try {
                for (const host of hosts) {
                    const answer = await probe(host.name);

                    if (!answer.ok) {
                        notify("error", `${host.name}: ${answer.error}`);
                    }
                }
            } finally {
                setTestingAll(false);
            }
        });

    if (editing !== undefined) {
        const others = hosts.filter((_, index) => index !== editing);

        return html`<${Sheet} title=${editing === -1 ? "Add a host" : "Change the host"} onClose=${closeSheet}>
            <${HostForm}
                initial=${editing === -1 ? undefined : hosts[editing]}
                onCancel=${() => setEditing(undefined)}
                onSave=${(host) =>
                    save(
                        editing === -1
                            ? [...hosts, host]
                            : hosts.map((each, index) => (index === editing ? host : each)),
                    )}
            />
            ${others.length > 0 && html`<p class="muted small">Other hosts: ${others.map((each) => each.name).join(", ")}</p>`}
        <//>`;
    }

    return html`<${Sheet} title="Hosts" onClose=${closeSheet}>
        <div class="host-summary" data-part="host-summary">
            <div class="host-summary-here">
                <${Icon} name="terminal" size=${13} />
                <span>${machine === undefined ? "This machine" : `This machine: ${machine}`}</span>
            </div>
            ${
                hosts.length === 0
                    ? html`<span class="muted small">No other machines yet</span>`
                    : html`<span class="muted small">${hosts.length} ${hosts.length === 1 ? "host" : "hosts"}${counts.length === 0 ? "" : ` · ${counts.map(([label, count]) => `${count} ${label.toLowerCase()}`).join(" · ")}`}</span>`
            }
        </div>
        <p class="muted small">
            Other machines HADAL can work on over SSH. With a host here, HADAL's bash, read, write and edit take its name
            and run there, over one connection kept open. Anyone who can steer a session can then run commands on the host
            as its SSH user. Menu → Where commands ran shows what ran where.
        </p>
        ${
            hosts.length === 0
                ? html`<div class="host-empty" data-part="hosts-empty">
                      <${Icon} name="server" size=${20} />
                      <div>
                          <div>No hosts yet.</div>
                          <div class="muted small">
                              Add a machine HADAL may reach, such as a GPU box or a NAS.
                          </div>
                      </div>
                  </div>`
                : html`<div class="host-list" data-part="host-list">
                      ${hosts.map(
                          (host, index) => html`<${HostRow}
                          key=${host.name}
                          host=${host}
                          index=${index}
                          tests=${tests}
                          onTest=${test}
                          onEdit=${setEditing}
                          onRemove=${(at) => save(hosts.filter((_, place) => place !== at))}
                      />`,
                      )}
                  </div>`
        }
        <div class="row host-actions">
            <button class="button wide" onClick=${() => setEditing(-1)}>Add a host</button>
            ${
                hosts.length > 1 &&
                html`<button
                    class="button wide ghost"
                    disabled=${testingAll}
                    onClick=${testAll}
                >
                    ${testingAll ? "Testing…" : "Test all"}
                </button>`
            }
        </div>
    <//>`;
}

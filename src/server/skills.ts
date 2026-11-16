/**
 * HADAL's skills for a session's folder, from the places Pi's CLI looks, in its order. The first skill of a name wins:
 *
 * 1. `.pi/skills/` in the session's folder, unless HADAL was told not to trust the project.
 * 2. `.agents/skills/` in the session's folder and each folder above it, nearest first, up to the root of its git
 *    repository, or to `/` outside one. Only in a project HADAL trusts, below.
 * 3. The skill paths in HADAL's settings.
 * 4. `skills/` in HADAL's folder (`~/.pi/agent/skills/`).
 * 5. `~/.agents/skills/`, for every session.
 *
 * The `skills` setting works as in the terminal app: a relative path is from HADAL's folder; `-path` and `+path` (exact), and `!pattern`
 * (a glob) turn skills off or on, and so does a plain glob among the paths. The exclusions count for the settings'
 * paths and for places 4 and 5, not for the project's own folders (only the project's own settings reach those).
 *
 * Pi trusts a project when its trust store (`trust.json` in Pi's folder) says so for the folder or one above it, or
 * says nothing and Pi's `defaultProjectTrust` setting is "always". Where it says nothing, the CLI asks when it starts.
 * HADAL asks its owner (`readProjectTrust` says when) and saves the answer in the same store, with the three
 * answers the CLI's `/trust` saves (`saveProjectTrust`); until then the project is not trusted, as when HADAL runs without
 * a terminal. HADAL also asks before it loads `.pi/skills/`: HADAL loads those until it is told not to trust the
 * project (a saved "no", or `defaultProjectTrust` "never"), as it always has, and then leaves them out as HADAL does.
 *
 * The search for `.agents/skills/` stops at the repository's root, as HADAL's loading does; HADAL's question also counts
 * folders above the root, whose skills it never loads, so HADAL does not ask about those.
 *
 * This follows `addAutoDiscoveredResources`, `collectAncestorAgentsSkillDirs`, `resolveLocalEntries`, `applyPatterns`,
 * and `isEnabledByOverrides` in `dist/core/package-manager.js`,
 * `resolveProjectTrusted` in `dist/core/project-trust.js`, and `getProjectTrustOptions` in `dist/core/trust-manager.js`
 * of @earendil-works/pi-coding-agent, which the package does not export: check them when updating HADAL. HADAL's
 * `DefaultPackageManager.resolve` is the one export that applies the setting, but it is async, takes the project's
 * trust from HADAL's own settings object, and loads package skills: HADAL keeps its trust code and its folders.
 * `test/skills.test.ts` checks the skills against HADAL's own loader.
 */
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
    CONFIG_DIR_NAME,
    loadSkills,
    loadSkillsFromDir,
    ProjectTrustStore,
    type Skill,
} from "@earendil-works/pi-coding-agent";
import { minimatch } from "minimatch";

/** What, besides the session's folder, says where skills are. */
export type SkillSources = {
    /** HADAL's folder (`~/.pi/agent`): its `skills/`, and `trust.json`, which projects Pi was told to trust or not. */
    agentDir: string;
    /** The home folder, whose `.agents/skills/` every session has. */
    home: string;
    /** The skill paths in HADAL's settings. */
    settingsPaths: readonly string[];
    /** Pi's `defaultProjectTrust` setting: whether a project nobody decided about is trusted. */
    defaultProjectTrust: "always" | "never" | "ask";
};

/** The root of the git repository `folder` is in, or undefined outside one. */
function gitRoot(folder: string): string | undefined {
    for (let current = folder; ; current = dirname(current)) {
        if (existsSync(join(current, ".git"))) {
            return current;
        }

        if (dirname(current) === current) {
            return undefined;
        }
    }
}

/** The project's `.agents/skills/` folders, nearest first: in `cwd` and above it, up to its repository's root. */
function projectAgentsFolders(cwd: string, home: string): string[] {
    const top = gitRoot(cwd);
    const own = resolve(home, ".agents", "skills");
    const folders: string[] = [];

    for (let current = cwd; ; current = dirname(current)) {
        const folder = join(current, ".agents", "skills");

        // The home folder's is everyone's, not the project's, even in a session in the home folder.
        if (folder !== own && existsSync(folder)) {
            folders.push(folder);
        }

        if (current === top || dirname(current) === current) {
            return folders;
        }
    }
}

/** The `SKILL.md` files (or skill files) under `path`, a skill folder or file. */
function skillFilesAt(path: string): string[] {
    if (!existsSync(path)) {
        return [];
    }

    return statSync(path).isDirectory()
        ? loadSkillsFromDir({ dir: path, source: "path" }).skills.map((each) => each.filePath)
        : path.endsWith(".md")
          ? [path]
          : [];
}

/** Whether `path` is an override (`!`, `+`, `-`) or a glob, rather than a plain path, among HADAL's settings entries. */
const isPattern = (path: string) => /^[-+!]|[*?]/.test(path);

/**
 * The files `entries` (HADAL's `skills` setting) leave on, as HADAL's `applyPatterns` decides, with paths and globs from
 * `base`. A plain glob includes, `!` excludes, `+` puts an exact path back, and `-` takes an exact path out.
 */
function enabledBy(files: string[], entries: string[], base: string, home: string): string[] {
    const posix = (path: string) => path.split(sep).join("/");
    const unTilde = (path: string) =>
        path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
    const withKey = (key: string) =>
        entries.filter((each) => each.startsWith(key)).map((each) => each.slice(1));
    const [excludes, forceIn, forceOut] = ["!", "+", "-"].map(withKey) as [
        string[],
        string[],
        string[],
    ];
    const includes = entries.filter((each) => !/^[-+!]/.test(each));

    const matches = (file: string, patterns: string[], exact: boolean) => {
        const skill = basename(file) === "SKILL.md";
        const places = [file, ...(skill ? [dirname(file)] : [])];
        const keys = places.flatMap((each) => [posix(relative(base, each)), posix(each)]);

        return patterns.some((pattern) => {
            const form = posix(unTilde(exact ? pattern.replace(/^\.[/\\]/, "") : pattern));

            return exact
                ? keys.includes(form)
                : [...keys, ...places.map((each) => basename(each))].some((key) =>
                      minimatch(key, form),
                  );
        });
    };

    return files.filter((file) => {
        let on = includes.length === 0 || matches(file, includes, false);

        on &&= !matches(file, excludes, false);
        on ||= matches(file, forceIn, true);

        return on && !matches(file, forceOut, true);
    });
}

/** The answers HADAL's `/trust` offers: trust the folder, trust the folder above it (and so this one too), or not. */
export type TrustChoice = "trust" | "trust-parent" | "distrust";

/** A decision in Pi's trust store: the folder it was saved for, and whether HADAL trusts it and the folders in it. */
type Saved = { path: string; trusted: boolean };

/** Whether HADAL trusts a session's project, and the project skills that load only while it does. */
export type ProjectTrust = {
    /** The session's folder, as the trust store names it: links resolved. */
    folder: string;
    /** The folder above it, which "trust-parent" trusts; absent at the top. */
    parent?: string;
    /** The decision saved for the folder or the nearest folder above it; null when there is none. */
    saved: Saved | null;
    /** Pi's `defaultProjectTrust` setting: it decides for a folder without a saved decision. */
    defaultProjectTrust: SkillSources["defaultProjectTrust"];
    /** Whether HADAL trusts the project now. */
    trusted: boolean;
    /** The project's `.agents/skills/` folders. */
    folders: string[];
    /** The skills in them. */
    skills: { name: string; description: string }[];
    /** The skills in its `.pi/skills/`, which load unless HADAL was told not to trust it. */
    ownSkills: { name: string; description: string }[];
    /** The project has a .pi/settings.json file, whose model defaults require trust. */
    settings: boolean;
    /** Whether to ask the owner: project skills or settings exist, no decision applies, and HADAL's setting is to ask. */
    ask: boolean;
    /** Pi's trust store cannot be read: nothing is trusted, and no answer can be saved until it is mended. */
    unreadable?: true;
};

/** A folder as the trust store names it: links resolved, when it exists. */
function canonical(folder: string): string {
    try {
        return realpathSync(folder);
    } catch {
        return resolve(folder);
    }
}

/** The decision saved for `cwd` or the nearest folder above it: null for none, undefined for an unreadable store. */
function savedDecision(cwd: string, agentDir: string): Saved | null | undefined {
    try {
        const entry = new ProjectTrustStore(agentDir).getEntry(cwd);

        return entry === null ? null : { path: entry.path, trusted: entry.decision };
    } catch {
        return undefined;
    }
}

/**
 * What HADAL decided about a project, as it decides without asking: trusted, not trusted (a saved "no", or
 * `defaultProjectTrust` "never"), or nothing yet, which includes a trust store that cannot be read.
 */
type Decision = "trusted" | "distrusted" | "undecided";

function decides(saved: Saved | null | undefined, sources: SkillSources): Decision {
    if (saved === undefined) {
        return "undecided";
    }

    if (saved !== null) {
        return saved.trusted ? "trusted" : "distrusted";
    }

    return sources.defaultProjectTrust === "always"
        ? "trusted"
        : sources.defaultProjectTrust === "never"
          ? "distrusted"
          : "undecided";
}

/**
 * Whether HADAL was told not to trust the project a session in `cwd` works in (a saved "no", or `defaultProjectTrust`
 * "never"), for what of its own `.pi` folder trust gates: its `.pi/prompts` stay out then, as its `.pi/skills` do. The
 * trust store is read only for a project with `.pi/prompts`.
 */
export function projectDistrusted(cwd: string, sources: SkillSources): boolean {
    const folder = resolve(cwd);

    return (
        existsSync(join(folder, CONFIG_DIR_NAME, "prompts")) &&
        decides(savedDecision(folder, sources.agentDir), sources) === "distrusted"
    );
}

/** Where a session in `cwd` loads skills from, in order: the project's folders, then skill files HADAL's settings leave on. */
export function skillPlaces(cwd: string, sources: SkillSources): string[] {
    const folder = resolve(cwd);
    const own = join(folder, CONFIG_DIR_NAME, "skills");
    const hasOwn = existsSync(own);
    const agents = projectAgentsFolders(folder, sources.home);
    // The trust store is read only for a project with skills of its own: HADAL needs no trust from one without.
    const decision =
        hasOwn || agents.length > 0
            ? decides(savedDecision(folder, sources.agentDir), sources)
            : "undecided";
    // HADAL's folder and the home folder's `.agents` are the base of the exclusions for the skills in each.
    const user: [string, string][] = [
        [join(sources.agentDir, "skills"), sources.agentDir],
        [join(sources.home, ".agents", "skills"), join(sources.home, ".agents")],
    ];
    const entries = [...sources.settingsPaths];
    const paths = entries.filter((each) => !isPattern(each));
    const listed = paths.flatMap((raw) => {
        const each = raw.trim();

        return skillFilesAt(
            resolve(
                sources.agentDir,
                each.startsWith("~/") ? join(sources.home, each.slice(2)) : each,
            ),
        );
    });

    return [
        ...(hasOwn && decision !== "distrusted" ? [own] : []),
        ...(decision === "trusted" ? agents : []),
        ...enabledBy(listed, entries.filter(isPattern), sources.agentDir, sources.home),
        ...user.flatMap(([folder, base]) =>
            enabledBy(
                skillFilesAt(folder),
                entries.filter((each) => /^[-+!]/.test(each)),
                base,
                sources.home,
            ),
        ),
    ];
}

/** HADAL's skills for a session in `cwd`: the first of each name, from `skillPlaces`. */
export function loadSessionSkills(cwd: string, sources: SkillSources): Skill[] {
    return loadSkills({
        cwd,
        agentDir: sources.agentDir,
        skillPaths: skillPlaces(cwd, sources),
        includeDefaults: false,
    }).skills;
}

/** Whether HADAL trusts the project a session in `cwd` works in, and the project skills that wait for it. */
export function readProjectTrust(cwd: string, sources: SkillSources): ProjectTrust {
    const folder = canonical(cwd);
    const parent = dirname(folder);
    const saved = savedDecision(cwd, sources.agentDir);
    const folders = projectAgentsFolders(resolve(cwd), sources.home);
    const own = join(resolve(cwd), CONFIG_DIR_NAME, "skills");
    const skillsIn = (paths: string[]) =>
        paths.length === 0
            ? []
            : loadSkills({
                  cwd,
                  agentDir: sources.agentDir,
                  skillPaths: paths,
                  includeDefaults: false,
              }).skills.map(({ name, description }) => ({ name, description }));
    const skills = skillsIn(folders);
    const ownSkills = skillsIn(existsSync(own) ? [own] : []);
    const settings = existsSync(join(folder, CONFIG_DIR_NAME, "settings.json"));

    return {
        folder,
        ...(parent === folder ? {} : { parent }),
        saved: saved ?? null,
        defaultProjectTrust: sources.defaultProjectTrust,
        trusted: decides(saved, sources) === "trusted",
        folders,
        skills,
        ownSkills,
        settings,
        // Empty skill folders do not ask, but a settings-only project does. An unreadable trust store cannot save.
        ask:
            (skills.length > 0 || settings) &&
            saved === null &&
            sources.defaultProjectTrust === "ask",
        ...(saved === undefined ? { unreadable: true as const } : {}),
    };
}

/** Save an answer to "trust this project?" for a session in `cwd` in Pi's trust store, as Pi's `/trust` saves it. */
export function saveProjectTrust(cwd: string, agentDir: string, choice: TrustChoice): void {
    const folder = canonical(cwd);
    const parent = dirname(folder);
    const store = new ProjectTrustStore(agentDir);

    if (choice !== "trust-parent") {
        store.set(folder, choice === "trust");

        return;
    }

    if (parent === folder) {
        throw new Error(`${folder} has no folder above it.`);
    }

    // The folder's own decision goes, so the one for the folder above applies to it.
    store.setMany([
        { path: parent, decision: true },
        { path: folder, decision: null },
    ]);
}

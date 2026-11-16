/**
 * HADAL's environment and data folder, with the names it had as Pi Pocket still honoured. A setting is read as
 * `HADAL_<NAME>` first and `PI_POCKET_<NAME>` after, so an install's existing unit files and shell profiles keep
 * working. The data folder moved from `~/.pi-pocket` to `~/.hadal`: `migrateDataDir` renames it once and leaves
 * a link at the old path, so scripts and drop-ins that still name `~/.pi-pocket` find the same files.
 */
import { existsSync, lstatSync, renameSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENV_PREFIX = "HADAL_";
const LEGACY_PREFIX = "PI_POCKET_";

/** A setting from the environment: `HADAL_<name>`, else `PI_POCKET_<name>`. An empty value counts as set. */
export function env(name: string, from: NodeJS.ProcessEnv = process.env): string | undefined {
    return from[ENV_PREFIX + name] ?? from[LEGACY_PREFIX + name];
}

/** The data folder's default place, and the one it had before the rename. */
export function dataDirs(home = homedir()): { current: string; legacy: string } {
    return { current: join(home, ".hadal"), legacy: join(home, ".pi-pocket") };
}

/**
 * The data folder: the one the environment names, else `~/.hadal`, else a `~/.pi-pocket` not yet moved. Reads
 * only; `migrateDataDir` does the move.
 */
export function resolveDataDir(from: NodeJS.ProcessEnv = process.env, home = homedir()): string {
    const named = env("DIR", from);

    if (named) {
        return named;
    }

    const { current, legacy } = dataDirs(home);

    return !existsSync(current) && existsSync(legacy) ? legacy : current;
}

/**
 * Moves `~/.pi-pocket` to `~/.hadal` and links the old path to the new one. Does nothing when the environment
 * names a folder, when the new folder exists, or when the old path is missing or already a link. A rename, never a
 * copy: the database can be hundreds of megabytes, and a rename keeps it whole. Returns what it did, for the log.
 */
export function migrateDataDir(
    from: NodeJS.ProcessEnv = process.env,
    home = homedir(),
): string | undefined {
    if (env("DIR", from)) {
        return undefined;
    }

    const { current, legacy } = dataDirs(home);

    if (existsSync(current) || !existsSync(legacy) || lstatSync(legacy).isSymbolicLink()) {
        return undefined;
    }

    renameSync(legacy, current);
    symlinkSync(current, legacy, "dir");

    return `Moved the data folder from ${legacy} to ${current} (the old path links to it).`;
}

/** The database file in the data folder, and the name it had before the rename. */
export const DATABASE = "hadal.sqlite";
const LEGACY_DATABASE = "pocket.sqlite";

/**
 * Renames the database from `pocket.sqlite` to `hadal.sqlite` (with its `-wal` and `-shm`) before it opens, and links
 * the old name to the new one, so an older build started on the same folder opens the same data rather than a new,
 * empty database. Does nothing when `hadal.sqlite` exists or there is no old file. Returns what it did, for the log.
 */
export function migrateDatabase(dataDir: string): string | undefined {
    const current = join(dataDir, DATABASE);
    const legacy = join(dataDir, LEGACY_DATABASE);

    if (existsSync(current) || !existsSync(legacy) || lstatSync(legacy).isSymbolicLink()) {
        return undefined;
    }

    // The journal files first: a database renamed without its WAL would open without its last writes.
    for (const suffix of ["-wal", "-shm"]) {
        if (existsSync(legacy + suffix)) {
            renameSync(legacy + suffix, current + suffix);
        }
    }

    renameSync(legacy, current);
    symlinkSync(DATABASE, legacy);

    return `Renamed the database from ${LEGACY_DATABASE} to ${DATABASE} (the old name links to it).`;
}

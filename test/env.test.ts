// HADAL's settings and data folder keep Pi Pocket's names working: HADAL_* wins over PI_POCKET_*, and
// ~/.pi-pocket moves to ~/.hadal once, with a link left at the old path.
import assert from "node:assert/strict";
import {
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { env, migrateDatabase, migrateDataDir, resolveDataDir } from "../src/server/env.ts";

const home = () => mkdtempSync(join(tmpdir(), "hadal-home-"));

test("a HADAL_ setting wins over its PI_POCKET_ name, which still counts alone", () => {
    assert.equal(env("PORT", { HADAL_PORT: "1", PI_POCKET_PORT: "2" }), "1");
    assert.equal(env("PORT", { PI_POCKET_PORT: "2" }), "2");
    assert.equal(env("PORT", {}), undefined);
    assert.equal(env("GUARD", { HADAL_GUARD: "", PI_POCKET_GUARD: "off" }), "");
});

test("the data folder named in the environment is used as it is and never moved", () => {
    const dir = home();

    mkdirSync(join(dir, ".pi-pocket"));

    assert.equal(resolveDataDir({ PI_POCKET_DIR: "/x" }, dir), "/x");
    assert.equal(migrateDataDir({ HADAL_DIR: "/x" }, dir), undefined);
    assert.ok(lstatSync(join(dir, ".pi-pocket")).isDirectory());
    rmSync(dir, { recursive: true });
});

test("a fresh home gets ~/.hadal", () => {
    const dir = home();

    assert.equal(resolveDataDir({}, dir), join(dir, ".hadal"));
    assert.equal(migrateDataDir({}, dir), undefined);
    rmSync(dir, { recursive: true });
});

test("~/.pi-pocket is read until it is moved, then moved whole with a link back", () => {
    const dir = home();
    const legacy = join(dir, ".pi-pocket");
    const current = join(dir, ".hadal");

    mkdirSync(legacy);
    writeFileSync(join(legacy, "config.json"), "{}");

    assert.equal(resolveDataDir({}, dir), legacy);
    assert.match(migrateDataDir({}, dir) ?? "", /Moved the data folder/);
    assert.ok(lstatSync(current).isDirectory());
    assert.ok(lstatSync(legacy).isSymbolicLink());
    assert.equal(realpathSync(legacy), realpathSync(current));
    assert.equal(readFileSync(join(legacy, "config.json"), "utf8"), "{}");
    assert.equal(resolveDataDir({}, dir), current);
    // A second start finds the link and leaves it.
    assert.equal(migrateDataDir({}, dir), undefined);
    rmSync(dir, { recursive: true });
});

test("nothing moves when both folders exist", () => {
    const dir = home();

    mkdirSync(join(dir, ".pi-pocket"));
    mkdirSync(join(dir, ".hadal"));

    assert.equal(migrateDataDir({}, dir), undefined);
    assert.ok(lstatSync(join(dir, ".pi-pocket")).isDirectory());
    assert.equal(resolveDataDir({}, dir), join(dir, ".hadal"));
    rmSync(dir, { recursive: true });
});

test("the database is renamed to hadal.sqlite with its journal, once, and the old name links to it", () => {
    const dir = mkdtempSync(join(tmpdir(), "hadal-db-"));

    writeFileSync(join(dir, "pocket.sqlite"), "db");
    writeFileSync(join(dir, "pocket.sqlite-wal"), "wal");

    assert.match(migrateDatabase(dir) ?? "", /hadal\.sqlite/);
    assert.equal(readFileSync(join(dir, "hadal.sqlite"), "utf8"), "db");
    assert.equal(readFileSync(join(dir, "hadal.sqlite-wal"), "utf8"), "wal");
    assert.equal(
        readFileSync(join(dir, "pocket.sqlite"), "utf8"),
        "db",
        "the old name reads the same file",
    );
    assert.equal(migrateDatabase(dir), undefined, "a second start does nothing");
    rmSync(dir, { recursive: true, force: true });
});

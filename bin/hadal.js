#!/usr/bin/env node
// HADAL's launcher entry. It checks the Node version, then runs src/launcher/main.ts (Node strips its types, with
// help from strip-types.js in an npm install): pick how devices reach the server, then run it, restart it when the app
// asks (exit code 75, or SIGUSR2) or after a crash, and keep any tunnel up across restarts. Work in flight survives
// restarts: the durable harness resumes it.
const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 19)) {
    console.error(`HADAL needs Node.js 22.19 or newer (found ${process.versions.node}).`);
    process.exit(1);
}

// The first release of each line with the October 21, 2026 security fixes (TLS hostname checks, Brotli,
// dns.resolve). Older ones still run, with a warning; a line not listed here gets none.
const patched = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
const patch = Number(process.versions.node.split(".")[2]);
const fixed = patched[major];

if (fixed && (minor < fixed[0] || (minor === fixed[0] && patch < fixed[1]))) {
    console.warn(
        `Node.js ${process.versions.node} lacks security fixes: update to ${major}.${fixed.join(".")} or newer.`,
    );
}

// From an npm install, Node needs help to run TypeScript: strip-types.js gives it.
await import("./strip-types.js");

// Two programs under one name: `serve` runs the launcher as it always has, and `cli`/`run` are a terminal tab in a
// session. A bare `hadal` stays the launcher, so every existing command line works unchanged.
const sub = process.argv[2];

if (sub === "cli" || sub === "run") {
    await import("../src/cli/main.ts");
} else {
    if (sub === "serve") {
        process.argv.splice(2, 1);
    }

    await import("../src/launcher/main.ts");
}

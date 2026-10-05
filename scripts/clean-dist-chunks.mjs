#!/usr/bin/env node
// Remove a build's previous outputs before rebuilding: the named entry files, and
// split chunks (`*-*.js`) directly inside the given dist directory that are older
// than a week.
//
// Recent chunks are kept on purpose. OpenCode, Pi and worker processes load the
// plugin straight from a development checkout and stay up for days, and a split
// build imports some chunks lazily. Deleting every old chunk on rebuild made a
// still-running process fail with "Cannot find module .../index-<hash>.js" the
// first time it reached a lazy import. Chunk names are content hashes, so an old
// chunk never collides with a new one; keeping them only costs disk space.
//
// Usage: bun scripts/clean-dist-chunks.mjs <dist dir> [entry file ...]
//
// A plain `rm -f dist/*-*.js` in a package script fails on a clean checkout under
// Bun's script shell on Windows: the glob is expanded by the shell and an empty
// match aborts with "no matches found" before rm runs. Listing the directory
// here makes "nothing to remove" an ordinary, successful case on every platform.
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const [distDir, ...entries] = process.argv.slice(2);
if (!distDir) {
    console.error("usage: clean-dist-chunks.mjs <dist dir> [entry file ...]");
    process.exit(2);
}

let names;
try {
    names = readdirSync(distDir);
} catch (error) {
    if (error && error.code === "ENOENT") process.exit(0);
    throw error;
}

// Split chunks are named `<name>-<hash>.js`; entry files are named explicitly.
const chunk = /^[^/\\]+-[^/\\]+\.js$/;
const KEEP_CHUNKS_MS = 7 * 24 * 60 * 60 * 1000;
const cutoff = Date.now() - KEEP_CHUNKS_MS;
const targets = new Set(entries);
for (const name of names) {
    if (!chunk.test(name) || targets.has(name)) continue;
    let modified;
    try {
        modified = statSync(join(distDir, name)).mtimeMs;
    } catch {
        continue;
    }
    if (modified < cutoff) targets.add(name);
}
for (const name of targets) rmSync(join(distDir, name), { force: true });

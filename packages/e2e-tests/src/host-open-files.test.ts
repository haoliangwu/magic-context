import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectHostOpenFiles } from "./host-open-files";
import { cleanupE2ETempDir, createE2ETempDir } from "./temp-dir";

async function withOpenFile(path: string, check: (pid: number) => void) {
    const child = spawn(process.execPath, ["-e", `
        const fs = require("node:fs");
        const fd = fs.openSync(${JSON.stringify(path)}, "r");
        console.log("ready");
        setInterval(() => fs.fstatSync(fd), 1000);
    `], { stdio: ["ignore", "pipe", "pipe"] });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
        await new Promise<void>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code) => reject(new Error(`inventory fixture exited: ${code}`)));
            child.stdout!.once("data", () => resolve());
        });
        check(child.pid!);
    } finally {
        child.kill("SIGKILL");
        await closed;
    }
}

test("host inventory proves the actual process holds its private database inode", async () => {
    const root = createE2ETempDir("host-inventory-");
    const database = join(root, "context.db");
    writeFileSync(database, "throwaway descriptor sentinel, not a SQLite store");
    try {
        await withOpenFile(database, (pid) => {
            expect(inspectHostOpenFiles(pid, root, database).databases).toContain(database);
        });
    } finally { cleanupE2ETempDir(root); }
});

test("host inventory rejects a real forbidden open database outside the fixture", async () => {
    const base = createE2ETempDir("host-inventory-control-");
    const root = join(base, "private");
    mkdirSync(root);
    const forbidden = join(base, "forbidden.db");
    writeFileSync(forbidden, "throwaway descriptor sentinel, never a live store");
    try {
        await withOpenFile(forbidden, (pid) => {
            expect(() => inspectHostOpenFiles(pid, root)).toThrow(`forbidden open path: ${forbidden}`);
        });
    } finally { cleanupE2ETempDir(base); }
});

test("host inventory rejects a wrapper PID holding only an unrelated private database", async () => {
    const root = createE2ETempDir("host-inventory-wrapper-");
    const expected = join(root, "context.db");
    const unrelated = join(root, "wrapper.db");
    for (const path of [expected, unrelated]) writeFileSync(path, "throwaway descriptor sentinel");
    try {
        await withOpenFile(unrelated, (pid) => {
            expect(() => inspectHostOpenFiles(pid, root, expected)).toThrow("does not hold the expected database inode");
        });
    } finally { cleanupE2ETempDir(root); }
});

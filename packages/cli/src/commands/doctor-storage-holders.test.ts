import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { defaultInspectHolders } from "./doctor-repair-db";
import { processReferencesStorage, textReferencesStorage } from "./doctor-storage-holders";

const target = "/tmp/mc-isolated-store";
const live = "/tmp/mc-default-store";
const options = {
    defaultStorageDir: live,
    inspectRpc: () => ({ state: "absent" as const, serverPids: [] }),
    inspectPi: () => ({ state: "inconclusive" as const, processIds: [], inconclusivePids: [4242] }),
    probeFiles: () => ({ status: "free" as const }),
    processReferences: () => false,
};

describe("storage-scoped maintenance holders", () => {
    test("default target refuses an ambiguous Pi process", () => {
        expect(defaultInspectHolders(live, options).safe).toBe(false);
    });
    test("non-default target allows an unrelated ambiguous Pi process", () => {
        expect(defaultInspectHolders(target, options).safe).toBe(true);
    });
    test("non-default target refuses a Pi environment naming it", () => {
        const result = defaultInspectHolders(target, {
            ...options,
            processReferences: (pid: number, dir: string) => pid === 4242 && dir === target,
        });
        expect(result.safe).toBe(false);
        expect(result.blockers).toContain("Pi/OMP harness (PID 4242)");
    });
    test("non-default target refuses an lsof failure", () => {
        expect(
            defaultInspectHolders(target, {
                ...options,
                probeFiles: () => ({ status: "unknown" as const, reason: "lsof failed" }),
            }).safe,
        ).toBe(false);
    });
    test("non-default target refuses a target-file holder", () => {
        const result = defaultInspectHolders(target, {
            ...options,
            probeFiles: () => ({ status: "in_use" as const, pids: [1234] }),
        });
        expect(result.safe).toBe(false);
        expect(result.blockers).toContain("database holder (PID 1234)");
    });
});

test("process metadata recognizes explicit storage paths without sibling false positives", () => {
    expect(textReferencesStorage(`node pi MAGIC_CONTEXT_STORAGE_DIR=${target}`, target)).toBe(true);
    expect(textReferencesStorage(`node pi\0MAGIC_CONTEXT_STORAGE_DIR=${target}\0`, target)).toBe(
        true,
    );
    expect(textReferencesStorage(`node pi --storage-dir '${target}'`, target)).toBe(true);
    expect(
        textReferencesStorage(
            `node pi XDG_DATA_HOME=/tmp/root`,
            "/tmp/root/cortexkit/magic-context",
        ),
    ).toBe(true);
    expect(textReferencesStorage(`node pi MAGIC_CONTEXT_STORAGE_DIR=${target}-other`, target)).toBe(
        false,
    );
    expect(textReferencesStorage("pi", target)).toBe(false);
});

test.skipIf(process.platform === "win32")(
    "reads a real child process storage environment",
    async () => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
            env: { ...process.env, MAGIC_CONTEXT_STORAGE_DIR: target },
            stdio: "ignore",
            windowsHide: true,
        });
        try {
            await new Promise<void>((resolve, reject) => {
                child.once("spawn", resolve);
                child.once("error", reject);
            });
            expect(processReferencesStorage(child.pid as number, target)).toBe(true);
            expect(processReferencesStorage(child.pid as number, `${target}-other`)).toBe(false);
        } finally {
            child.kill();
        }
    },
);

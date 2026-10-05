/// <reference types="bun-types" />

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginConfig } from "../../config";
import {
    type ContextDatabase,
    closeDatabase,
    openDatabase,
} from "../../features/magic-context/storage";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { registerTools } from "./tools";
import type { V2Context } from "./types";

let dir: string;
let db: ContextDatabase;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    dir = createTestTempDirFromPath(join(tmpdir(), "mc-v2-tool-backends-"));
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "cortexkit", "magic-context"), { recursive: true });
    const opened = openDatabase();
    if (!opened) throw new Error("test database unavailable");
    db = opened;
});

afterEach(() => {
    closeDatabase(db);
    rmSync(dir, { recursive: true, force: true });
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

interface RegisteredTool {
    name: string;
    execute: (input: unknown, call: Record<string, unknown>) => Promise<{ content: string }>;
}

/** Stands in for the host's tool editor: `add` populates the map the host would keep. */
function hostContext(registered: RegisteredTool[]): V2Context {
    return {
        location: { directory: dir },
        tool: {
            async transform(callback: (editor: { add: (tool: RegisteredTool) => void }) => void) {
                callback({ add: (tool) => registered.push(tool) });
            },
        },
    } as unknown as V2Context;
}

/** Every module facade call the registered tools made, in order. */
const calls: string[] = [];

test("Rust-mode note tools read the shared store without a module facade", async () => {
    calls.length = 0;
    const backends: RustToolBackends = {
        authorityState: async () => "MODULE",
        note: async ({ action }) => {
            calls.push(`note:${action}`);
            return "note stored by the module";
        },
    } as unknown as RustToolBackends;

    const registered: RegisteredTool[] = [];
    await registerTools(
        hostContext(registered),
        db,
        parsePluginConfig({ memory: { enabled: true } }),
        backends,
    );
    const note = registered.find((tool) => tool.name === "ctx_note");
    expect(note).toBeDefined();

    await note!.execute(
        { action: "read" },
        {
            sessionID: "ses-1",
            messageID: "msg-1",
            agent: "build",
            progress: () => {},
        },
    );
    expect(calls).toEqual([]);
});

test("without backends the same registration keeps the host-only tools", async () => {
    calls.length = 0;
    const registered: RegisteredTool[] = [];
    await registerTools(
        hostContext(registered),
        db,
        parsePluginConfig({ memory: { enabled: true } }),
        undefined,
    );
    const note = registered.find((tool) => tool.name === "ctx_note");
    expect(note).toBeDefined();
    await note!.execute(
        { action: "read" },
        { sessionID: "ses-1", messageID: "msg-1", agent: "build", progress: () => {} },
    );
    expect(calls).toEqual([]);
});

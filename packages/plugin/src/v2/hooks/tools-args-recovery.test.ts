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
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { registerTools } from "./tools";
import type { V2Context } from "./types";

/**
 * The OpenCode 2 adapter must hand each tool the same arguments OpenCode 1 does.
 * Every ctx_* tool parses its own arguments with passthrough and falls back to
 * the raw input, so it can recover a call whose real arguments arrived wrapped
 * as `{ reduced: true, summary: "<json>" }` and tolerate a wrongly typed field.
 * A strict parse in the adapter stripped `reduced`/`summary` and threw on a bad
 * type before the tool ever saw the call.
 */

let dir: string;
let db: ContextDatabase;
const originalXdgDataHome = process.env.XDG_DATA_HOME;

beforeEach(() => {
    dir = createTestTempDirFromPath(join(tmpdir(), "mc-v2-tool-args-"));
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

async function registeredSearch(): Promise<RegisteredTool> {
    const registered: RegisteredTool[] = [];
    const context = {
        location: { directory: dir },
        tool: {
            async transform(callback: (editor: { add: (tool: RegisteredTool) => void }) => void) {
                callback({ add: (tool) => registered.push(tool) });
            },
        },
    } as unknown as V2Context;
    await registerTools(context, db, parsePluginConfig({ memory: { enabled: true } }), undefined);
    const search = registered.find((tool) => tool.name === "ctx_search");
    if (!search) throw new Error("ctx_search was not registered");
    return search;
}

const call = { sessionID: "ses-1", messageID: "msg-1", agent: "build", progress: () => {} };

test("ctx_search recovers arguments wrapped as reduced/summary", async () => {
    const search = await registeredSearch();
    const result = await search.execute(
        { reduced: true, summary: JSON.stringify({ query: "leader election" }) },
        call,
    );
    expect(result.content).not.toContain("'query' is required");
});

test("ctx_search tolerates a wrongly typed argument instead of throwing", async () => {
    const search = await registeredSearch();
    const result = await search.execute({ query: "leader election", limit: "5" }, call);
    expect(result.content).not.toContain("'query' is required");
});

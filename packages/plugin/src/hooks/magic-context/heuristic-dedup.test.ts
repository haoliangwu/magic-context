import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getTagsBySession,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import { type MessageLike, tagMessages } from "./tag-messages";

const session = "heuristic-dedup";
let db: NonNullable<ReturnType<typeof openDatabase>>;
let root: string;
let originalData: string | undefined;
let originalStorage: string | undefined;

beforeEach(() => {
    originalData = process.env.XDG_DATA_HOME;
    originalStorage = process.env.MAGIC_CONTEXT_STORAGE_DIR;
    root = createTestTempDirFromPath(join(tmpdir(), "heuristic-dedup-"));
    process.env.XDG_DATA_HOME = root;
    process.env.MAGIC_CONTEXT_STORAGE_DIR = root;
    db = openDatabase()!;
});

afterEach(() => {
    closeDatabase();
    if (originalData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalData;
    if (originalStorage === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    else process.env.MAGIC_CONTEXT_STORAGE_DIR = originalStorage;
    rmSync(root, { recursive: true, force: true });
});

// A completed tool part as OpenCode 1.18.30 hands it to the transform: the bare
// tool name (`read`, never `mcp_read`) and one shared owner for parallel calls.
function readPart(callID: string) {
    return {
        type: "tool",
        tool: "read",
        callID,
        state: {
            status: "completed",
            input: { filePath: "/work/probe.txt" },
            output: `1: hello probe (${callID})`,
        },
    };
}

function parallelReads(count: number): MessageLike[] {
    return [
        { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "read it" }] },
        {
            info: { id: "a1", role: "assistant" },
            parts: Array.from({ length: count }, (_, index) => readPart(`call-${index}`)),
        },
        { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: "thanks" }] },
    ];
}

function runCleanup(messages: MessageLike[], protectNewest: number) {
    const tagger = createTagger();
    tagger.initFromDb(session, db);
    const tagged = tagMessages(session, messages, tagger, db);
    const toolTags = getTagsBySession(db, session)
        .filter((tag) => tag.type === "tool")
        .map((tag) => tag.tagNumber)
        .sort((left, right) => left - right);
    const protectedTagNumbers = new Set(toolTags.slice(toolTags.length - protectNewest));
    const result = applyHeuristicCleanup(session, db, tagged.targets, tagged.messageTagNumbers, {
        protectedTagNumbers,
        protectedCutoff: protectNewest > 0 ? Math.min(...protectedTagNumbers) : null,
    });
    tagged.batch.finalize();
    const statuses = getTagsBySession(db, session)
        .filter((tag) => tag.type === "tool")
        .sort((left, right) => left.tagNumber - right.tagNumber)
        .map((tag) => [tag.messageId, tag.status]);
    return { result, statuses };
}

describe("heuristic dedup on OpenCode tool names", () => {
    it("drops the older of two parallel identical bare `read` calls", () => {
        const { result, statuses } = runCleanup(parallelReads(2), 0);
        expect(result.deduplicatedTools).toBe(1);
        expect(statuses).toEqual([
            ["call-0", "dropped"],
            ["call-1", "active"],
        ]);
    });

    it("keeps exactly one copy when the newest duplicate is protected", () => {
        const { result, statuses } = runCleanup(parallelReads(3), 1);
        expect(result.deduplicatedTools).toBe(2);
        expect(statuses).toEqual([
            ["call-0", "dropped"],
            ["call-1", "dropped"],
            ["call-2", "active"],
        ]);
    });

    it("never drops a protected duplicate even when a newer copy exists", () => {
        const { result, statuses } = runCleanup(parallelReads(3), 2);
        expect(result.deduplicatedTools).toBe(1);
        expect(statuses).toEqual([
            ["call-0", "dropped"],
            ["call-1", "active"],
            ["call-2", "active"],
        ]);
    });
});

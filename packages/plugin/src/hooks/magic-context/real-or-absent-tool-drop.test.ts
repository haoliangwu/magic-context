/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fixture from "../../../../../tests/fixtures/tool-input-string-bytes.json";
import {
    closeDatabase,
    getTagById,
    openDatabase,
    queuePendingOp,
    updateTagDropMode,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { createDroppedInputGuard } from "./dropped-input-guard";
import {
    isSmallToolInput,
    SKELETON_REAL_INPUT_MAX_BYTES,
    toolInputStringBytes,
} from "./tool-input-size";
import {
    applyFlushedStatuses,
    applyPendingOperations,
    type MessageLike,
    tagMessages,
} from "./transform-operations";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function freshDb() {
    const dir = createTestTempDirFromPath(join(tmpdir(), "real-or-absent-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    return openDatabase();
}

function toolTurn(id: string, callId: string, input: unknown, output: string): MessageLike {
    return {
        info: { id, role: "assistant", sessionID: "ses-1" },
        parts: [
            {
                type: "tool",
                tool: "write",
                callID: callId,
                state: { status: "completed", input, output },
            },
        ],
    } as MessageLike;
}

function userTurn(id: string, text: string): MessageLike {
    return {
        info: { id, role: "user", sessionID: "ses-1" },
        parts: [{ type: "text", text }],
    } as MessageLike;
}

function servedPart(messages: MessageLike[], callId: string) {
    return messages
        .flatMap((m) => m.parts)
        .find((p) => (p as { callID?: string }).callID === callId) as
        | { state: { input: unknown; output: string } }
        | undefined;
}

describe("tool input size", () => {
    it("matches the shared cross-lane fixture", () => {
        expect(fixture.max_small_bytes).toBe(SKELETON_REAL_INPUT_MAX_BYTES);
        for (const testCase of fixture.cases) {
            expect({ name: testCase.name, bytes: toolInputStringBytes(testCase.input) }).toEqual({
                name: testCase.name,
                bytes: testCase.expected_bytes,
            });
            expect(isSmallToolInput(testCase.input)).toBe(testCase.expected_small);
        }
    });
});

describe("real-or-absent drops inside the newest-call window", () => {
    function dropOne(input: unknown, endsRequest: boolean) {
        const db = freshDb();
        const tagger = createTagger();
        const messages: MessageLike[] = [
            toolTurn("m-call", "call-1", input, "the output"),
            ...(endsRequest ? [] : [userTurn("m-next", "next prompt")]),
        ];
        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const tag = tagger.getToolTag("ses-1", "call-1", "m-call")!;
        queuePendingOp(db, "ses-1", tag, "drop");
        applyPendingOperations("ses-1", db, targets, new Set());
        batch.finalize();
        return { db, tag, messages };
    }

    it("keeps real arguments for an input of exactly 1024 bytes", () => {
        const input = { content: "a".repeat(1024) };
        const { db, tag, messages } = dropOne(input, false);
        expect(getTagById(db, "ses-1", tag)?.dropMode).toBe("skeleton_real");
        const part = servedPart(messages, "call-1");
        expect(part?.state.input).toEqual(input);
        expect(part?.state.output).toBe(`[dropped \u00a7${tag}\u00a7]`);
    });

    it("removes the call and its result for an input of 1025 bytes", () => {
        const { db, tag, messages } = dropOne({ content: "a".repeat(1025) }, false);
        expect(getTagById(db, "ses-1", tag)?.dropMode).toBe("full");
        expect(servedPart(messages, "call-1")).toBeUndefined();
    });

    it("keeps the call whose result ends the request, with its real arguments", () => {
        const input = { content: "b".repeat(5000) };
        const { db, tag, messages } = dropOne(input, true);
        expect(getTagById(db, "ses-1", tag)?.dropMode).toBe("skeleton_real");
        const part = servedPart(messages, "call-1");
        expect(part?.state.input).toEqual(input);
        expect(part?.state.output).toBe(`[dropped \u00a7${tag}\u00a7]`);
        expect(JSON.stringify(messages)).not.toContain('"dropped":');
    });

    it("serves the same bytes over the shared prefix on the next defer pass", () => {
        const db = freshDb();
        const smallInput = { command: "ls -la" };
        const largeInput = { content: "c".repeat(3000) };
        const build = (withNewer: boolean): MessageLike[] => [
            userTurn("m-u1", "start"),
            toolTurn("m-small", "call-small", smallInput, "listing"),
            toolTurn("m-mid", "call-mid", { content: "m".repeat(2000) }, "mid output"),
            toolTurn("m-large", "call-large", largeInput, "large output"),
            ...(withNewer ? [userTurn("m-u2", "a newer message")] : []),
        ];
        const tagger = createTagger();
        const passA = build(false);
        const tagged = tagMessages("ses-1", passA, tagger, db);
        for (const [callId, owner] of [
            ["call-small", "m-small"],
            ["call-mid", "m-mid"],
            ["call-large", "m-large"],
        ] as const) {
            queuePendingOp(db, "ses-1", tagger.getToolTag("ses-1", callId, owner)!, "drop");
        }
        expect(applyPendingOperations("ses-1", db, tagged.targets, new Set())).toBe(true);
        tagged.batch.finalize();
        // Rule 1 (small), rule 2 (large, removed) and rule 3 (large, ends the request).
        expect(servedPart(passA, "call-small")?.state.input).toEqual(smallInput);
        expect(servedPart(passA, "call-mid")).toBeUndefined();
        expect(servedPart(passA, "call-large")?.state.input).toEqual(largeInput);

        const passB = build(true);
        const replayTagger = createTagger();
        replayTagger.initFromDb("ses-1", db);
        const replay = tagMessages("ses-1", passB, replayTagger, db);
        applyFlushedStatuses("ses-1", db, replay.targets);
        replay.batch.finalize();

        const sha = (messages: MessageLike[]) =>
            createHash("sha256").update(JSON.stringify(messages)).digest("hex");
        expect(passB.length).toBe(passA.length + 1);
        expect(sha(passB.slice(0, passA.length))).toBe(sha(passA));
    });

    it("keeps attachment-bearing priced-drop prefix hashes stable after append and defer", () => {
        const db = freshDb();
        const attachment = { type: "file", mime: "image/png", url: "data:image/png;base64,abcd" };
        const build = (append: boolean): MessageLike[] => {
            const call = toolTurn("m-image", "call-image", { path: "image.png" }, "image output");
            (call.parts[0] as { state: { attachments?: unknown[] } }).state.attachments = [
                attachment,
            ];
            return [
                userTurn("m-start", "start"),
                call,
                ...(append ? [userTurn("m-next", "next")] : []),
            ];
        };
        const priced = build(false);
        const tagger = createTagger();
        const { targets, batch } = tagMessages("ses-1", priced, tagger, db);
        const tag = tagger.getToolTag("ses-1", "call-image", "m-image")!;
        queuePendingOp(db, "ses-1", tag, "drop");
        expect(applyPendingOperations("ses-1", db, targets, new Set())).toBe(true);
        batch.finalize();
        expect(getTagById(db, "ses-1", tag)?.dropMode).toBe("skeleton_stripped");
        expect(
            (servedPart(priced, "call-image")?.state as { attachments: unknown[] }).attachments,
        ).toEqual([]);
        const deferred = build(true);
        const replayTagger = createTagger();
        replayTagger.initFromDb("ses-1", db);
        const replay = tagMessages("ses-1", deferred, replayTagger, db);
        applyFlushedStatuses("ses-1", db, replay.targets);
        replay.batch.finalize();
        const sha = (rows: MessageLike[]) =>
            createHash("sha256").update(JSON.stringify(rows)).digest("hex");
        expect(sha(deferred.slice(0, priced.length))).toBe(sha(priced));

        // A skeleton served by an older version retains its attachments on defer.
        updateTagDropMode(db, "ses-1", tag, "skeleton_real");
        const legacyA = build(false);
        const legacyB = build(true);
        for (const rows of [legacyA, legacyB]) {
            const t = createTagger();
            t.initFromDb("ses-1", db);
            const tagged = tagMessages("ses-1", rows, t, db);
            applyFlushedStatuses("ses-1", db, tagged.targets);
            tagged.batch.finalize();
        }
        expect(
            (servedPart(legacyA, "call-image")?.state as { attachments: unknown[] }).attachments,
        ).toEqual([attachment]);
        expect(sha(legacyB.slice(0, legacyA.length))).toBe(sha(legacyA));
    });

    it("lets a copied real-argument call through the dropped-input guard", () => {
        const input = { command: "git status --short" };
        const { messages } = dropOne(input, false);
        const copied = servedPart(messages, "call-1")?.state.input;
        expect(copied).toEqual(input);
        const guard = createDroppedInputGuard();
        expect(
            guard.check({ sessionID: "ses-1", toolName: "bash", input: copied }),
        ).toBeUndefined();
    });
});

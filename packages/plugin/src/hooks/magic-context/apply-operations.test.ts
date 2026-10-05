/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getTagById,
    insertTag,
    openDatabase,
    queuePendingOp,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { applyPendingOperations } from "./apply-operations";
import { type MessageLike, tagMessages } from "./tag-messages";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* ignore */
        }
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

const SES = "session-apply-test";

describe("applyPendingOperations with protection window set form", () => {
    it("consumes protectedTagIds in tag-number coordinate space and protects member tags", () => {
        useTempDataHome("apply-set-");
        const db = openDatabase();
        expect(db).toBeTruthy();

        const messages: MessageLike[] = [
            {
                info: { id: "m-assistant", role: "assistant", sessionID: SES },
                parts: [
                    { type: "tool-invocation", callID: "call-1" },
                    { type: "tool-invocation", callID: "call-2" },
                ],
            },
            {
                info: { id: "m-tool", role: "tool", sessionID: SES },
                parts: [
                    { type: "tool", callID: "call-1", state: { output: "result 1" } },
                    { type: "tool", callID: "call-2", state: { output: "result 2" } },
                ],
            },
        ];

        const tagger = createTagger(db!, SES);
        const { targets, batch } = tagMessages(SES, messages, tagger, db!);
        const tag1 = tagger.getToolTag(SES, "call-1", "m-assistant")!;
        const tag2 = tagger.getToolTag(SES, "call-2", "m-assistant")!;
        expect(tag1).toBeDefined();
        expect(tag2).toBeDefined();

        // Queue drops for both tag 1 and tag 2
        queuePendingOp(db!, SES, tag1, "drop");
        queuePendingOp(db!, SES, tag2, "drop");

        // Union projection form: protectedTagIds (set form) in tag-number coordinate space
        // Tag 2 is protected in the window; tag 1 is outside
        const protectedTagIds: ReadonlySet<number> = new Set([tag2]);

        const mutated = applyPendingOperations(SES, db!, targets, protectedTagIds);
        batch.finalize();

        expect(mutated).toBe(true);
        // Tag 1 was dropped
        expect(getTagById(db!, SES, tag1)?.status).toBe("dropped");
        // Tag 2 was protected by the window (skipped)
        expect(getTagById(db!, SES, tag2)?.status).toBe("active");
    });

    it("reports why a selected synthetic batch cannot mutate the visible payload", () => {
        useTempDataHome("apply-noop-reason-");
        const db = openDatabase();
        expect(db).toBeTruthy();
        insertTag(db!, SES, "call-protected", "tool", 4_000, 1);

        let diagnostics:
            | { total: number; mutated: number; reasons: Record<string, number> }
            | undefined;
        const mutated = applyPendingOperations(
            SES,
            db!,
            new Map([
                [
                    1,
                    {
                        canDrop: () => true,
                        truncate: () => "truncated" as const,
                        drop: () => "removed" as const,
                        setContent: () => true,
                    },
                ],
            ]),
            new Set([1]),
            undefined,
            undefined,
            [{ id: 0, sessionId: SES, tagId: 1, operation: "drop", queuedAt: 0 }],
            new Set(),
            undefined,
            (batch) => {
                diagnostics = batch;
            },
        );

        expect(mutated).toBe(false);
        expect(diagnostics).toEqual({
            source: "synthetic",
            total: 1,
            mutated: 0,
            persistedWithoutMutation: 0,
            reasons: { protected: 1 },
        });
    });

    it("declares and enforces empty-window behavior: empty set protects zero tool tags, but non-tool tags are never automatic reclaim targets", () => {
        useTempDataHome("apply-empty-");
        const db = openDatabase();
        expect(db).toBeTruthy();

        // 1 tool tag and 1 message tag
        insertTag(db!, SES, "msg-1", "tool", 100, 1);
        insertTag(db!, SES, "msg-2", "message", 100, 2);

        // Empty window: protectedTagIds is empty set
        const protectedTagIds: ReadonlySet<number> = new Set();

        // Synthetic automatic reclaim ops: only tool tags can be targeted
        const syntheticOps = [
            { id: 0, sessionId: SES, tagId: 1, operation: "drop" as const, queuedAt: 0 },
            { id: 0, sessionId: SES, tagId: 2, operation: "drop" as const, queuedAt: 0 },
        ];

        const targets = new Map();
        targets.set(1, {
            canDrop: () => true,
            truncate: () => "truncated",
            drop: () => "removed",
            setContent: () => true,
        });
        targets.set(2, {
            canDrop: () => true,
            truncate: () => "truncated",
            drop: () => "removed",
            setContent: () => true,
        });

        applyPendingOperations(
            SES,
            db!,
            targets,
            protectedTagIds,
            undefined,
            undefined,
            syntheticOps,
        );

        // Tool tag 1 dropped under empty window
        expect(getTagById(db!, SES, 1)?.status).toBe("dropped");
        // Non-tool (message) tag 2 never targeted by synthetic automatic reclaim
        expect(getTagById(db!, SES, 2)?.status).toBe("active");
    });
});

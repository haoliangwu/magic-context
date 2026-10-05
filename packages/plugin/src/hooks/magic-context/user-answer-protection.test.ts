import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getTagsBySession,
    insertTag,
    openDatabase,
    queuePendingOp,
} from "../../features/magic-context/storage";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { applyFlushedStatuses, applyPendingOperations } from "./apply-operations";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import { buildSupersessionReclaimOps } from "./supersession-reclaim";
import type { MessageLike, TagTarget } from "./tag-messages";
import { createToolDropTarget, type ToolCallIndex, ToolMutationBatch } from "./tool-drop-target";
import { buildSyntheticToolReclaimOps } from "./tool-reclaim";

const session = "answer-protection";
let db: NonNullable<ReturnType<typeof openDatabase>>;
let root: string;
let originalData: string | undefined;
let originalStorage: string | undefined;
let targets: Map<number, TagTarget>;
let messages: MessageLike[];

beforeEach(() => {
    originalData = process.env.XDG_DATA_HOME;
    originalStorage = process.env.MAGIC_CONTEXT_STORAGE_DIR;
    root = createTestTempDirFromPath(join(tmpdir(), "answer-protection-"));
    process.env.XDG_DATA_HOME = root;
    process.env.MAGIC_CONTEXT_STORAGE_DIR = root;
    db = openDatabase()!;
    targets = new Map();
    messages = [];
});
afterEach(() => {
    closeDatabase();
    if (originalData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalData;
    if (originalStorage === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
    else process.env.MAGIC_CONTEXT_STORAGE_DIR = originalStorage;
    rmSync(root, { recursive: true, force: true });
});

function add(tag: number, name: string, answer = false, repetitions = 1000) {
    const callID = `call-${tag}`;
    const part = {
        type: "tool",
        tool: name,
        callID,
        state: {
            status: "completed",
            input: {},
            output: "word ".repeat(repetitions),
            ...(answer ? { metadata: { answers: [["keep the decision"]] } } : {}),
        },
    };
    const message: MessageLike = {
        info: { id: `message-${tag}`, role: "assistant" },
        parts: [part],
    };
    messages.push(message);
    const index: ToolCallIndex = new Map([
        [callID, { hasResult: true, occurrences: [{ message, part, kind: "result" }] }],
    ]);
    targets.set(tag, createToolDropTarget(callID, [], index, new ToolMutationBatch(messages), tag));
    insertTag(db, session, callID, "tool", part.state.output.length, tag, 0, name, 0, null, null, {
        tokenCount: repetitions,
        inputTokenCount: 0,
        reasoningTokenCount: 0,
    });
    return part;
}

describe("user-answer automatic protection", () => {
    it("emergency preserves the largest tier-3 answer and reclaims other items below the limit", () => {
        const answer = add(1, "question", true, 8000);
        for (let n = 2; n <= 30; n++) add(n, "bash", false, 2000);
        const cleanup = applyHeuristicCleanup(session, db, targets, new Map(), {
            protectedTagNumbers: new Set(),
            protectedCutoff: null,
            emergency: { currentTotalInputTokens: 66000, ceilingTokens: 50000 },
        });
        expect(getTagsBySession(db, session).find((tag) => tag.tagNumber === 1)?.status).toBe(
            "active",
        );
        expect(messages[0].parts[0]).toBe(answer);
        expect(answer.state.output).toContain("word");
        expect(cleanup.emergencyDroppedTools).toBeGreaterThan(0);
        const retained = getTagsBySession(db, session)
            .filter((tag) => tag.status === "active")
            .reduce((sum, tag) => sum + (tag.tokenCount ?? 0), 0);
        expect(retained).toBeLessThan(50000);
    });

    it("age reclaim preserves an answered result regardless of tool name", () => {
        add(1, "renamed-question", true);
        add(2, "bash");
        const ops = buildSyntheticToolReclaimOps({ db, sessionId: session, targets, watermark: 2 });
        expect(ops.map((op) => op.tagId)).toEqual([2]);
        applyPendingOperations(session, db, targets, new Set(), undefined, [], ops);
        expect(getTagsBySession(db, session).find((tag) => tag.tagNumber === 1)?.status).toBe(
            "active",
        );
    });

    it("supersession preserves host-marked answers even on control-plane tools", () => {
        add(1, "todowrite", true);
        add(2, "todowrite");
        add(3, "todowrite");
        const ops = buildSupersessionReclaimOps({ db, sessionId: session, targets });
        expect(ops.map((op) => op.tagId)).toEqual([2]);
    });

    it("explicit ctx_reduce still drops an answered result", () => {
        add(1, "question", true);
        expect(targets.get(1)?.canDrop?.()).toBe(false);
        queuePendingOp(db, session, 1, "drop");
        expect(applyPendingOperations(session, db, targets, new Set())).toBe(true);
        expect(getTagsBySession(db, session)[0].status).toBe("dropped");
        expect(JSON.stringify(messages)).toContain("[dropped §1§]");
    });

    it("previously dropped answers remain dropped on defer replay", () => {
        add(1, "question", true);
        db.query(
            "UPDATE tags SET status = 'dropped', drop_mode = 'skeleton_real' WHERE session_id = ?",
        ).run(session);
        expect(targets.get(1)?.canDrop?.()).toBe(false);
        expect(applyFlushedStatuses(session, db, targets)).toBe(true);
        expect(JSON.stringify(messages)).toContain("[dropped §1§]");
    });

    it("dedup preserves host-marked answers on duplicate-safe tools", () => {
        add(1, "mcp_read", true);
        add(2, "mcp_read");
        add(3, "mcp_read");
        for (const message of messages) message.info.id = "parallel";
        db.query("UPDATE tags SET tool_owner_message_id = 'parallel' WHERE session_id = ?").run(
            session,
        );
        const cleanup = applyHeuristicCleanup(
            session,
            db,
            targets,
            new Map(messages.map((message) => [message, 1])),
            {
                protectedTagNumbers: new Set(),
                protectedCutoff: null,
            },
        );
        expect(getTagsBySession(db, session)[0].status).toBe("active");
        expect(cleanup.deduplicatedTools).toBe(1);
    });
});

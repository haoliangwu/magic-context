import { afterEach, expect, mock, test } from "bun:test";

import type {
    HiddenCompletion,
    HiddenCompletionExecutor,
} from "../../../hooks/magic-context/compartment-runner-types";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { reviewUserMemories } from "../user-memory/review-user-memories";
import {
    getActiveUserMemories,
    getUserMemoryCandidates,
    insertUserMemoryCandidates,
} from "../user-memory/storage-user-memory";
import { acquireLease } from "./lease";

function freshDb(leaseKey: string): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    expect(acquireLease(db, "holder", leaseKey)).toBe(true);
    return db;
}

/**
 * A completion carrier like the OpenCode 2 one: it advertises no tool loop and
 * answers with one settled completion. `opened`/`closed` record the run
 * lifecycle so a test can show the carrier, and not a child-session client, did
 * the work.
 */
function carrier(completion: Partial<HiddenCompletion>): {
    executor: HiddenCompletionExecutor;
    runs: { opened: number; closed: number };
} {
    const runs = { opened: 0, closed: 0 };
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: false, harness: "opencode2" },
        async open() {
            runs.opened += 1;
            return { id: "carrier-child", childSessionId: "carrier-child" };
        },
        async attempt() {},
        async collect() {
            return {
                text: null,
                reasoning: null,
                usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
                lengthCapped: false,
                ...completion,
            };
        },
        async close() {
            runs.closed += 1;
        },
    };
    return { executor, runs };
}

afterEach(() => {
    mock.restore();
});

test("review-user-memories runs on a carrier host and its promotion reaches the database", async () => {
    const db = freshDb("review-user-memories-carrier");
    insertUserMemoryCandidates(db, [{ content: "User prefers concise updates", sessionId: "s1" }]);
    const { executor, runs } = carrier({
        text: '{"promote":[{"content":"Prefers concise updates","candidate_ids":[1]}],"update_existing":[],"dismiss_existing":[],"consume_candidate_ids":[1]}',
    });

    const result = await reviewUserMemories({
        db,
        hiddenCompletionExecutor: executor,
        parentSessionId: undefined,
        sessionDirectory: "/repo/project",
        holderId: "holder",
        leaseKey: "review-user-memories-carrier",
        deadline: Date.now() + 60_000,
        promotionThreshold: 1,
    });

    expect(result.promoted).toBe(1);
    expect(runs.opened).toBe(1);
    expect(runs.closed).toBe(1);
    expect(getActiveUserMemories(db).map((memory) => memory.content)).toEqual([
        "Prefers concise updates",
    ]);
    expect(getUserMemoryCandidates(db)).toHaveLength(0);
    db.close();
});

test("a length-capped review answer is refused and changes nothing", async () => {
    const db = freshDb("review-user-memories-capped");
    insertUserMemoryCandidates(db, [{ content: "User prefers concise updates", sessionId: "s1" }]);
    // A provider that hit the output ceiling mid-object: the prefix would parse
    // as a promotion if anything applied a truncated answer.
    const { executor } = carrier({
        text: '{"promote":[{"content":"Prefers concise updates","candidate_ids":[1]}],"consume_candidate_ids":[1]}',
        lengthCapped: true,
    });

    await expect(
        reviewUserMemories({
            db,
            hiddenCompletionExecutor: executor,
            parentSessionId: undefined,
            sessionDirectory: "/repo/project",
            holderId: "holder",
            leaseKey: "review-user-memories-capped",
            deadline: Date.now() + 60_000,
            promotionThreshold: 1,
        }),
    ).rejects.toThrow("length-capped");

    expect(getActiveUserMemories(db)).toHaveLength(0);
    expect(getUserMemoryCandidates(db)).toHaveLength(1);
    db.close();
});

test("reasoning-only length-capped dreamer names its output budget setting", async () => {
    const db = freshDb("review-user-memories-reasoning-cap");
    insertUserMemoryCandidates(db, [{ content: "User prefers concise updates", sessionId: "s1" }]);
    const { executor } = carrier({
        text: null,
        reasoning: "private reasoning",
        lengthCapped: true,
    });
    await expect(
        reviewUserMemories({
            db,
            hiddenCompletionExecutor: executor,
            parentSessionId: undefined,
            sessionDirectory: "/repo/project",
            holderId: "holder",
            leaseKey: "review-user-memories-reasoning-cap",
            deadline: Date.now() + 60_000,
            promotionThreshold: 1,
        }),
    ).rejects.toThrow(/ran out of output budget while reasoning.*dreamer\.maxTokens/);
    expect(getActiveUserMemories(db)).toHaveLength(0);
    db.close();
});

test("a review answer truncated before its closing brace is refused and changes nothing", async () => {
    const db = freshDb("review-user-memories-truncated");
    insertUserMemoryCandidates(db, [{ content: "User prefers concise updates", sessionId: "s1" }]);
    const { executor } = carrier({
        text: '{"promote":[{"content":"Prefers concise updates","candidate_ids":[1]}],"consume_candidate_ids":[1',
    });

    await expect(
        reviewUserMemories({
            db,
            hiddenCompletionExecutor: executor,
            parentSessionId: undefined,
            sessionDirectory: "/repo/project",
            holderId: "holder",
            leaseKey: "review-user-memories-truncated",
            deadline: Date.now() + 60_000,
            promotionThreshold: 1,
        }),
    ).rejects.toThrow();

    expect(getActiveUserMemories(db)).toHaveLength(0);
    expect(getUserMemoryCandidates(db)).toHaveLength(1);
    db.close();
});

test("an empty carrier answer is refused rather than read as nothing to do", async () => {
    const db = freshDb("review-user-memories-empty");
    insertUserMemoryCandidates(db, [{ content: "User prefers concise updates", sessionId: "s1" }]);
    const { executor } = carrier({ text: null });

    await expect(
        reviewUserMemories({
            db,
            hiddenCompletionExecutor: executor,
            parentSessionId: undefined,
            sessionDirectory: "/repo/project",
            holderId: "holder",
            leaseKey: "review-user-memories-empty",
            deadline: Date.now() + 60_000,
            promotionThreshold: 1,
        }),
    ).rejects.toThrow("no output");

    expect(getUserMemoryCandidates(db)).toHaveLength(1);
    db.close();
});

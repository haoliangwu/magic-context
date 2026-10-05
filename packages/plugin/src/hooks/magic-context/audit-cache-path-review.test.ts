/// <reference types="bun-types" />

/**
 * Cache-stability guards from an adversarial review of cache-path changes: each
 * test states a byte-stability property that an earlier change broke and that
 * must keep holding (served bytes may only change on a pass that is already
 * rebuilding).
 */

import { describe, expect, it } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { type MessageLike, tagMessages } from "./tag-messages";

const SESSION_ID = "ses-audit-cache-path";

function toolTurn(output: string): MessageLike[] {
    return [
        {
            info: { id: "m-user", role: "user", sessionID: SESSION_ID },
            parts: [{ type: "text", text: "read the contract" }],
        },
        {
            info: { id: "m-asst", role: "assistant", sessionID: SESSION_ID },
            parts: [
                {
                    type: "tool",
                    callID: "call-1",
                    tool: "read",
                    state: { status: "completed", input: { path: "c.md" }, output },
                },
            ],
        },
    ] as unknown as MessageLike[];
}

function servedToolOutput(messages: MessageLike[]): string {
    const part = messages[1].parts[0] as { state: { output: string } };
    return part.state.output;
}

describe("dangling-tag prefix strip stays byte-stable on a defer pass", () => {
    // The leading strip (DANGLING_TAG_PREFIX_REGEX) makes the improvised closer
    // optional, so "§5 of ..." loses "§5". OpenCode re-prefixes a tool output from
    // the host's own text on every pass (tag-messages.ts:
    // `toolPart.state.output = prependTag(tagId, output)`), with no saved source
    // and no epoch, so any change to that rule would first apply on whatever pass
    // comes first after deploy, a defer pass included, and bust the cache.
    it("an already-tagged tool output serves the bytes the previous release served", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const hostOutput = "\u00a75 of the contract applies to every tenant";
            const previousReleaseServed = "\u00a72\u00a7 of the contract applies to every tenant";

            // The pass the previous release served: it created the tool tag (tag
            // rows record no output bytes, so the row is the same either way).
            const tagger = createTagger();
            tagger.initFromDb(SESSION_ID, db);
            tagMessages(SESSION_ID, toolTurn(hostOutput), tagger, db);

            // The first pass after deploy, in a fresh process, with nothing new: a
            // defer pass. It must serve the bytes already cached.
            const restarted = createTagger();
            restarted.initFromDb(SESSION_ID, db);
            const deferPass = toolTurn(hostOutput);
            tagMessages(SESSION_ID, deferPass, restarted, db);

            expect(servedToolOutput(deferPass)).toBe(previousReleaseServed);
        } finally {
            db.close();
        }
    });
});

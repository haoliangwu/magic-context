/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { type MessageLike, tagMessages } from "./tag-messages";

function buildMessages(sessionId: string, count: number): MessageLike[] {
    return Array.from({ length: count }, (_, index) => {
        const role = index % 2 === 0 ? "user" : "assistant";
        const parts: unknown[] =
            role === "user"
                ? [{ type: "text", text: `user message ${index}` }]
                : [
                      { type: "text", text: `assistant message ${index}` },
                      {
                          type: "tool",
                          callID: `call-${index}`,
                          tool: "read",
                          state: {
                              status: "completed",
                              input: { path: `/file-${index}` },
                              output: `tool output ${index}`,
                          },
                      },
                  ];
        return {
            info: { id: `msg-${index}`, role, sessionID: sessionId },
            parts,
        } as MessageLike;
    });
}

function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe("tagMessages steady replay cost", () => {
    test("keeps per-message cost load-invariant from 200 to 2,000 messages", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            const measure = (
                count: number,
            ): { perMessageCpuMs: number; fallbackLookups: number } => {
                const sessionId = `ses-perf-${count}`;
                const tagger = createTagger();
                tagger.initFromDb(sessionId, db);
                tagMessages(sessionId, buildMessages(sessionId, count), tagger, db);

                let fallbackLookups = 0;
                const samples: number[] = [];
                for (let pass = 0; pass < 5; pass += 1) {
                    tagger.initFromDb(sessionId, db);
                    const messages = buildMessages(sessionId, count);
                    const startedAt = process.cpuUsage();
                    tagMessages(sessionId, messages, tagger, db, {
                        onToolOwnerFallbackLookup: () => {
                            fallbackLookups += 1;
                        },
                    });
                    const elapsed = process.cpuUsage(startedAt);
                    samples.push((elapsed.user + elapsed.system) / 1000);
                }
                return { perMessageCpuMs: median(samples) / count, fallbackLookups };
            };

            const small = measure(200);
            const large = measure(2_000);
            expect(small.fallbackLookups).toBe(0);
            expect(large.fallbackLookups).toBe(0);

            const perMessageRatio = large.perMessageCpuMs / small.perMessageCpuMs;
            if (process.env.MC_PERF_GATE === "1") {
                expect(perMessageRatio).toBeLessThanOrEqual(3);
            } else {
                console.log(
                    `tagMessages per-message ratio 2000/200=${perMessageRatio.toFixed(2)} ` +
                        `(small=${small.perMessageCpuMs.toFixed(4)} CPU-ms large=${large.perMessageCpuMs.toFixed(4)}ms; perf gate off)`,
                );
            }
        } finally {
            closeQuietly(db);
        }
    });

    test("reads partial compartment ends once per pass, not once per text or file setContent", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const sessionId = "ses-partial-ends-once";
            const count = 40;
            // msg-1 ends a compartment at block 0, so its later blocks stay raw.
            db.prepare(
                "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, end_block_index, title, content, created_at) VALUES (?, 1, 0, 1, 'msg-0', 'msg-1', 0, 'partial', 'covers the first block', 1)",
            ).run(sessionId);
            const tagger = createTagger();
            tagger.initFromDb(sessionId, db);
            const messages = buildMessages(sessionId, count);
            messages[1]?.parts.push({ type: "text", text: "uncovered suffix" });
            const realPrepare = db.prepare.bind(db);
            let compartmentReads = 0;
            db.prepare = ((sql: string) => {
                if (/FROM compartments/.test(sql)) compartmentReads += 1;
                return realPrepare(sql);
            }) as typeof db.prepare;
            const { targets } = tagMessages(sessionId, messages, tagger, db);
            let textTargets = 0;
            let refused = 0;
            for (const target of targets.values()) {
                if (!target.getContent) continue;
                textTargets += 1;
                if (!target.setContent("[dropped]")) refused += 1;
            }
            expect(textTargets).toBeGreaterThan(count);
            // Only the uncovered suffix of msg-1 is refused by the partial-end guard.
            expect(refused).toBe(1);
            // One read covers every target in the pass (the tool targets share it).
            expect(compartmentReads).toBe(1);
        } finally {
            closeQuietly(db);
        }
    });
});

/// <reference types="bun-types" />

/**
 * Dropped tool calls stay "real or absent" through the Rust module on a real
 * OpenCode host (hermetic ck-subc + ck-mc stack).
 *
 * The session is built in TS mode, where queued drops land as the three shapes
 * of the rule: a small call in the newest-call window keeps its real arguments
 * (`skeleton_real`), a large call is removed (`full`), and the large call whose
 * result ends the request keeps its real arguments. One more small call is left
 * as a legacy `truncated` tag, the `{"dropped": …}` marker shape older sessions
 * serve. The project then flips to Rust mode: the module seeds those drops, its
 * first pass is a HARD fold that converts the legacy marker, and every request
 * must pass the Anthropic pairing and no-prefill checks with zero 400s.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    anthropicViolation,
    blocks,
    findToolResult,
    findToolUse,
    resultText,
    type WireMessage,
} from "../src/anthropic-request-validator";
import type { MockResponse } from "../src/mock-provider/server";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";
import { openTestDb } from "../src/test-db";

const LOW = { input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 0 };
// 97.5% of the 20k window: the next TS pass is a forced bust that drains queued drops.
const HIGH = { input_tokens: 19_500, output_tokens: 10, cache_creation_input_tokens: 0 };
const CONFIG = {
    execute_threshold_percentage: 20,
    compressor: { enabled: false },
};

describe.skipIf(!rustPrereqs.ok)("rust invariant: real-or-absent dropped tool calls", () => {
    let h: RustTestHarness;
    const violations: string[] = [];

    beforeAll(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 20_000,
            startInTsMode: true,
            startHistorianProducer: false,
            magicContextConfig: CONFIG,
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("serves seeded drops with real arguments or not at all and converts the legacy marker", async () => {
        const toolNamed = (body: Record<string, unknown>, suffix: string) =>
            (Array.isArray(body.tools) ? body.tools : [])
                .map((tool) => (tool as { name?: unknown }).name)
                .find(
                    (name): name is string =>
                        typeof name === "string" && new RegExp(`(^|_)${suffix}$`).test(name),
                );
        const smallInput = { command: "echo small", description: "small" };
        const legacyInput = { command: "echo legacy", description: "legacy" };
        const midInput = { command: `echo ${"M".repeat(3000)} > /dev/null`, description: "mid" };
        const endInput = { command: `echo ${"E".repeat(3000)} > /dev/null`, description: "end" };

        h.mock.reset();
        h.mock.addMatcher((body): MockResponse | null => {
            const violation = anthropicViolation(body);
            if (!violation) return null;
            violations.push(violation);
            return { error: { status: 400, type: "invalid_request_error", message: violation } };
        });

        const turnOne: Array<[string, Record<string, unknown>]> = [
            ["toolu_small_bash", smallInput],
            ["toolu_legacy_bash", legacyInput],
            ["toolu_mid_bash", midInput],
        ];
        let turnOneStep = 0;
        h.mock.addMatcher((body): MockResponse | null => {
            if (turnOneStep >= turnOne.length) return null;
            const bash = toolNamed(body, "bash");
            if (!bash) return null;
            const [id, input] = turnOne[turnOneStep]!;
            turnOneStep += 1;
            return {
                content: [{ type: "tool_use", id, name: bash, input }],
                stop_reason: "tool_use",
                usage: LOW,
            };
        });
        h.mock.setDefault({ text: "turn one done", usage: LOW });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "run the three commands");
        await Bun.sleep(500);

        const tagOf = (callId: string) =>
            h
                .contextDb()
                .prepare(
                    "SELECT tag_number AS tag, status, drop_mode AS mode FROM tags WHERE session_id = ? AND type = 'tool' AND message_id = ?",
                )
                .get(sessionId, callId) as { tag: number; status: string; mode: string } | null;
        const writable = () => openTestDb(join(h.env.dataDir, "cortexkit", "magic-context", "context.db"));
        const queue = (tag: number) => {
            const db = writable();
            try {
                db.prepare(
                    "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, 'drop', ?)",
                ).run(sessionId, tag, Date.now());
            } finally {
                db.close();
            }
        };
        const small = tagOf("toolu_small_bash");
        const legacy = tagOf("toolu_legacy_bash");
        const mid = tagOf("toolu_mid_bash");
        expect(small && legacy && mid).toBeTruthy();
        queue(small!.tag);
        queue(mid!.tag);
        // A legacy marker skeleton, exactly as sessions from before the rule persist it.
        {
            const db = writable();
            try {
                db.prepare(
                    "UPDATE tags SET status = 'dropped', drop_mode = 'truncated' WHERE session_id = ? AND tag_number = ?",
                ).run(sessionId, legacy!.tag);
            } finally {
                db.close();
            }
        }

        // Turn 2: the large call whose result ends the next request, with text beside
        // it so removing it would leave the request ending on assistant text.
        let predictedEndTag = 0;
        let turnTwoStep = 0;
        h.mock.addMatcher((body): MockResponse | null => {
            if (turnOneStep < turnOne.length || turnTwoStep >= 1) return null;
            const bash = toolNamed(body, "bash");
            if (!bash) return null;
            turnTwoStep += 1;
            const max = h
                .contextDb()
                .prepare("SELECT MAX(tag_number) AS max FROM tags WHERE session_id = ?")
                .get(sessionId) as { max: number };
            // The assistant text part is tagged before the call beside it.
            predictedEndTag = max.max + 2;
            queue(predictedEndTag);
            return {
                content: [
                    { type: "text", text: "Running the final command." },
                    { type: "tool_use", id: "toolu_end_bash", name: bash, input: endInput },
                ],
                stop_reason: "tool_use",
                usage: HIGH,
            };
        });
        h.mock.setDefault({ text: "turn two done", usage: LOW });
        await h.sendPrompt(sessionId, "run the final long command");
        await Bun.sleep(500);

        expect(tagOf("toolu_end_bash")?.tag).toBe(predictedEndTag);
        expect(tagOf("toolu_small_bash")).toMatchObject({ status: "dropped", mode: "skeleton_real" });
        expect(tagOf("toolu_mid_bash")).toMatchObject({ status: "dropped", mode: "full" });
        expect(tagOf("toolu_end_bash")).toMatchObject({ status: "dropped", mode: "skeleton_real" });
        expect(tagOf("toolu_legacy_bash")).toMatchObject({ status: "dropped", mode: "truncated" });

        // Flip to Rust mode against the same stores.
        await h.restart({ rust: true, magicContextConfig: CONFIG });
        h.mock.setDefault({ text: "after flip", usage: LOW });
        await h.sendPrompt(sessionId, "after the flip");
        await h.waitForRustPasses(1);
        const firstRust = h.mock.lastRequest()!;
        await h.sendPrompt(sessionId, "and once more");
        await Bun.sleep(500);
        const replay = h.mock.lastRequest()!;

        for (const request of [firstRust, replay]) {
            const messages = (request.body.messages ?? []) as WireMessage[];
            expect(findToolUse(messages, "toolu_small_bash")?.input).toEqual(smallInput);
            expect(resultText(findToolResult(messages, "toolu_small_bash"))).toStartWith("[dropped");
            expect(findToolUse(messages, "toolu_legacy_bash")?.input).toEqual(legacyInput);
            expect(resultText(findToolResult(messages, "toolu_legacy_bash"))).toStartWith("[dropped");
            expect(findToolUse(messages, "toolu_mid_bash")).toBeUndefined();
            expect(findToolResult(messages, "toolu_mid_bash")).toBeUndefined();
            expect(findToolUse(messages, "toolu_end_bash")?.input).toEqual(endInput);
            expect(resultText(findToolResult(messages, "toolu_end_bash"))).toStartWith("[dropped");
            expect(JSON.stringify(messages)).not.toContain('"dropped":');
        }
        expect(violations).toEqual([]);

        const evidenceDir = process.env.MC_REAL_OR_ABSENT_EVIDENCE;
        if (evidenceDir) {
            mkdirSync(evidenceDir, { recursive: true });
            const messages = (replay.body.messages ?? []) as WireMessage[];
            const around = (id: string) =>
                messages.filter((message) =>
                    blocks(message).some((block) => block.id === id || block.tool_use_id === id),
                );
            writeFileSync(
                join(evidenceDir, "rust-served.json"),
                JSON.stringify(
                    {
                        small_skeleton: around("toolu_small_bash"),
                        converted_legacy: around("toolu_legacy_bash"),
                        request_ending_exception: around("toolu_end_bash"),
                        full_removal_mid_call_present: around("toolu_mid_bash").length > 0,
                        request_count: h.mock.requests().length,
                        violations,
                    },
                    null,
                    2,
                ),
            );
            // Every process holding a file under this run's data dir (the OpenCode
            // host and the Rust module), with the database files it has open.
            // lsof exits non-zero when it cannot stat some entry; its stdout still
            // lists every process it found.
            const pids = spawnSync("lsof", ["-t", "+D", realpathSync(h.env.dataDir)], {
                encoding: "utf8",
            })
                .stdout.split("\n")
                .filter(Boolean);
            const lines = [...new Set(pids)].flatMap((pid) =>
                execFileSync("lsof", ["-p", pid], { encoding: "utf8" })
                    .split("\n")
                    .filter((line) => /\.db(-wal|-shm)?$/.test(line)),
            );
            writeFileSync(join(evidenceDir, "rust-lsof-db.txt"), lines.join("\n"));
        }
    }, 900_000);
});

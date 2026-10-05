/**
 * Adversarial gate drive (real OpenCode 1 host): byte identity of real-or-absent
 * drops across a priced bust pass A and the later defer passes, over a mixed
 * newest-20 window: small, exactly 1024 and 1025 string bytes (ASCII and
 * multi-byte UTF-8), large, the request-ending exception, and a small skeleton
 * that slides out of the window after A. Every request goes through an
 * Anthropic-style pairing and no-prefill validator; a violation is answered
 * with a 400 and counted.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    anthropicViolation,
    blocks,
    findToolResult,
    findToolUse,
    resultText,
    type WireMessage,
} from "../src/anthropic-request-validator";
import { analyzePasses } from "../src/cache-analysis";
import { TestHarness } from "../src/harness";
import type { MockResponse } from "../src/mock-provider/server";
import { openTestDb } from "../src/test-db";

const LOW = { input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 0 };
const HIGH = { input_tokens: 19_500, output_tokens: 10, cache_creation_input_tokens: 0 };

// String-leaf byte totals (command + description).
const pad = (n: number, ch = "a") => ch.repeat(n);
const INPUTS: Record<string, { command: string; description: string }> = {
    small: { command: "echo small", description: "small" },
    // "echo " (5) + 1018 = 1023, + "x" = 1024
    a1024: { command: `echo ${pad(1018)}`, description: "x" },
    a1025: { command: `echo ${pad(1018)}`, description: "xy" },
    // "echo " (5) + 509 x "é" (1018 bytes) = 1023, + "d" = 1024 bytes / 515 chars
    mb1024: { command: `echo ${pad(509, "\u00e9")}`, description: "d" },
    mb1025: { command: `echo ${pad(509, "\u00e9")}`, description: "dd" },
    large: { command: `echo ${pad(3000, "L")} > /dev/null`, description: "large" },
};
const ORDER = ["small", "a1024", "a1025", "mb1024", "mb1025", "large"] as const;
const FILLERS = 13; // 6 + 13 + the request-ending call = 20 calls at pass A
const END_INPUT = { command: `echo ${pad(3000, "E")} > /dev/null`, description: "end" };

const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([key]) => key !== "cache_control")
                .map(([key, inner]) => [key, strip(inner)]),
        );
    }
    return value;
};
const shaOf = (messages: unknown[]) =>
    createHash("sha256").update(JSON.stringify(strip(messages))).digest("hex");

describe("ADV real-or-absent byte identity on OpenCode 1", () => {
    let h: TestHarness;
    const violations: string[] = [];

    beforeAll(async () => {
        h = await TestHarness.create({
            modelContextLimit: 20_000,
            magicContextConfig: {
                execute_threshold_percentage: 20,
                historian: { disable: true },
            },
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("A (bust) and every later defer pass agree over A's messages", async () => {
        const toolNamed = (body: Record<string, unknown>, suffix: string) =>
            (Array.isArray(body.tools) ? body.tools : [])
                .map((tool) => (tool as { name?: unknown }).name)
                .filter((name): name is string => typeof name === "string")
                .find((name) => new RegExp(`(^|_)${suffix}$`).test(name));

        h.mock.reset();
        h.mock.addMatcher((body): MockResponse | null => {
            const violation = anthropicViolation(body);
            if (!violation) return null;
            violations.push(violation);
            return { error: { status: 400, type: "invalid_request_error", message: violation } };
        });

        const script: Array<{ id: string; input: unknown }> = [
            ...ORDER.map((name) => ({ id: `toolu_${name}`, input: INPUTS[name] })),
            ...Array.from({ length: FILLERS }, (_, i) => ({
                id: `toolu_fill_${i}`,
                input: { command: `echo f${i}`, description: `f${i}` },
            })),
        ];
        let phase: "one" | "two" | "three" | "done" = "one";
        let step = 0;
        let predictedEndTag = 0;
        const sessionRef = { id: "" };
        const queue = (tag: number) => {
            const writable = openTestDb(h.contextDbPath());
            try {
                writable
                    .prepare(
                        "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, ?)",
                    )
                    .run(sessionRef.id, tag, Date.now(), h.harnessId);
            } finally {
                writable.close();
            }
        };
        h.mock.addMatcher((body): MockResponse | null => {
            const bash = toolNamed(body, "bash");
            if (!bash) return null;
            if (phase === "one" && step < script.length) {
                const call = script[step++]!;
                return {
                    content: [{ type: "tool_use", id: call.id, name: bash, input: call.input }],
                    stop_reason: "tool_use",
                    usage: LOW,
                };
            }
            if (phase === "two" && step === 0) {
                step = 1;
                const maxTag = h
                    .contextDb()
                    .prepare(
                        "SELECT MAX(tag_number) AS max FROM tags WHERE session_id = ? AND harness = ?",
                    )
                    .get(sessionRef.id, h.harnessId) as { max: number };
                predictedEndTag = maxTag.max + 2;
                queue(predictedEndTag);
                return {
                    content: [
                        { type: "text", text: "Running the final command." },
                        { type: "tool_use", id: "toolu_end", name: bash, input: END_INPUT },
                    ],
                    stop_reason: "tool_use",
                    usage: HIGH,
                };
            }
            if (phase === "three" && step < 3) {
                step += 1;
                return {
                    content: [
                        {
                            type: "tool_use",
                            id: `toolu_after_${step}`,
                            name: bash,
                            input: { command: `echo after${step}`, description: `after${step}` },
                        },
                    ],
                    stop_reason: "tool_use",
                    usage: LOW,
                };
            }
            return null;
        });
        h.mock.setDefault({ text: "done", usage: LOW });

        const sessionId = await h.createSession();
        sessionRef.id = sessionId;
        await h.sendPrompt(sessionId, "run the scripted commands", { timeoutMs: 240_000 });
        await h.waitForMockQuiescence({ label: "turn one settles" });

        const tagOf = (callId: string) =>
            h
                .contextDb()
                .prepare(
                    "SELECT tag_number AS tag, status, drop_mode AS mode FROM tags WHERE session_id = ? AND harness = ? AND type = 'tool' AND message_id = ?",
                )
                .get(sessionId, h.harnessId, callId) as {
                tag: number;
                status: string;
                mode: string;
            } | null;
        for (const name of ORDER) queue(tagOf(`toolu_${name}`)!.tag);

        phase = "two";
        step = 0;
        await h.sendPrompt(sessionId, "run the final long command", { timeoutMs: 120_000 });
        await h.waitForMockQuiescence({ label: "turn two settles" });

        const requests = h.requests();
        const aIndex = requests.findIndex((request) => {
            const messages = (request.body.messages ?? []) as WireMessage[];
            return blocks(messages.at(-1)).some(
                (block) => block.type === "tool_result" && block.tool_use_id === "toolu_end",
            );
        });
        expect(aIndex).toBeGreaterThanOrEqual(0);

        phase = "three";
        step = 0;
        await h.sendPrompt(sessionId, "three more quick commands please", { timeoutMs: 120_000 });
        await h.waitForMockQuiescence({ label: "turn three settles" });
        await h.sendPrompt(sessionId, "anything else?", { timeoutMs: 120_000 });
        await h.waitForMockQuiescence({ label: "turn four settles" });

        const all = h.requests();
        const passA = all[aIndex]!;
        const aMessages = (passA.body.messages ?? []) as WireMessage[];
        const later = all.slice(aIndex + 1);
        const modes = Object.fromEntries(
            [...ORDER.map((n) => `toolu_${n}`), "toolu_end"].map((id) => [id, tagOf(id)]),
        );
        const perPass = later.map((request, index) => {
            const messages = (request.body.messages ?? []) as WireMessage[];
            const verdict = analyzePasses([passA, request])[1]!;
            return {
                index: aIndex + 1 + index,
                messageCount: messages.length,
                sharedSha: shaOf(messages.slice(0, aMessages.length)),
                verdict: verdict.verdict,
                divergeSegment: verdict.divergeSegmentId,
            };
        });
        const aSha = shaOf(aMessages);
        const served = (messages: WireMessage[]) =>
            Object.fromEntries(
                [...ORDER.map((n) => `toolu_${n}`), "toolu_end"].map((id) => {
                    const use = findToolUse(messages, id);
                    return [
                        id,
                        use
                            ? {
                                  inputIsReal:
                                      JSON.stringify(use.input) ===
                                      JSON.stringify(
                                          id === "toolu_end"
                                              ? END_INPUT
                                              : INPUTS[id.replace("toolu_", "")],
                                      ),
                                  result: resultText(findToolResult(messages, id)).slice(0, 40),
                              }
                            : "absent",
                    ];
                }),
            );
        const lastMessages = (all.at(-1)!.body.messages ?? []) as WireMessage[];
        const summary = {
            requestCount: all.length,
            aIndex,
            aMessageCount: aMessages.length,
            aSha,
            modes,
            servedAtA: served(aMessages),
            servedAtLast: served(lastMessages),
            perPass,
            violations,
            oldMarkerAnywhere: all.some((r) => JSON.stringify(r.body.messages).includes('"dropped":')),
        };
        console.log("ADV_OC1_BYTES", JSON.stringify(summary, null, 1));

        const evidenceDir = process.env.ADV_EVIDENCE;
        if (evidenceDir) {
            mkdirSync(evidenceDir, { recursive: true });
            writeFileSync(join(evidenceDir, "adv-oc1-bytes.json"), JSON.stringify(summary, null, 2));
            writeFileSync(
                join(evidenceDir, "adv-oc1-served-last.json"),
                JSON.stringify(lastMessages, null, 2),
            );
            const lsof = execFileSync("lsof", ["-p", String(h.opencode.pid)], { encoding: "utf8" });
            writeFileSync(
                join(evidenceDir, "adv-oc1-lsof-db.txt"),
                lsof
                    .split("\n")
                    .filter((line) => /\.db(-wal|-shm)?$/.test(line))
                    .join("\n"),
            );
        }

        expect(violations).toEqual([]);
        expect(later.length).toBeGreaterThan(0);
        for (const pass of perPass) {
            expect({ index: pass.index, sha: pass.sharedSha }).toEqual({
                index: pass.index,
                sha: aSha,
            });
        }
    }, 900_000);
});

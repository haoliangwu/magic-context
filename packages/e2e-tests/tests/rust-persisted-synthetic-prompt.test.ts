/// <reference types="bun-types" />

/**
 * Incident regression: a plugin-injected user prompt disappeared from the wire on
 * every pass after the one that first served it.
 *
 * OpenCode marks the parts of an injected prompt `synthetic`. That flag means "the
 * model sees this text, the terminal interface does not draw it as a human turn" —
 * the message is written to the session database with its own id, it is serialized
 * to the model on every later pass, and it owns the assistant replies that follow
 * it. It never means the row is temporary. Background-task notices, plugin nudges,
 * and Magic Context's own Channel 2 nudge all arrive this way.
 *
 * The Rust transform used to remove every such row that was not the newest message.
 * Because the removed row was a user message, the two assistant messages on either
 * side of it became adjacent and the AI SDK merged them, so roughly a thousand
 * tokens of the settled tail were rewritten on the very next pass and the provider's
 * prompt cache was evicted once per injected prompt.
 *
 * Assertion style: the injected row's presence, position, and byte-identical
 * rendering across consecutive captured provider bodies, plus a sha256 over the
 * whole prefix up to and including that row.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { RustTestHarness, stableSerialize } from "../src/rust-harness";
import { driveToSteadyState, rustPrereqs } from "../src/rust-scenario-support";

/** Marker carried by the injected prompt so it can be located in a captured body. */
const NOTICE_MARKER = "injectedpromptprobe";
const NOTICE_TEXT = `<system-reminder>\n[BACKGROUND BASH COMPLETED] ${NOTICE_MARKER} finished\n</system-reminder>`;
const SIGNATURE = "sig-injected-prompt";

interface WireMessage {
    role?: string;
    content?: unknown;
}

function blocks(message: WireMessage | undefined): Array<Record<string, unknown>> {
    return Array.isArray(message?.content)
        ? (message.content as Array<Record<string, unknown>>)
        : [];
}

function endsWithToolResult(messages: WireMessage[]): boolean {
    return blocks(messages.at(-1)).some((block) => block.type === "tool_result");
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

/** Index of the user message carrying the injected prompt, or -1. */
function noticeIndex(messages: WireMessage[]): number {
    return messages.findIndex(
        (message) => message.role === "user" && stableSerialize(message).includes(NOTICE_MARKER),
    );
}

/** Every index where two consecutive served messages share the assistant role. */
function adjacentAssistantIndexes(messages: WireMessage[]): number[] {
    const found: number[] = [];
    for (let index = 1; index < messages.length; index += 1) {
        if (messages[index]?.role === "assistant" && messages[index - 1]?.role === "assistant") {
            found.push(index);
        }
    }
    return found;
}

describe.skipIf(!rustPrereqs.ok)(
    "rust invariant: a persisted synthetic user prompt stays on the wire",
    () => {
        let h: RustTestHarness;

        beforeAll(async () => {
            h = await RustTestHarness.create({
                modelContextLimit: 200_000,
                // Keep the historian producer out of the stack: a publication would
                // replace the module's served history mid-scenario, and every assertion
                // here compares one served array against the next.
                startHistorianProducer: false,
                magicContextConfig: { execute_threshold_percentage: 60, protected_tags: 1 },
            });
        });

        afterAll(async () => {
            await h?.dispose();
        });

        it(
            "serves an injected prompt in every later pass without rewriting the tail",
            async () => {
                const sessionId = await h.createSession();
                await driveToSteadyState(h, sessionId, 2);

                // Answer the injected prompt with a tool step, which is what turns the
                // defect into a visible tail rewrite: the continuation pass no longer has
                // the injected row as its newest message, and the assistant that answered
                // it ends up next to the assistant before it.
                h.mock.addMatcher((body) => {
                    const messages = Array.isArray(body.messages)
                        ? (body.messages as WireMessage[])
                        : [];
                    if (messages.length === 0) return null;
                    if (endsWithToolResult(messages)) {
                        return {
                            content: [
                                { type: "text", text: `${NOTICE_MARKER} acknowledged` },
                            ],
                            stop_reason: "end_turn",
                            usage: {
                                input_tokens: 9_000,
                                output_tokens: 20,
                                cache_creation_input_tokens: 1_000,
                            },
                        };
                    }
                    if (!stableSerialize(messages.at(-1) ?? {}).includes(NOTICE_MARKER)) return null;
                    const tools = Array.isArray(body.tools) ? body.tools : [];
                    const search = tools.find(
                        (tool) => (tool as { name?: unknown } | null)?.name === "ctx_search",
                    ) as { name: string } | undefined;
                    if (!search) return null;
                    return {
                        content: [
                            {
                                type: "thinking",
                                thinking: `checking the completed task at depth ${messages.length}`,
                                signature: `${SIGNATURE}-${messages.length}`,
                            },
                            {
                                type: "tool_use",
                                id: `toolu_injected_prompt_${messages.length}`,
                                name: search.name,
                                input: { query: `what happened in ${NOTICE_MARKER}?`, limit: 3 },
                            },
                        ],
                        stop_reason: "tool_use",
                        usage: {
                            input_tokens: 9_000,
                            output_tokens: 20,
                            cache_creation_input_tokens: 1_000,
                        },
                    };
                });

                const before = h.mainRequests().length;
                // Exactly how a plugin delivers a notice or a Channel 2 nudge: one text
                // part flagged synthetic, persisted by OpenCode as an ordinary user row.
                await h.sendPrompt(sessionId, NOTICE_TEXT, { synthetic: true });
                // One more ordinary turn, so the injected row is several passes deep.
                h.mock.setDefault({
                    text: "settled reply",
                    usage: {
                        input_tokens: 9_000,
                        output_tokens: 20,
                        cache_creation_input_tokens: 1_000,
                    },
                });
                await h.sendPrompt(sessionId, `after the notice: ${h.ballast(120)}`);

                const served = h
                    .mainRequests()
                    .slice(before)
                    .map((request) => (request.body.messages ?? []) as WireMessage[]);
                // The injected prompt's own pass, its tool continuation, and the later turn.
                expect(served.length).toBeGreaterThanOrEqual(3);

                const firstIndex = noticeIndex(served[0]!);
                expect(firstIndex).toBeGreaterThanOrEqual(0);
                // The fixture must really have answered with a tool step. Without it the
                // injected prompt is not followed by a second assistant message, so the
                // adjacent-assistant merge this scenario guards against could not happen
                // and the assertions below would hold for the wrong reason.
                const finalWire = stableSerialize(served.at(-1) ?? []);
                expect(finalWire).toContain(SIGNATURE);
                expect(finalWire).toContain("tool_result");

                // Position, rendering, and prefix hash of the injected row, pass by pass.
                const observed = served.map((messages) => {
                    const index = noticeIndex(messages);
                    return {
                        index,
                        row: index < 0 ? "" : stableSerialize(messages[index]!),
                        prefix:
                            index < 0
                                ? ""
                                : sha256(
                                      messages
                                          .slice(0, index + 1)
                                          .map((message) => stableSerialize(message))
                                          .join("\u0000"),
                                  ),
                        adjacentAssistants: adjacentAssistantIndexes(messages),
                    };
                });
                const expected = observed.map(() => ({
                    index: firstIndex,
                    row: observed[0]!.row,
                    prefix: observed[0]!.prefix,
                    adjacentAssistants: [] as number[],
                }));
                expect(observed).toEqual(expected);
            },
            600_000,
        );
    },
);

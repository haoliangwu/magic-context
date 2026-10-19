import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { updateSessionMeta } from "../src/features/magic-context/storage-meta";
import { __test as decisions } from "../src/features/magic-context/transform-decision-log";
import {
    validateAnthropicReasoningRuns,
    validateLkgSeam,
} from "../src/hooks/magic-context/lkg-replay";
import { dropSlot } from "../src/hooks/magic-context/lkg-slot";
import {
    noteRustServedRaw,
    preserveRustServedRaw,
    servedRawBlockIds,
} from "../src/hooks/magic-context/rust-served-raw";
import type { MessageLike } from "../src/hooks/magic-context/transform-operations";
import { tryMessagesTransformLkgReplay } from "../src/plugin/messages-transform";
import {
    blocks,
    database,
    hostFixture,
    providerBody,
    thinking,
    tool,
    user,
} from "./rust-cache-harness";

const currentBinary = process.env.MC_RAW_REPLAY_PROBE;
const baseBinary = process.env.MC_RAW_REPLAY_BASELINE;
const baseAdapter = process.env.MC_RAW_REPLAY_BASELINE_ADAPTER;
const baseRoot = process.env.MC_REVIEW_BASELINE_ROOT;
const missingPrerequisites = [
    !currentBinary && "MC_RAW_REPLAY_PROBE (staged native driver)",
    !baseBinary && "MC_RAW_REPLAY_BASELINE (pinned master driver)",
    !baseAdapter && "MC_RAW_REPLAY_BASELINE_ADAPTER (pinned master adapter)",
    !baseRoot && "MC_REVIEW_BASELINE_ROOT (pinned master sources)",
].filter((reason): reason is string => Boolean(reason));
if (missingPrerequisites.length > 0) {
    const reason = `Rust raw replay review prerequisites missing: ${missingPrerequisites.join(", ")}`;
    if (process.env.MC_RAW_REPLAY_REQUIRED === "1") {
        throw new Error(`Required ${reason}`);
    }
    console.info(`SKIP ${reason}`);
}
if (process.env.MC_RAW_REPLAY_REQUIRED === "1" && process.env.MC_REVIEW_ASSERT_LIVENESS !== "1") {
    throw new Error("Required MC_REVIEW_ASSERT_LIVENESS=1 for the raw replay review lane");
}
const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZcAAAAASUVORK5CYII=";

console.info(
    "SKIP real-daemon review: sibling subconscious checkout is outside this offline review lane",
);

describe.skipIf(!currentBinary || !baseBinary || !baseAdapter)(
    "independent no-LKG provider differential",
    () => {
        for (const seed of [0xa19f37, 0xbadc0de, 0xc001d00d, 0x92e41b, 0x67d5a3]) {
            test(`seed ${seed.toString(16)}: 128 mixed-media streaming passes equal master serialized bodies`, async () => {
                const baselineFactory = (await import(baseAdapter!)).createRustModeTransform;
                // The offline driver does not run the daemon's ingress lifecycle; exercise
                // the module's explicit mid-turn mode identically in both arms for streaming.
                const current = await hostFixture(
                    `review-current-${seed}`,
                    currentBinary!,
                    undefined,
                    undefined,
                    true,
                );
                const baseline = await hostFixture(
                    `review-base-${seed}`,
                    baseBinary!,
                    baselineFactory,
                    baseRoot,
                    true,
                );
                let state = seed >>> 0;
                const random = () => (state = (Math.imul(state, 1103515245) + 12345) >>> 0);
                const input: MessageLike[] = [user("review", "warmup")];
                for (const fixture of [current, baseline]) {
                    updateSessionMeta(fixture.db, fixture.sid, {
                        systemPromptHash: "system-stable",
                    });
                    await fixture.run(input);
                }
                const hash = createHash("sha256");
                let pending: Record<string, unknown> | undefined;
                let attachments = 0;
                let reasoning = 0;
                for (let pass = 0; pass < 128; pass++) {
                    const completing = Boolean(pending);
                    if (pending) {
                        pending.status = "completed";
                        pending.output = `finished streamed tool at ${pass}`;
                        pending.time = { start: pass - 1, end: pass };
                        pending = undefined;
                    }
                    if (!completing) {
                        const question = user("review", `u${pass}`);
                        if (pass % 9 === 0)
                            question.parts.push({
                                id: `image-${pass}`,
                                type: "file",
                                mime: "image/png",
                                filename: "pixel.png",
                                url: png,
                            });
                        if (pass % 11 === 0)
                            question.parts.push({
                                id: `pdf-${pass}`,
                                type: "file",
                                mime: "application/pdf",
                                filename: "tiny.pdf",
                                url: "data:application/pdf;base64,JVBERi0xLjQKJSVFT0Y=",
                            });
                        if (pass % 5 === 0)
                            question.parts.push({
                                type: "text",
                                synthetic: true,
                                text: `synthetic reminder ${pass}`,
                            });
                        input.push(question);
                        const result = tool(
                            "review",
                            `t${pass}`,
                            (random() >>> 16) % 2 ? "ctx_reduce" : "read",
                        );
                        (question.parts[0] as { text: string }).text +=
                            ` sample ${random().toString(16)}`;
                        if (pass % 7 === 0) {
                            result.parts.unshift(thinking(`reason-${pass}`));
                            reasoning++;
                        }
                        const native = result.parts.at(-1) as { state: Record<string, unknown> };
                        if (pass % 8 === 0) {
                            native.state.attachments = [
                                {
                                    id: `attachment-${pass}`,
                                    mime: "image/png",
                                    filename: "result.png",
                                    url: png,
                                },
                            ];
                            attachments++;
                        }
                        if (pass % 6 === 0) {
                            delete native.state.output;
                            delete native.state.attachments;
                            native.state.status = "running";
                            pending = native.state;
                        }
                        input.push(result);
                    }
                    const wires: string[] = [];
                    for (const fixture of [current, baseline]) {
                        updateSessionMeta(fixture.db, fixture.sid, {
                            systemPromptHash: "system-stable",
                        });
                        const served = await fixture.run(input);
                        expect(fixture.host.getState(fixture.sid).lkgRepresentationFrozen).toBe(
                            false,
                        );
                        wires.push(await providerBody(served));
                    }
                    expect(wires[0], `seed=${seed} pass=${pass}`).toBe(wires[1]);
                    hash.update(wires[0]!);
                }
                console.info(
                    JSON.stringify({
                        seed,
                        passes: 128,
                        attachments,
                        reasoning,
                        serializedBodies: 256,
                        sha256: hash.digest("hex"),
                    }),
                );
            }, 600_000);
        }
    },
);

describe.skipIf(!currentBinary)("independent incident and release histories", () => {
    test("raw ctx_reduce survives 15 minting passes and a naturally errored-tool seam then exposes tags once", async () => {
        const sid = "review-independent-incident";
        const fixture = await hostFixture(sid, currentBinary!);
        const input = [user(sid, "initial")];
        await fixture.run(input);
        const reduce = tool(sid, "reduce", "ctx_reduce");
        reduce.parts.unshift(thinking("reduce-think"));
        input.push(reduce);
        const replay = { messages: structuredClone(input) } as Parameters<
            typeof tryMessagesTransformLkgReplay
        >[0]["output"];
        expect(
            tryMessagesTransformLkgReplay({
                output: replay,
                sessionId: sid,
                error: new Error("synthetic outage"),
                rust: fixture.host.replayParticipant,
            }),
        ).toBe(true);
        const before = blocks(await providerBody(replay.messages));
        for (let pass = 0; pass < 15; pass++) {
            input.push(user(sid, `u${pass}`), tool(sid, `r${pass}`));
            if (pass === 14) {
                const part = input.at(-1)!.parts[0] as { state: Record<string, unknown> };
                part.state.status = "error";
                part.state.error = "read failed: file no longer exists";
                delete part.state.output;
            }
            const served = await fixture.run(input);
            expect(fixture.response.prefix_bust_permitted).toBe(false);
            expect(blocks(await providerBody(served)).slice(0, before.length)).toEqual(before);
        }
        expect(fixture.response.test_tag_rows).toEqual(
            expect.arrayContaining([expect.objectContaining({ block_id: "reduce#2" })]),
        );
        const historical = blocks(await providerBody(await fixture.run(input)));
        input.push(user(sid, "after-error"));
        const release = await fixture.run(input);
        expect(decisions.getPending(sid)?.lkgFrozenReleaseReason).toStartWith("lkg_unsafe_seam;");
        expect(fixture.response.prefix_bust_permitted).toBe(false);
        expect(blocks(await providerBody(release)).slice(0, historical.length)).toEqual(historical);
        expect(validateLkgSeam([], release, "anthropic")).toBe(true);
        expect(validateAnthropicReasoningRuns(release)).toBe(true);
        updateSessionMeta(fixture.db, sid, { systemPromptHash: "authorized-rebuild" });
        const rebuilt = await providerBody(await fixture.run(input));
        expect(fixture.response.prefix_bust_permitted).toBe(true);
        expect(rebuilt.match(/§\d+§ 8 tags stamped\./g)).toHaveLength(1);
        expect(await providerBody(await fixture.run(input))).toBe(rebuilt);
    }, 120_000);

    for (const change of [
        "deleted-message",
        "reverted-tail",
        "deleted-part",
        "idless-synthetic",
        "idless-unchanged",
        "compaction-marker",
        "subagent-session",
    ] as const) {
        // These are known failing liveness claims, not permission to refuse repeatedly.
        // MC_REVIEW_ASSERT_LIVENESS=1 makes their desired contract ordinary red tests.
        const check =
            !["compaction-marker", "subagent-session"].includes(change) &&
            !process.env.MC_REVIEW_ASSERT_LIVENESS
                ? test.failing
                : test;
        check(
            `release recovery census: ${change}`,
            async () => {
                const sid = `review-liveness-${change}`;
                const fixture = await hostFixture(sid, currentBinary!);
                const input = [user(sid, "initial")];
                await fixture.run(input);
                if (change === "subagent-session")
                    updateSessionMeta(fixture.db, sid, { isSubagent: true });
                const raw = tool(sid, "raw");
                raw.parts.push({
                    ...(change.startsWith("idless") ? {} : { id: "reminder" }),
                    type: "text",
                    synthetic: true,
                    text: "temporary reminder",
                });
                input.push(raw);
                const replay = { messages: structuredClone(input) } as Parameters<
                    typeof tryMessagesTransformLkgReplay
                >[0]["output"];
                expect(
                    tryMessagesTransformLkgReplay({
                        output: replay,
                        sessionId: sid,
                        error: new Error("outage"),
                        rust: fixture.host.replayParticipant,
                    }),
                ).toBe(true);
                await fixture.run(input);
                if (change === "deleted-message" || change === "reverted-tail") input.pop();
                if (change === "deleted-message") dropSlot(sid, "message_removed");
                if (change === "deleted-part") raw.parts.pop();
                if (change === "idless-synthetic")
                    (raw.parts[1] as { text: string }).text = "refreshed reminder";
                if (change === "compaction-marker")
                    raw.parts.push({ type: "compaction", auto: true });
                if (change === "idless-unchanged") dropSlot(sid, "message_removed");
                input.push(user(sid, "continued"));
                const refusals: string[] = [];
                for (let attempt = 0; attempt < 3; attempt++) {
                    try {
                        await fixture.run(input);
                    } catch (error) {
                        refusals.push(String(error));
                    }
                }
                console.info(
                    JSON.stringify({
                        change,
                        refusals,
                        prefixPermission: fixture.response.prefix_bust_permitted,
                        rawIds: servedRawBlockIds(fixture.db, sid),
                    }),
                );
                expect(
                    refusals.length,
                    "A conflict may refuse at most one turn and must recover without intervention",
                ).toBeLessThanOrEqual(1);
            },
            120_000,
        );
    }
});

test("durable replay cost: 300 growing passes with 16KiB tool outputs", () => {
    const db = database();
    const sid = "review-cost";
    const input: MessageLike[] = [];
    const sizes: { pass: number; bytes: number }[] = [];
    let logicalChanges = 0;
    let serializedBytesRewritten = 0;
    const start = performance.now();
    for (let pass = 1; pass <= 300; pass++) {
        const result = tool(sid, `cost-${pass}`);
        (result.parts[0] as { state: { output: string } }).state.output = "x".repeat(16 * 1024);
        input.push(user(sid, `cost-user-${pass}`), result);
        const before = db.prepare("SELECT total_changes() AS n").get() as { n: number };
        noteRustServedRaw(db, sid, input, input);
        const after = db.prepare("SELECT total_changes() AS n").get() as { n: number };
        logicalChanges += after.n - before.n;
        const stored = db
            .prepare(
                "SELECT trailing_blank_decisions AS doc FROM session_meta WHERE session_id = ?",
            )
            .get(sid) as { doc: string };
        const bytes = Buffer.byteLength(stored.doc);
        serializedBytesRewritten += bytes;
        if ([1, 10, 100, 200, 300].includes(pass)) sizes.push({ pass, bytes });
    }
    const before = db.prepare("SELECT total_changes() AS n").get() as { n: number };
    noteRustServedRaw(db, sid, input, input);
    const after = db.prepare("SELECT total_changes() AS n").get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(servedRawBlockIds(db, sid)).toHaveLength(900);
    const noFreeze = [user("never-froze", "ordinary")];
    preserveRustServedRaw(db, "never-froze", noFreeze);
    expect((db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(after.n);
    console.info(
        JSON.stringify({
            cost: sizes,
            logicalChanges,
            serializedBytesRewritten,
            elapsedMs: Math.round(performance.now() - start),
            note: "raw evidence only, excluding existing LKG slot; in-memory SQLite",
        }),
    );
}, 120_000);

const rawKeyOrderTest = process.env.MC_REVIEW_ASSERT_LIVENESS ? test : test.failing;
rawKeyOrderTest(
    "unchanged ID-less native keys must not refuse a byte-identical provider request",
    async () => {
        const db = database();
        const input = [user("key-order", "question")];
        input[0]!.parts = [{ type: "text", text: "unchanged ID-less prompt", synthetic: true }];
        noteRustServedRaw(db, "key-order", input, input);
        const candidate = structuredClone(input);
        candidate[0]!.parts = [{ synthetic: true, text: "unchanged ID-less prompt", type: "text" }];
        expect(await providerBody(candidate)).toBe(await providerBody(input));
        expect(() => preserveRustServedRaw(db, "key-order", candidate)).not.toThrow();
    },
);

test.skipIf(!currentBinary || !baseBinary || !baseAdapter)(
    "no-freeze SQL read overhead versus master over five healthy passes",
    async () => {
        const baselineFactory = (await import(baseAdapter!)).createRustModeTransform;
        const current = await hostFixture("review-io-current", currentBinary!);
        const baseline = await hostFixture(
            "review-io-base",
            baseBinary!,
            baselineFactory,
            baseRoot,
        );
        const counts: { arm: string; envelopeSelects: number; changes: number }[] = [];
        for (const [arm, fixture] of [
            ["current", current],
            ["master", baseline],
        ] as const) {
            const input = [user(fixture.sid, "warmup")];
            await fixture.run(input);
            let reads = 0;
            const original = fixture.db.prepare.bind(fixture.db);
            const spy = spyOn(fixture.db, "prepare").mockImplementation(((sql: string) => {
                if (
                    sql === "SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?"
                )
                    reads++;
                return original(sql);
            }) as typeof fixture.db.prepare);
            const before = (
                fixture.db.prepare("SELECT total_changes() AS n").get() as { n: number }
            ).n;
            for (let pass = 0; pass < 5; pass++) {
                input.push(
                    user(fixture.sid, `question-${pass}`),
                    tool(fixture.sid, `result-${pass}`),
                );
                await fixture.run(input);
                expect(fixture.host.getState(fixture.sid).lkgRepresentationFrozen).toBe(false);
            }
            const after = (fixture.db.prepare("SELECT total_changes() AS n").get() as { n: number })
                .n;
            spy.mockRestore();
            counts.push({ arm, envelopeSelects: reads, changes: after - before });
        }
        console.info(
            JSON.stringify({
                noFreezeSql: counts,
                note: "exact envelope SELECT call sites, not physical disk reads; SQLite is in memory",
            }),
        );
        expect(counts[0]!.envelopeSelects).toBeLessThanOrEqual(counts[1]!.envelopeSelects);
        expect(counts[0]!.changes).toBe(counts[1]!.changes);
    },
    120_000,
);

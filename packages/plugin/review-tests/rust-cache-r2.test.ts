import { describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyCacheBust } from "../scripts/cache-bust-attribution";
import { withSchedulerLogFallback } from "../scripts/cache-bust-scheduler-log";
import { __test as decisions } from "../src/features/magic-context/transform-decision-log";
import { dropSlot } from "../src/hooks/magic-context/lkg-slot";
import {
    checkRustServedRawIngress,
    noteRustServedRaw,
    preserveRustServedRaw,
    rustRawRebuild,
} from "../src/hooks/magic-context/rust-served-raw";
import type { MessageLike } from "../src/hooks/magic-context/transform-operations";
import { tryMessagesTransformLkgReplay } from "../src/plugin/messages-transform";
import * as logger from "../src/shared/logger";
import {
    blocks,
    database,
    hostFixture,
    probe,
    providerBody,
    scratch,
    tool,
    user,
} from "./rust-cache-harness";

const binary = process.env.MC_RAW_REPLAY_PROBE;
if (!binary) {
    const reason = "Rust round-two raw replay tests require staged MC_RAW_REPLAY_PROBE";
    if (process.env.MC_RAW_REPLAY_REQUIRED === "1") throw new Error(`Required ${reason}`);
    console.info(`SKIP ${reason}`);
}
describe.skipIf(!binary)("round-two bounded attributed recovery", () => {
    for (const change of ["deletion", "revert", "synthetic-change", "candidate-loss"] as const) {
        test(`${change}: twelve attempts pay one refusal and one attributed rebuild`, async () => {
            const sid = `r2-${change}`;
            const fixture = await hostFixture(sid, binary!);
            const lines: string[] = [];
            const logs = spyOn(logger, "sessionLog").mockImplementation((...args) => {
                lines.push(`[${new Date().toISOString()}] [magic-context][${sid}] ${args.at(-1)}`);
            });
            try {
                const input = [user(sid, "initial")];
                await fixture.run(input);
                const raw = tool(sid, "raw");
                raw.parts.push({ type: "text", synthetic: true, text: "removed reminder r2" });
                input.push(raw);
                const replay = { messages: structuredClone(input) } as Parameters<
                    typeof tryMessagesTransformLkgReplay
                >[0]["output"];
                expect(
                    tryMessagesTransformLkgReplay({
                        output: replay,
                        sessionId: sid,
                        error: new Error("offline outage"),
                        rust: fixture.host.replayParticipant,
                    }),
                ).toBe(true);
                await fixture.run(input);
                if (change === "deletion" || change === "revert") input.pop();
                if (change !== "revert") dropSlot(sid, "message_removed");
                if (change === "synthetic-change")
                    (raw.parts[1] as { text: string }).text = "current reminder r2";
                if (change === "candidate-loss")
                    fixture.mutate = (response) => {
                        response.native_messages = (
                            response.native_messages as MessageLike[]
                        ).filter((message) => message.info.id !== "raw");
                    };
                input.push(user(sid, "continued"));
                let refusals = 0;
                let rebuilds = 0;
                let stable: string | undefined;
                const reason =
                    change === "candidate-loss"
                        ? "candidate_loss"
                        : change === "synthetic-change"
                          ? "source_changed"
                          : "source_removed";
                const passEvidence: unknown[] = [];
                lines.length = 0;
                for (let pass = 0; pass < 12; pass++) {
                    let served: MessageLike[];
                    try {
                        served = await fixture.run(input);
                    } catch (error) {
                        refusals++;
                        expect(pass).toBe(0);
                        expect(rustRawRebuild(fixture.db, sid)).toMatchObject({
                            pending: true,
                            reason,
                        });
                        passEvidence.push({
                            pass,
                            refusal: String(error),
                            obligation: rustRawRebuild(fixture.db, sid),
                        });
                        continue;
                    }
                    const body = await providerBody(served);
                    const rebuilding =
                        fixture.response.materialize_reason === "raw_replay_identity_rebuild";
                    const evidence = decisions.getPending(sid)?.lkgFrozenReleaseReason;
                    if (rebuilding) {
                        rebuilds++;
                        expect(fixture.response.prefix_bust_permitted).toBe(true);
                        expect(fixture.request.raw_replay_rebuild).toMatchObject({
                            reason,
                            message_ids: ["raw"],
                        });
                        expect(evidence).toStartWith(`raw_replay_${reason};first_changed=raw#`);
                    } else {
                        expect(fixture.response.prefix_bust_permitted).toBe(false);
                        expect(fixture.request.raw_replay_rebuild).toBeUndefined();
                    }
                    expect(rustRawRebuild(fixture.db, sid)?.pending).toBe(false);
                    if (stable !== undefined) expect(body).toBe(stable);
                    stable = body;
                    if (change === "deletion" || change === "revert") {
                        expect(body).not.toContain("raw-call");
                        expect(body).not.toContain("output raw");
                    }
                    if (change !== "candidate-loss")
                        expect(body).not.toContain("removed reminder r2");
                    if (change === "synthetic-change")
                        expect(body).toContain("current reminder r2");
                    if (change === "candidate-loss") expect(body).toContain("output raw");
                    passEvidence.push({
                        pass,
                        rebuilding,
                        permission: fixture.response.prefix_bust_permitted,
                        evidence,
                    });
                }
                expect(refusals).toBe(1);
                expect(rebuilds).toBe(1);
                const logPath = join(scratch("r2-pass-log-"), "passes.log");
                writeFileSync(logPath, lines.join("\n"));
                const accounted = withSchedulerLogFallback([], sid, logPath).filter((decision) =>
                    decision.lkgFrozenReleaseReason?.startsWith(`raw_replay_${reason};`),
                );
                expect(accounted).toHaveLength(1);
                expect(
                    classifyCacheBust({
                        divergenceIndex: 1,
                        previousMessageCount: 4,
                        decision: accounted[0],
                    }),
                ).toBe("accounted_lkg_frozen_release");
                console.info(
                    JSON.stringify({
                        change,
                        refusals,
                        rebuilds,
                        passEvidence,
                        analyzer: "accounted_lkg_frozen_release",
                    }),
                );
            } finally {
                logs.mockRestore();
            }
        }, 120_000);
    }

    test("ordinary passes cannot request the recovery-only identity rebuild", async () => {
        const fixture = await hostFixture("r2-no-obligation", binary!);
        const input = [user(fixture.sid, "initial")];
        for (let pass = 0; pass < 12; pass++) {
            input.push(user(fixture.sid, `u${pass}`), tool(fixture.sid, `t${pass}`));
            await fixture.run(input);
            expect(rustRawRebuild(fixture.db, fixture.sid)).toBeUndefined();
            expect(fixture.request.raw_replay_rebuild).toBeUndefined();
            expect(fixture.response.materialize_reason).not.toBe("raw_replay_identity_rebuild");
        }
    }, 120_000);

    test("module trusts an explicit recovery declaration but visibility IDs alone grant nothing", async () => {
        const fixture = await hostFixture("r2-declared-authority", binary!);
        const input = [user(fixture.sid, "initial"), tool(fixture.sid, "ordinary")];
        await fixture.run(input);
        await fixture.run(input);
        const request: Record<string, unknown> = {
            ...fixture.request,
            tool_present: true,
            auto_search_enabled: false,
            cache_ttl: "never",
        };
        const noDeclaration = probe(binary!, fixture.directory, {
            ...request,
            served_raw_block_ids: ["ordinary#1"],
        });
        expect(noDeclaration.prefix_bust_permitted).toBe(false);
        expect(noDeclaration.materialize_reason).not.toBe("raw_replay_identity_rebuild");
        expect(rustRawRebuild(fixture.db, fixture.sid)).toBeUndefined();
        const identity = "a".repeat(64);
        const declared = probe(binary!, fixture.directory, {
            ...request,
            render_config: `${request.render_config}|raw_replay:${identity}`,
            raw_replay_rebuild: { identity, reason: "source_removed", message_ids: ["ordinary"] },
        });
        expect(declared.prefix_bust_permitted).toBe(true);
        expect(declared.materialize_reason).toBe("raw_replay_identity_rebuild");
        expect(rustRawRebuild(fixture.db, fixture.sid)).toBeUndefined();
        console.info(
            JSON.stringify({
                moduleAuthority: "trusted caller declaration",
                declarationWithoutHostObligation: declared.materialize_reason,
            }),
        );
    }, 120_000);

    test("raw release accepts reordered tool inputs without a raw identity rebuild", async () => {
        const fixture = await hostFixture("r2-wire-order", binary!);
        const input = [user(fixture.sid, "initial")];
        await fixture.run(input);
        const raw = tool(fixture.sid, "raw");
        (raw.parts[0] as { state: { input: unknown } }).state.input = { z: 1, a: 2 };
        input.push(raw);
        const replay = { messages: structuredClone(input) } as Parameters<
            typeof tryMessagesTransformLkgReplay
        >[0]["output"];
        expect(
            tryMessagesTransformLkgReplay({
                output: replay,
                sessionId: fixture.sid,
                error: new Error("offline outage"),
                rust: fixture.host.replayParticipant,
            }),
        ).toBe(true);
        const before = blocks(await providerBody(replay.messages));
        await fixture.run(input);
        dropSlot(fixture.sid, "message_removed");
        (raw.parts[0] as { state: { input: unknown } }).state.input = { a: 2, z: 1 };
        input.push(user(fixture.sid, "continued"));
        const served = await fixture.run(input);
        const after = blocks(await providerBody(served)).slice(0, before.length);
        expect(after).not.toEqual(before);
        expect(fixture.response.prefix_bust_permitted).toBe(false);
        expect(rustRawRebuild(fixture.db, fixture.sid)).toBeUndefined();
        expect(decisions.getPending(fixture.sid)?.lkgFrozenReleaseReason).toBe(
            "lkg_invalidated_reshape;first_changed=unknown",
        );
        console.info(
            JSON.stringify({
                acceptedToolInputOrder: {
                    before,
                    after,
                    prefixPermission: fixture.response.prefix_bust_permitted,
                },
            }),
        );
    }, 120_000);
});

test("JSON number spelling and outer native key order restore current ingress without refusal", async () => {
    const db = database();
    const old = [tool("r2-number", "raw")];
    const part = old[0]!.parts[0] as { state: { input: unknown } };
    part.state.input = JSON.parse('{"negativeZero":-0,"exponent":1e0,"decimal":1.00}');
    noteRustServedRaw(db, "r2-number", old, old);
    const ingress = structuredClone(old);
    const native = ingress[0]!.parts[0] as Record<string, unknown>;
    ingress[0]!.parts[0] = Object.fromEntries(Object.entries(native).reverse());
    (ingress[0]!.parts[0] as { state: { input: unknown } }).state.input = JSON.parse(
        '{"negativeZero":0,"exponent":1,"decimal":1}',
    );
    expect(await providerBody(ingress)).toBe(await providerBody(old));
    expect(() => checkRustServedRawIngress(db, "r2-number", ingress)).not.toThrow();
    const candidate = structuredClone(old);
    (candidate[0]!.parts[0] as { state: { output: string } }).state.output = "§9§ output raw";
    preserveRustServedRaw(db, "r2-number", candidate, ingress);
    expect(candidate).toEqual(ingress);
    expect(await providerBody(candidate)).toBe(await providerBody(old));
});

test("sorted digest accepts reordered tool input although actual provider bytes change", async () => {
    const db = database();
    const old = [tool("r2-input-order", "raw")];
    (old[0]!.parts[0] as { state: { input: unknown } }).state.input = { z: 1, a: 2 };
    noteRustServedRaw(db, "r2-input-order", old, old);
    const ingress = structuredClone(old);
    (ingress[0]!.parts[0] as { state: { input: unknown } }).state.input = { a: 2, z: 1 };
    const before = await providerBody(old);
    const after = await providerBody(ingress);
    expect(after).not.toBe(before);
    expect(() => checkRustServedRawIngress(db, "r2-input-order", ingress)).not.toThrow();
    const candidate = structuredClone(ingress);
    (candidate[0]!.parts[0] as { state: { output: string } }).state.output = "§9§ output raw";
    preserveRustServedRaw(db, "r2-input-order", candidate, ingress);
    expect(await providerBody(candidate)).toBe(after);
    console.info(
        JSON.stringify({
            digestAcceptsWireChange: true,
            before: JSON.parse(before).messages,
            after: JSON.parse(after).messages,
        }),
    );
});

test("provider-invisible tool timestamps still trigger a conservative source conflict", async () => {
    const db = database();
    const old = [tool("r2-time", "raw")];
    noteRustServedRaw(db, "r2-time", old, old);
    const ingress = structuredClone(old);
    (ingress[0]!.parts[0] as { state: { time: { end: number } } }).state.time.end = 3;
    expect(await providerBody(ingress)).toBe(await providerBody(old));
    expect(() => checkRustServedRawIngress(db, "r2-time", ingress)).toThrow("source_changed");
});

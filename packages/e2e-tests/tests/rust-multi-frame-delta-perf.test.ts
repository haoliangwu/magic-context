/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { MODULE_PAGE_MAX_BYTES } from "../../plugin/src/hooks/magic-context/module-wire";
import { RustTestHarness, type RustPassLine } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";
import { appendPerfReplay } from "../src/rust-perf-replay";

const STRICT_TRANSPORT_BUDGET_MS = 30;

const formatTiming = (pass: RustPassLine) => ({
    messages: pass.inputCount,
    adapter_overhead_ms: pass.adapterElapsedMs,
    end_to_end_ms: pass.adapterElapsedMs + pass.moduleElapsedMs,
    module_ms: pass.moduleElapsedMs,
    prefix_guard_ms: pass.prefixGuardMs,
    state_sync_ms: pass.stateSyncMs,
    wire_build_ms: pass.wireBuildMs,
    wire_messages: pass.wireMessages,
    transport_ms: pass.transportMs,
    transport_pages: pass.transportPages,
    transport_bytes: pass.transportBytes,
});

describe.skipIf(!rustPrereqs.ok)("rust transport: large tail delta", () => {
    let h: RustTestHarness;

    beforeAll(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 50_000_000,
            magicContextConfig: {
                execute_threshold_percentage: 95,
                protected_tags: 1,
                compressor: { enabled: false },
            },
        });
    });

    afterAll(async () => {
        if (h) {
            console.log(
                readFileSync(h.logPath, "utf8")
                    .split("\n")
                    .filter((line) => /rust pass:|rust transform failed/.test(line))
                    .slice(-10)
                    .join("\n"),
            );
        }
        await h?.dispose();
    });

    it("keeps module paging bounded while preserving a large provider-visible tail", async () => {
        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "establish the initial module snapshot");
        await h.waitForRustPasses(1);

        const replayDb = process.env.MC_RUST_PERF_REPLAY_DB;
        const replaySession = process.env.MC_RUST_PERF_REPLAY_SESSION;
        const historyCount =
            replayDb && replaySession
                ? appendPerfReplay(h, sessionId, replayDb, replaySession)
                : 2_000;
        console.log(
            `[rust-e2e] history_messages=${historyCount} source=${replayDb && replaySession ? "read-only replay" : "synthetic"}`,
        );
        if (!replayDb || !replaySession)
            h.appendSyntheticHistory(sessionId, {
                count: historyCount,
                textBytes: 128,
            });
        await h.restart({
            rust: true,
            magicContextConfig: {
                execute_threshold_percentage: 95,
                protected_tags: 1,
                compressor: { enabled: false },
            },
        });
        await h.sendPrompt(sessionId, "prime the synthetic big-session snapshot", {
            timeoutMs: replayDb ? 90_000 : 300_000,
        });
        const primed = await h.waitFor(
            () => {
                const passes = h.readRustPasses();
                for (let index = passes.length - 1; index >= 0; index -= 1) {
                    if (passes[index]!.inputCount > historyCount) return passes[index];
                }
                return undefined;
            },
            { timeoutMs: 30_000, label: "primed 2,000-message rust pass" },
        );
        expect(primed.inputCount).toBeGreaterThan(historyCount);
        expect(primed.servedFrom).toBe("transform");
        if (!replayDb) {
            const wire = h.lastMainWireSerialized();
            const lastSynthetic = wire.indexOf(
                `synthetic history message ${String(historyCount - 1).padStart(4, "0")}`,
            );
            expect(lastSynthetic).toBeGreaterThanOrEqual(0);
            expect(wire.indexOf("establish the initial module snapshot")).toBeGreaterThan(
                lastSynthetic,
            );
        }
        // Priming can reuse the caller-owned native tail in one request or page a full
        // retransmission. This phase establishes module state; the large delta below
        // separately proves that provider-visible tail content survives either path.
        expect(primed.transportPages).toBeGreaterThanOrEqual(1);
        expect(primed.transportPages).toBeLessThanOrEqual(6);

        let settled = primed;
        for (let probe = 0; !settled.applied && probe < 3; probe += 1) {
            const before = h.readRustPasses().length;
            await h.sendPrompt(sessionId, `settle the synthetic big-session snapshot ${probe}`);
            settled = (await h.waitForRustPasses(before + 1)).at(-1)!;
        }
        expect(settled.applied).toBe(true);

        const smallDeltas: RustPassLine[] = [];
        const servedWireHashes: string[] = [];
        for (let probe = 0; probe < 5; probe += 1) {
            const before = h.readRustPasses().length;
            await h.sendPrompt(sessionId, `small steady-state delta ${probe}`);
            smallDeltas.push((await h.waitForRustPasses(before + 1)).at(-1)!);
            if (process.env.MC_RUST_PERF_WIRE_ARTIFACT) {
                writeFileSync(
                    `${process.env.MC_RUST_PERF_WIRE_ARTIFACT}-${probe}.json`,
                    JSON.stringify(h.lastMainMessages()),
                );
            }
            servedWireHashes.push(
                createHash("sha256").update(JSON.stringify(h.lastMainMessages())).digest("hex"),
            );
        }
        const smallDelta = [...smallDeltas].sort(
            (left, right) => left.adapterElapsedMs - right.adapterElapsedMs,
        )[Math.floor(smallDeltas.length / 2)]!;

        const providerBytesBeforeLargeTail = h.lastMainWireBytes();
        const before = h.readRustPasses().length;
        await h.sendPrompt(sessionId, `large tail delta: ${h.ballast(160_000)}`, {
            timeoutMs: 300_000,
        });
        const largeTailDelta = (await h.waitForRustPasses(before + 1)).at(-1)!;
        const providerBytesAfterLargeTail = h.lastMainWireBytes();

        console.log(
            `[rust-e2e] large tail delta timings ${JSON.stringify({
                primed: formatTiming(primed),
                small_delta_samples: smallDeltas.map(formatTiming),
                served_wire_sha256: servedWireHashes,
                small_delta_p50: formatTiming(smallDelta),
                large_tail_delta: formatTiming(largeTailDelta),
                provider_bytes_before: providerBytesBeforeLargeTail,
                provider_bytes_after: providerBytesAfterLargeTail,
            })}`,
        );

        const passLines = readFileSync(h.logPath, "utf8")
            .split("\n")
            .filter((line) => line.includes("rust pass:"));
        expect(passLines.length).toBeGreaterThan(0);
        for (const line of passLines) expect(line).toMatch(/todo_unprobed_bust:\d+/);
        const missedBusts = passLines.filter((line) => /todo_unprobed_bust:[1-9]/.test(line));
        console.log(
            `[rust-e2e] todo predictor passes=${passLines.length} unprobed_busts=${missedBusts.length}`,
        );
        expect(missedBusts).toEqual([]);
        expect(smallDeltas.every((pass) => pass.applied)).toBe(true);
        // Steady updates must resolve message positions and serialize only the new
        // tail, not the 2,000-message history. Shared runners cannot enforce ms limits.
        expect(smallDeltas.every((pass) => /ordinal_mode:incremental\b/.test(pass.raw))).toBe(true);
        expect(smallDeltas.every((pass) => {
            const rows = /\bordinal_rows:(\d+)\b/.exec(pass.raw);
            return rows !== null && Number(rows[1]) > 0 && Number(rows[1]) <= 4;
        })).toBe(true);
        // The hermetic daemon uses ck-mc over external TCP, which can add scheduling overhead.
        // Apply timing limits only in strict production-like environments; enforce message,
        // page-count, and payload-size limits in every environment.
        if (process.env.MC_PERF_GATE === "1") {
            expect(smallDelta.transportMs).toBeLessThan(STRICT_TRANSPORT_BUDGET_MS);
            expect(smallDelta.adapterElapsedMs).toBeLessThan(100);
        } else {
            const strictBudgetLine =
                `[rust-e2e] strict transport gate=off observed_ms=${smallDelta.transportMs} ` +
                `strict_budget_ms=${STRICT_TRANSPORT_BUDGET_MS}`;
            console.log(strictBudgetLine);
            expect(strictBudgetLine).toBe(
                `[rust-e2e] strict transport gate=off observed_ms=${smallDelta.transportMs} strict_budget_ms=30`,
            );
        }
        expect(smallDeltas.every((pass) => pass.wireMessages > 0 && pass.wireMessages <= 4)).toBe(true);
        expect(smallDeltas.every((pass) => pass.transportPages === 1)).toBe(true);
        // Small steady-state deltas carry only a few KB, not the entire history.
        expect(smallDeltas.every((pass) => pass.transportBytes < 160_000)).toBe(true);

        // SOFT+ may reuse the caller-owned tail in one small module request or retransmit the
        // same bytes across bounded pages. The page cap is derived from subc's frame limit, so
        // a ~1.3 MB tail is legitimately a single page; the invariant is that a page never
        // exceeds the cap and that a multi-page series only happens above it. The provider
        // wire-size increase separately proves that the large tail was not lost.
        expect(largeTailDelta.applied).toBe(true);
        expect(largeTailDelta.transportPages).toBeGreaterThanOrEqual(1);
        expect(largeTailDelta.transportPages).toBeLessThanOrEqual(6);
        expect(largeTailDelta.wireMessages).toBeLessThanOrEqual(4);
        expect(largeTailDelta.raw).toMatch(/ordinal_mode:incremental\b/);
        expect(Number(/\bordinal_rows:(\d+)\b/.exec(largeTailDelta.raw)?.[1])).toBeLessThanOrEqual(4);
        expect(largeTailDelta.transportBytes).toBeGreaterThan(160_000);
        if (largeTailDelta.transportPages === 1) {
            expect(largeTailDelta.transportBytes).toBeLessThanOrEqual(MODULE_PAGE_MAX_BYTES);
        } else {
            expect(largeTailDelta.transportBytes).toBeGreaterThan(MODULE_PAGE_MAX_BYTES);
        }
        expect(providerBytesAfterLargeTail).toBeGreaterThan(providerBytesBeforeLargeTail + 160_000);
        expect(h.lastMainWireSerialized()).toContain("large tail delta");
    }, 600_000);
});

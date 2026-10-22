/// <reference types="bun-types" />

/**
 * Reproduction probe for the first transform pass after a host restart
 * (GitHub issue 752). Skipped unless MC_REPRO_752=1.
 *
 * Each case seeds a real session on a real host through the mock provider:
 * about 60% of the usable window on the live usage basis (below the 65%
 * execute threshold), a handful of large tool results, and one queued drop.
 * It then restarts the host with the same throwaway stores and measures the
 * first pass after the restart: the transform_decisions rows it wrote, the
 * queued drop, the bytes it served compared with the last request before the
 * restart, and the usage reading the plugin logged for the pass.
 *
 * Each assertion states the behavior the issue says should hold, so a case
 * goes red exactly where the reported defect is real:
 *
 * - "warm restart": the restart lands inside the provider cache window. The
 *   first pass owes no work, so it must serve the previous request's bytes
 *   unchanged, write no decision row and leave the queued drop queued.
 * - "expired restart": the idle window lapsed while the host was down. The
 *   pass owes the idle rebuild and may drain the queued drop, but a session at
 *   about 60% must not be read at or above the 85% force band, so the
 *   emergency tool drop must not fire.
 * - "content-free m[0] fold": before the next turn, an m[0] mutation-log
 *   entry that changes no rendered content is recorded (the shape of a plugin
 *   upgrade or memory bump that re-renders the same bytes). The fold it forces
 *   re-renders identical bytes, so it grants no bust permission and the pass
 *   must serve the previous bytes unchanged, both in a warm process (control)
 *   and on the first pass after a restart.
 *
 * The mock model is not in the tokenizer calibration table, which is the
 * normal state for any model Magic Context has no measurements for.
 */

import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { estimateTokens } from "../../plugin/src/hooks/magic-context/read-session-formatting";
import { inspectHostOpenFiles } from "../src/host-open-files";
import type { CapturedRequest } from "../src/mock-provider/server";
import {
    createFreshSession,
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import { createE2ETempDir } from "../src/temp-dir";
import { openTestDb } from "../src/test-db";

const ENABLED = process.env.MC_REPRO_752 === "1";
const CONTEXT_LIMIT = 100_000;
// About 60% of the 91,808-token usable window this model resolves to
// (100,000 context minus the 8,192 output reserve), so every warm pass
// before the restart stays below the 65% execute threshold and defers. The
// seeded history is sized so the plugin's own local count of the request is
// at or below this figure: the reported usage never understates the bytes.
const WARM_USAGE = {
    input_tokens: 55_000,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
};
const IDLE_MS = 2 * 60 * 60 * 1000;
const TOOL_STEPS = 8;
const FORCE_BAND = 85;

type DecisionRow = {
    message_id: string;
    ts_ms: number;
    decision: string;
    materialized: number;
    materialize_reason: string | null;
    emergency: number;
    dropped_count: number;
    dropped_tokens: number;
    input_tokens: number;
};

/** Hosts move cache breakpoints forward; only that metadata is excluded. */
function durable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(durable);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => key !== "cache_control")
                .map(([key, inner]) => [key, durable(inner)]),
        );
    }
    return value;
}

const serialize = (value: unknown) => JSON.stringify(durable(value));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** Compares the earlier request's whole message array with the same span of the later one. */
function prefixDiff(before: CapturedRequest, after: CapturedRequest) {
    const a = serialize(before.body.messages);
    const b = serialize(after.body.messages?.slice(0, before.body.messages?.length));
    let common = 0;
    while (common < Math.min(a.length, b.length) && a[common] === b[common]) common++;
    return {
        identicalMessages: a === b,
        identicalSystem: serialize(before.body.system) === serialize(after.body.system),
        identicalTools: serialize(before.body.tools) === serialize(after.body.tools),
        beforeMessageBytes: Buffer.byteLength(a),
        sharedMessageBytes: Buffer.byteLength(a.slice(0, common)),
        firstDifferenceAt: a === b ? null : common,
        beforeAround: a === b ? null : a.slice(Math.max(0, common - 120), common + 200),
        afterAround: a === b ? null : b.slice(Math.max(0, common - 120), common + 200),
        beforeSha256: sha(a),
        afterSpanSha256: sha(b),
    };
}

function isSessionRequest(request: CapturedRequest): boolean {
    return (
        Array.isArray(request.body.tools) &&
        request.body.tools.length > 0 &&
        JSON.stringify(request.body.system).includes("## Magic Context")
    );
}

function hostPid(h: ScenarioHarness): number | undefined {
    const handle = h as unknown as {
        opencode?: { pid: number };
        hostPid?: number;
        fixture?: { pid: number };
    };
    return handle.opencode?.pid ?? handle.hostPid ?? handle.fixture?.pid;
}

/**
 * Proves the host holds only stores under the throwaway root: an lsof inventory
 * of the host PID, or the OpenCode 2 runner's own process-group/inode guard.
 */
function assertContained(h: ScenarioHarness) {
    if (h.host === "opencode2") return { guardedBy: "OC2 runner process-group/inode guard" };
    const pid = hostPid(h);
    if (!pid) throw new Error("host PID unavailable for live-store isolation");
    const inventory = inspectHostOpenFiles(pid, dirname(h.dataDir));
    expect(inventory.databases.length).toBeGreaterThan(0);
    return { pid, databases: inventory.databases };
}

function pluginLog(h: ScenarioHarness): string {
    if (h.host === "opencode2") {
        return (h as unknown as { opencode: { pluginLog: () => string } }).opencode.pluginLog();
    }
    const path =
        process.env.MAGIC_CONTEXT_LOG_PATH ?? join(h.dataDir, "cortexkit", "magic-context-e2e.log");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function linesSince(h: ScenarioHarness, session: string, since: number): string[] {
    return pluginLog(h)
        .split("\n")
        .filter((line) => line.includes(session) && Date.parse(line.slice(1, 25)) >= since);
}

function decisionRows(h: ScenarioHarness, session: string): DecisionRow[] {
    const db = openTestDb(h.contextDbPath(), { readonly: true });
    try {
        return db
            .prepare(
                "SELECT message_id, ts_ms, decision, materialized, materialize_reason, emergency, dropped_count, dropped_tokens, input_tokens FROM transform_decisions WHERE session_id = ? AND harness = ? ORDER BY ts_ms",
            )
            .all(session, h.harnessId) as DecisionRow[];
    } finally {
        db.close();
    }
}

function pendingCount(h: ScenarioHarness, session: string): number {
    const db = openTestDb(h.contextDbPath(), { readonly: true });
    try {
        return (
            db
                .prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ?")
                .get(session) as { n: number }
        ).n;
    } finally {
        db.close();
    }
}

function tagCounts(h: ScenarioHarness, session: string) {
    const db = openTestDb(h.contextDbPath(), { readonly: true });
    try {
        return db
            .prepare(
                "SELECT type, status, COUNT(*) AS n FROM tags WHERE session_id = ? GROUP BY type, status ORDER BY type, status",
            )
            .all(session) as { type: string; status: string; n: number }[];
    } finally {
        db.close();
    }
}

function sessionUsage(h: ScenarioHarness, session: string) {
    const db = openTestDb(h.contextDbPath(), { readonly: true });
    try {
        return db
            .prepare(
                "SELECT last_context_percentage, last_input_tokens, last_usage_context_limit, last_observed_model_key, last_response_time, cache_ttl FROM session_meta WHERE session_id = ? AND harness = ?",
            )
            .get(session, h.harnessId);
    } finally {
        db.close();
    }
}

function queueDropOnOldestTool(h: ScenarioHarness, session: string): number {
    const db = openTestDb(h.contextDbPath());
    try {
        const tag = db
            .prepare(
                "SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' AND status = 'active' ORDER BY tag_number LIMIT 1",
            )
            .get(session) as { tag_number: number } | null;
        if (!tag) throw new Error("no active tool tag to queue a drop on");
        db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, ?)",
        ).run(session, tag.tag_number, Date.now(), h.harnessId);
        return tag.tag_number;
    } finally {
        db.close();
    }
}

/** Ages the idle clock the way a long host downtime would. */
function expireIdleClock(h: ScenarioHarness, session: string): void {
    const db = openTestDb(h.contextDbPath());
    try {
        const result = db
            .prepare(
                "UPDATE session_meta SET last_response_time = last_response_time - ?, cached_m0_materialized_at = cached_m0_materialized_at - ? WHERE session_id = ? AND harness = ? AND last_response_time > 0",
            )
            .run(IDLE_MS, IDLE_MS, session, h.harnessId);
        expect(result.changes).toBe(1);
    } finally {
        db.close();
    }
}

type CaseKind = "warm" | "expired" | "identical-fold-restart" | "identical-fold-warm";

/**
 * Records an m[0] mutation-log entry that changes no rendered content (there
 * are no compartments to merge). The next pass must fold m[0] for it, but the
 * fold re-renders identical bytes, so by design it grants no bust permission.
 */
function queueContentFreeMutation(h: ScenarioHarness, session: string): void {
    const db = openTestDb(h.contextDbPath());
    try {
        db.prepare(
            "INSERT INTO m0_mutation_log (session_id, mutation_type, target_id, queued_at) VALUES (?, 'compartment_merge', NULL, ?)",
        ).run(session, Date.now());
    } finally {
        db.close();
    }
}

async function runCase(host: Parameters<typeof createScenarioHarness>[0], kind: CaseKind) {
    const expired = kind === "expired";
    const restart = kind !== "identical-fold-warm";
    const previousLogPath = process.env.MAGIC_CONTEXT_LOG_PATH;
    // Every host child inherits this, so the plugin log stays in the throwaway root.
    process.env.MAGIC_CONTEXT_LOG_PATH = join(createE2ETempDir("issue-752-log-"), "plugin.log");
    const h = await createScenarioHarness(host, {
        modelContextLimit: CONTEXT_LIMIT,
        magicContextConfig: {
            cache_ttl: { default: "1h" },
            execute_threshold_percentage: 65,
            protected_tokens: 2_000,
            historian: { disable: true },
        },
        mockDefault: { text: "answer", usage: WARM_USAGE },
    });
    try {
        const session = await createFreshSession(h);
        const sessionRequests = (from: number) => h.requests().slice(from).filter(isSessionRequest);
        const turn = async (text: string) => {
            const start = Date.now();
            const count = h.requests().length;
            await h.sendPrompt(session, text, { timeoutMs: 120_000 });
            await h.waitForMockQuiescence();
            await h.waitFor(
                () =>
                    linesSince(h, session, start).some((line) =>
                        /transform completed|rust pass:/.test(line),
                    ),
                { timeoutMs: 10_000, label: "completed transform log" },
            );
            const requests = sessionRequests(count);
            expect(requests.length).toBeGreaterThan(0);
            return { start, end: Date.now(), requests, log: linesSince(h, session, start) };
        };

        // Real conversation mass, calibrated with the plugin's own tokenizer.
        const sample = h.ballast(10_000);
        const chunk = h.ballast(Math.round((5_000 * 10_000) / estimateTokens(sample)));
        await turn(`history one\n${chunk}`);
        const first = await turn(`history two\n${chunk}`);
        // Large tool results the session could drop.
        const bash = (first.requests.at(-1)!.body.tools as { name: string }[]).find(
            (tool) => tool.name === "bash",
        )?.name;
        expect(bash).toBe("bash");
        for (let step = 0; step < TOOL_STEPS; step++) {
            h.mock.enqueue({
                content: [
                    {
                        type: "tool_use",
                        id: `toolu_752_${step}`,
                        name: bash!,
                        input: { command: `seq 1 2000`, description: `listing ${step}` },
                    },
                ],
                stop_reason: "tool_use",
                usage: WARM_USAGE,
            });
        }
        h.mock.enqueue({ text: "listed", usage: WARM_USAGE });
        await turn("run the listings");
        const queuedTag = queueDropOnOldestTool(h, session);
        const lastWarm = await turn("warm turn with the queued drop");
        expect(pendingCount(h, session)).toBe(1);
        const before = lastWarm.requests.at(-1)!;
        const usageBeforeRestart = sessionUsage(h, session);
        const warmWireEstimate = lastWarm.log.filter((line) => /final-wire telemetry estimate=/.test(line));
        const rowsBeforeRestart = decisionRows(h, session);
        const tagsBeforeRestart = tagCounts(h, session);
        const containedBefore = assertContained(h);

        if (expired) expireIdleClock(h, session);
        if (kind === "identical-fold-restart" || kind === "identical-fold-warm") {
            queueContentFreeMutation(h, session);
        }
        const dataDir = h.dataDir;
        if (restart) await h.restart();
        expect(h.dataDir).toBe(dataDir);
        const containedAfterRestart = assertContained(h);

        const boot = await turn("first turn after the restart");
        // One more warm turn binds any pending decision row on hosts that bind late.
        const next = await turn("next warm turn");
        const containedAfter = assertContained(h);
        const rows = decisionRows(h, session);
        const bootRows = rows.filter((row) => row.ts_ms >= boot.start && row.ts_ms <= boot.end);
        const nextRows = rows.filter((row) => row.ts_ms >= next.start);
        const bootRequest = boot.requests[0]!;
        const diff = prefixDiff(before, bootRequest);
        const bootReading = boot.log
            .map((line) => /unknown provider usage;.*percentage=([\d.]+)/.exec(line)?.[1])
            .find((value) => value !== undefined);
        const usageLines = boot.log.filter((line) =>
            /unknown provider usage|transform scheduler:|first pass reset|heuristics WILL|pending ops|emergency tiered drop|force_materialization|ride=/.test(
                line,
            ),
        );
        const summary = {
            host,
            case: kind,
            session,
            queuedTag,
            usageBeforeRestart,
            warmWireEstimate,
            bootReading: bootReading === undefined ? null : Number(bootReading),
            rowsBeforeRestart,
            tagsBeforeRestart,
            bootRows,
            nextRows,
            pendingAfterBoot: pendingCount(h, session),
            tagsAfter: tagCounts(h, session),
            diff,
            bootRequests: boot.requests.map((request) => ({
                rawBytes: Buffer.byteLength(request.rawBody ?? ""),
                sha256: sha(request.rawBody ?? ""),
            })),
            beforeRawBytes: Buffer.byteLength(before.rawBody ?? ""),
            usageLines,
            containment: [containedBefore, containedAfterRestart, containedAfter],
        };
        console.log("ISSUE_752", JSON.stringify(summary));
        const evidence = process.env.ISSUE_752_EVIDENCE;
        if (evidence) {
            mkdirSync(evidence, { recursive: true });
            const name = `${host}-${kind}`;
            writeFileSync(join(evidence, `${name}.json`), JSON.stringify(summary, null, 2));
            writeFileSync(join(evidence, `${name}.log`), pluginLog(h));
            writeFileSync(
                join(evidence, `${name}-requests.json`),
                JSON.stringify({ before: before.body, boot: bootRequest.body }, null, 2),
            );
        }

        if (!expired) {
            // Inside the cache window the pass owes nothing, and a fold that
            // re-renders identical bytes grants no bust either: same bytes and
            // the queued drop still queued.
            expect(diff.identicalMessages).toBe(true);
            expect(diff.identicalSystem).toBe(true);
            expect(diff.identicalTools).toBe(true);
            expect(summary.pendingAfterBoot).toBe(1);
            if (kind === "warm") {
                expect(bootRows).toEqual([]);
            } else {
                // The forced fold records a materialized row even when it
                // re-renders the same bytes; it must not drop anything.
                for (const row of bootRows) expect(row.dropped_count).toBe(0);
            }
        } else {
            // The idle rebuild is owed, but a session at about 60% must not be
            // sized into the force band, so no emergency tool drop.
            expect(bootRows.length).toBeGreaterThan(0);
            expect(summary.bootReading ?? 0).toBeLessThan(FORCE_BAND);
            for (const row of bootRows) expect(row.emergency).toBe(0);
            expect(usageLines.some((line) => /emergency tiered drop: /.test(line))).toBe(false);
        }
    } finally {
        await h.dispose();
        if (previousLogPath === undefined) delete process.env.MAGIC_CONTEXT_LOG_PATH;
        else process.env.MAGIC_CONTEXT_LOG_PATH = previousLogPath;
    }
}

forEachHost(import.meta.url, "issue 752 first pass after a host restart", (host) => {
    it.skipIf(!ENABLED)(
        "a warm restart inside the cache window serves the same bytes and owes no work",
        () => runCase(host, "warm"),
        300_000,
    );
    it.skipIf(!ENABLED)(
        "an expired restart rebuilds once without sizing a 60% session into the emergency band",
        () => runCase(host, "expired"),
        300_000,
    );
    it.skipIf(!ENABLED)(
        "control: a content-free m[0] fold in a warm process serves the same bytes",
        () => runCase(host, "identical-fold-warm"),
        300_000,
    );
    it.skipIf(!ENABLED)(
        "a content-free m[0] fold on the first pass after a restart serves the same bytes",
        () => runCase(host, "identical-fold-restart"),
        300_000,
    );
});

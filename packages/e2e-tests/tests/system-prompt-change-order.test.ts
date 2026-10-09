/// <reference types="bun-types" />

/**
 * System-prompt change detection order on a real OpenCode 1 host.
 *
 * OpenCode 1.18.x builds each provider request in this order:
 * `experimental.chat.messages.transform` runs first, then the host re-reads
 * AGENTS.md / configured instruction files, and only then
 * `experimental.chat.system.transform` runs inside the LLM request builder.
 * So a changed system prompt reaches Magic Context after the messages of that
 * same request are already final.
 *
 * The provider prompt cache is a prefix cache whose head is the system block.
 * A system edit therefore busts the provider cache on the request that first
 * carries it. If Magic Context reacts to that observation by rebuilding m[0]
 * on the NEXT request, the provider pays a second full cache rewrite one turn
 * later. This scenario edits AGENTS.md and, separately, a configured
 * `instructions` file, and requires exactly one prefix rewrite per edit.
 *
 * The expectations assume that messages-first order: the queued drops must still
 * be pending after the edited request, and the only allowed rewrite is that
 * request's system change. A host that runs the system hook first folds on the
 * edited request itself, which is also correct but needs different expectations.
 * So the suite runs only against reference hosts pinned by executable hash (see
 * REFERENCE_HOSTS) and skips, with a message naming the binary and its hash, on
 * any other `opencode` on PATH. A version string alone is not enough: a locally
 * placed build reporting 1.18.30 was observed to fold on the edited request.
 *
 * Runs in the TypeScript transform by default and in the Rust transform with
 * MC_E2E_MODE=rust. Set SYSTEM_ORDER_EVIDENCE to a directory to dump the
 * per-request table used by docs/reports/system-prompt-change-detection-order.md.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TestHarness } from "../src/harness";
import { openTestDb } from "../src/test-db";
import type { CapturedRequest } from "../src/mock-provider/server";

const RUST = process.env.MC_E2E_MODE === "rust";

/**
 * SHA-256 of the `opencode` executable inside each npm `opencode-darwin-arm64`
 * package this fixture was validated against. Both were checked to run the
 * messages transform before the system transform on every main request.
 */
const REFERENCE_HOSTS: Record<string, string> = {
    // npm opencode-darwin-arm64@1.18.30, tarball sha256
    // 25b722fcdc8c46aebcb6501e1156dc1dc5a392492cc278c65b7775311674e7f8
    "2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62":
        "opencode-darwin-arm64@1.18.30 (npm)",
    // npm opencode-darwin-arm64@1.18.35, tarball sha256
    // b626543f4427cbd7a59756c24045f6f32dbc4cf7347ab5a8613f5c9fd6b0eeb3
    "8c3c351b138cfe35905ab11846a1373f1beea590aee7eda412fb765b72c79d82":
        "opencode-darwin-arm64@1.18.35 (npm)",
};

/** The harness spawns `opencode` from this process's PATH; hash that binary. */
function resolveReferenceHost(): { ok: true; label: string } | { ok: false; reason: string } {
    const binary = Bun.which("opencode", { PATH: process.env.PATH ?? "" });
    if (!binary) return { ok: false, reason: "no `opencode` executable on PATH" };
    const sha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
    const label = REFERENCE_HOSTS[sha256];
    if (!label) {
        return {
            ok: false,
            reason: `${binary} (sha256 ${sha256}) is not a pinned messages-first reference host; put the npm opencode-darwin-arm64 1.18.30 or 1.18.35 executable first on PATH`,
        };
    }
    return { ok: true, label };
}

const referenceHost = resolveReferenceHost();
if (!referenceHost.ok) {
    console.warn(`[system-prompt-change-order] SKIPPED: ${referenceHost.reason}`);
}
const EXTRA_INSTRUCTIONS = "extra-instructions.md";
// Replies large enough that an early reply leaves the protected tail, so a queued
// drop of it changes request bytes when a fold applies it.
const REPLY_TEXT = Array.from(
    { length: 400 },
    (_, line) => `reply line ${line}: the quick brown fox jumps over the lazy dog.`,
).join("\n");

function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [key, inner] of Object.entries(value)) {
            if (key === "cache_control") continue;
            out[key] = stripCacheControl(inner);
        }
        return out;
    }
    return value;
}

const digest = (value: unknown): string =>
    createHash("sha256").update(JSON.stringify(stripCacheControl(value)) ?? "undefined").digest("hex").slice(0, 12);

interface RequestRow {
    label: string;
    systemSha: string;
    systemBytes: number;
    msg0Sha: string;
    msg1Sha: string;
    /** Leading messages byte-identical (cache_control stripped) to the previous main request. */
    retainedPrefix: number;
    previousCount: number;
    messageCount: number;
    requestBytes: number;
    systemChanged: boolean;
    /** A prefix rewrite: the system changed, or a message the previous request already sent changed. */
    rewrite: boolean;
}

function isMainRequest(request: CapturedRequest): boolean {
    const system = request.body.system;
    if (system === undefined || system === null) return false;
    return JSON.stringify(system).includes("## Magic Context");
}

function tabulate(requests: CapturedRequest[], labels: string[]): RequestRow[] {
    const rows: RequestRow[] = [];
    let previous: CapturedRequest | undefined;
    requests.forEach((request, index) => {
        const messages = (request.body.messages ?? []) as unknown[];
        const prevMessages = (previous?.body.messages ?? []) as unknown[];
        let retained = 0;
        while (
            retained < prevMessages.length &&
            retained < messages.length &&
            digest(prevMessages[retained]) === digest(messages[retained])
        ) {
            retained += 1;
        }
        const systemChanged = previous !== undefined && digest(previous.body.system) !== digest(request.body.system);
        rows.push({
            label: labels[index] ?? `request ${index}`,
            systemSha: digest(request.body.system),
            systemBytes: Buffer.byteLength(JSON.stringify(request.body.system)),
            msg0Sha: digest(messages[0]),
            msg1Sha: digest(messages[1]),
            retainedPrefix: retained,
            previousCount: prevMessages.length,
            messageCount: messages.length,
            requestBytes: Buffer.byteLength(request.rawBody ?? JSON.stringify(request.body)),
            systemChanged,
            // The previous request's final message is the user turn whose
            // cache_control/attachment shape can legitimately differ; every
            // message before it was already a cached prefix.
            rewrite: previous !== undefined && (systemChanged || retained < prevMessages.length - 1),
        });
        previous = request;
    });
    return rows;
}

interface DecisionRow {
    decision: string;
    detail: string;
}

function readDecisions(h: TestHarness, sessionId: string): DecisionRow[] {
    if (RUST) {
        const logPath = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
        if (!existsSync(logPath)) return [];
        return readFileSync(logPath, "utf8")
            .split("\n")
            .filter((line) => line.includes(sessionId) && line.includes("rust pass: "))
            .map((line) => {
                const decision = /decision=(\S+)/.exec(line)?.[1] ?? "?";
                const reason = /reason=(\S+)/.exec(line)?.[1] ?? "?";
                const permitted = /prefix_bust_permitted=(\S+)/.exec(line)?.[1];
                return {
                    decision,
                    detail: `reason=${reason}${permitted ? ` permitted=${permitted}` : ""}`,
                };
            });
    }
    // The TypeScript transform logs one scheduler line and one m[0]/m[1]
    // injection line per pass; pair them in order.
    const logPath = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
    if (!existsSync(logPath)) return [];
    const lines = readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.includes(sessionId));
    const schedulers = lines
        .filter((line) => line.includes("transform scheduler:"))
        .map((line) => /decision=(\S+)/.exec(line)?.[1] ?? "?");
    const injections = lines
        .filter((line) => line.includes("transform: injected m[0]/m[1]"))
        .map((line) => /\((rematerialized=\S+, reason=[^)]+)\)/.exec(line)?.[1] ?? "?");
    return schedulers.map((decision, index) => ({
        decision,
        detail: injections[index] ?? "?",
    }));
}

function systemHashLog(h: TestHarness, sessionId: string): string[] {
    const logPath = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.includes(sessionId) && /system prompt hash (changed|initialized|adopted)/.test(line))
        .map((line) => line.replace(/^.*?(system prompt hash)/, "$1").slice(0, 160));
}

/**
 * Make the model call ctx_reduce on the next request, through the real host tool
 * path, so the following Magic Context fold has bytes to change. Without queued
 * work a fold re-renders an identical prefix and a second rewrite cannot show up
 * in the request bytes.
 */
function scriptReduce(h: TestHarness, tag: number): void {
    h.mock.enqueue({
        content: [
            {
                type: "tool_use",
                id: `toolu_system_order_reduce_${tag}`,
                name: "ctx_reduce",
                input: { drop: String(tag) },
            },
        ],
        stop_reason: "tool_use",
        usage: {
            input_tokens: 2_000,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        },
    });
}

function pendingDropCount(h: TestHarness, sessionId: string): number {
    if (RUST) {
        const db = openTestDb(join(h.dataDir, "cortexkit", "magic-context", "store.db"), {
            readonly: true,
        });
        try {
            return (
                db
                    .prepare("SELECT COUNT(*) AS n FROM pending_agent_drops WHERE session_id = ?")
                    .get(sessionId) as { n: number }
            ).n;
        } finally {
            db.close();
        }
    }
    return (
        h
            .contextDb()
            .prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ?")
            .get(sessionId) as { n: number }
    ).n;
}

describe.skipIf(!referenceHost.ok)(`system prompt change detection order (${RUST ? "rust" : "ts"} transform)`, () => {
    let h: TestHarness;

    beforeAll(async () => {
        h = await TestHarness.create({
            openCodeConfigExtra: { instructions: [EXTRA_INSTRUCTIONS] },
            magicContextConfig: { execute_threshold_percentage: 80, protected_tokens: 4_000 },
            mockDefault: {
                text: REPLY_TEXT,
                usage: {
                    input_tokens: 2_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            },
        });
    }, 1_800_000);

    afterAll(async () => {
        await h?.dispose();
    });

    it(
        "an AGENTS.md edit and an instruction-file edit each rewrite the provider prefix once",
        async () => {
            writeFileSync(join(h.workdir, "AGENTS.md"), "Project rule v1: answer briefly.\n");
            writeFileSync(join(h.workdir, EXTRA_INSTRUCTIONS), "Extra instruction v1: be precise.\n");
            const sessionId = await h.createSession();
            const labels: string[] = [];
            const turn = async (label: string) => {
                const before = h.mock.requests().filter(isMainRequest).length;
                await h.sendPrompt(sessionId, `${label}: short probe turn.`);
                await h.waitForMockQuiescence({ label });
                const after = h.mock.requests().filter(isMainRequest).length;
                for (let i = before; i < after; i += 1) labels.push(label);
            };

            await turn("t1");
            await turn("t2");
            scriptReduce(h, 2);
            await turn("reduce t2b");
            writeFileSync(join(h.workdir, "AGENTS.md"), "Project rule v2: answer briefly and cite files.\n");
            await turn("agents-edit t3");
            // Non-vacuity: the drop is still queued after the request that carries
            // the edit, so a fold on the next request would change its bytes. The
            // Rust module records a queued drop on the pass after the tool call.
            const pendingAtAgentsEdit = pendingDropCount(h, sessionId);
            await turn("t4");
            await turn("t5");
            scriptReduce(h, 4);
            await turn("reduce t5b");
            writeFileSync(
                join(h.workdir, EXTRA_INSTRUCTIONS),
                "Extra instruction v2: be precise and list assumptions.\n",
            );
            await turn("instructions-edit t6");
            const pendingAtInstructionsEdit = pendingDropCount(h, sessionId);
            await turn("t7");
            await turn("t8");

            const main = h.mock.requests().filter(isMainRequest);
            const rows = tabulate(main, labels);
            const decisions = readDecisions(h, sessionId);
            const hashLog = systemHashLog(h, sessionId);
            const lines = rows.map((row, index) => {
                const decision = decisions[index];
                return `${row.label.padEnd(22)} sys=${row.systemSha}(${row.systemBytes}B${row.systemChanged ? ",CHANGED" : ""}) msg0=${row.msg0Sha} msg1=${row.msg1Sha} kept=${row.retainedPrefix}/${row.previousCount} msgs=${row.messageCount} bytes=${row.requestBytes} rewrite=${row.rewrite} mc=${decision ? `${decision.decision} ${decision.detail}` : "?"}`;
            });
            const report = [
                `host=${referenceHost.ok ? referenceHost.label : "?"} mode=${RUST ? "rust" : "ts"} pending_at_agents_edit=${pendingAtAgentsEdit} pending_at_instructions_edit=${pendingAtInstructionsEdit} pending_at_end=${pendingDropCount(h, sessionId)}`,
                ...lines,
                "-- system hash log --",
                ...hashLog,
            ].join("\n");
            console.log(report);
            const evidenceDir = process.env.SYSTEM_ORDER_EVIDENCE;
            if (evidenceDir) {
                mkdirSync(evidenceDir, { recursive: true });
                writeFileSync(join(evidenceDir, `${RUST ? "rust" : "ts"}-${Date.now()}.txt`), report);
                writeFileSync(
                    join(evidenceDir, `${RUST ? "rust" : "ts"}-${Date.now()}-requests.json`),
                    JSON.stringify(main.map((request) => request.body), null, 1),
                );
            }

            expect(pendingAtAgentsEdit).toBeGreaterThan(0);
            expect(pendingAtInstructionsEdit).toBeGreaterThan(0);
            // Each edit must actually reach the provider system block.
            const agentsIndex = rows.findIndex((row) => row.label.startsWith("agents-edit"));
            const instructionsIndex = rows.findIndex((row) => row.label.startsWith("instructions-edit"));
            expect(JSON.stringify(main[agentsIndex]!.body.system)).toContain("Project rule v2");
            expect(JSON.stringify(main[instructionsIndex]!.body.system)).toContain(
                "Extra instruction v2",
            );
            expect(rows[agentsIndex]!.systemChanged).toBe(true);
            expect(rows[instructionsIndex]!.systemChanged).toBe(true);

            // Exactly one prefix rewrite per edit: the request that first carries
            // the new system text. Every following request must extend it.
            const rewrites = rows
                .map((row, index) => (row.rewrite ? `${index}:${row.label}` : null))
                .filter((entry): entry is string => entry !== null);
            expect(rewrites).toEqual([
                `${agentsIndex}:${rows[agentsIndex]!.label}`,
                `${instructionsIndex}:${rows[instructionsIndex]!.label}`,
            ]);
        },
        600_000,
    );
});

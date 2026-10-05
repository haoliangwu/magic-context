import { realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { getProtectionWindowForSession } from "../src/features/magic-context/protection-window";
import { getPendingOps } from "../src/features/magic-context/storage-ops";
import {
    getChannel1NudgeState,
    getChannel2NudgeState,
    getLastNudgeUndropped,
} from "../src/features/magic-context/storage-meta-persisted";
import type { TagEntry } from "../src/features/magic-context/types";
import {
    CHANNEL1_FLOOR_TOKENS,
    CHANNEL1_MIN_TOKENS,
    CHANNEL1_STICKY_REAL_USER_TURN_GAP,
    CHANNEL2_FLOOR_TOKENS,
    CHANNEL2_SEVERITY_THRESHOLD,
    decideChannel1,
    evaluateChannel2,
    formatChannel1Evaluation,
    formatChannel2Evaluation,
} from "../src/hooks/magic-context/ctx-reduce-nudge";
import { resolveCtxReduceAvailabilityFromMessages } from "../src/hooks/magic-context/ctx-reduce-availability";
import type { MessageLike } from "../src/hooks/magic-context/tag-messages";
import {
    countRealUserMessages,
    measureTailHygiene,
} from "../src/hooks/magic-context/tail-hygiene-walk";
import { Database } from "../src/shared/sqlite";
import { applyTransforms } from "./context-dump/apply-transforms";
import { stripMetadata } from "./context-dump/strip-metadata";
import type { ContextTagRow, DumpMessage } from "./context-dump/types";

const CALIBRATION_SESSIONS = [
    {
        label: "primary-872k",
        sessionId: "ses_331acff95fferWZOYF1pG0cjOn",
    },
    {
        label: "sol-mason",
        sessionId: "ses_ff4877c64ffeuz39TRkYrWS2eg",
    },
    {
        label: "fresh-session",
        sessionId: "ses_ff48ad7efffeL51ppGolXXefEd",
    },
] as const;
const PROTECTED_TOKEN_FLOOR = 16_000;
const WALK_SAMPLES = 31;

type MessageRow = { id: string; data: string };
type PartRow = { message_id: string; data: string };
type RawContextTag = {
    message_id: string;
    type: string;
    status: string;
    tag_number: number;
};

type PersistedNudgeRow = {
    last_nudge_tokens: number;
    last_input_tokens: number;
};

type CalibrationResult = {
    label: string;
    sessionId: string;
    coverageEndOrdinal: number;
    renderedTailMessages: number;
    activeTags: number;
    droppedTags: number;
    u: number;
    t: number;
    severity: number;
    band: string;
    walkP95Ms: number;
    measuredPartTokens: Record<string, { t: number; u: number; count: number }>;
    persisted: {
        lastNudgeTokensWholePromptAtReduce: number;
        lastInputTokensWholePrompt: number;
        lastNudgeUndropped: number;
        channel1State: ReturnType<typeof getChannel1NudgeState>;
        channel2LeaseState: ReturnType<typeof getChannel2NudgeState>;
    };
    gates: Record<string, unknown>;
    channel1Log: string;
    channel2Log: string;
};

function guardedPath(rawPath: string, testDataRoot: string): string {
    const candidate = realpathSync(resolve(rawPath));
    const rel = relative(testDataRoot, candidate);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
        return candidate;
    }
    throw new Error(`${candidate} is outside MAGIC_CONTEXT_TEST_DATA_DIR=${testDataRoot}`);
}

function guardedOutputPath(rawPath: string, testDataRoot: string): string {
    const candidate = resolve(rawPath);
    const canonicalParent = realpathSync(dirname(candidate));
    const rel = relative(testDataRoot, canonicalParent);
    if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
        return resolve(canonicalParent, basename(candidate));
    }
    throw new Error(`output ${candidate} is outside MAGIC_CONTEXT_TEST_DATA_DIR=${testDataRoot}`);
}

function parseJson(value: string, label: string): Record<string, unknown> {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`${label} is not a JSON object`);
    }
    return parsed as Record<string, unknown>;
}

function readTailMessages(
    opencodeDb: Database,
    sessionId: string,
    coverageEndOrdinal: number,
): DumpMessage[] {
    const messageRows = opencodeDb
        .prepare(
            `SELECT id, data
             FROM message
             WHERE session_id = ?
             ORDER BY time_created ASC, id ASC
             LIMIT -1 OFFSET ?`,
        )
        .all(sessionId, coverageEndOrdinal) as MessageRow[];
    if (messageRows.length === 0) throw new Error(`no live-tail messages for ${sessionId}`);

    const partRows = opencodeDb
        .prepare(
            `WITH tail AS (
                 SELECT id
                 FROM message
                 WHERE session_id = ?
                 ORDER BY time_created ASC, id ASC
                 LIMIT -1 OFFSET ?
             )
             SELECT part.message_id, part.data
             FROM part
             JOIN tail ON tail.id = part.message_id
             WHERE part.session_id = ?
             ORDER BY part.time_created ASC, part.id ASC`,
        )
        .all(sessionId, coverageEndOrdinal, sessionId) as PartRow[];
    const partsByMessage = new Map<string, unknown[]>();
    for (const row of partRows) {
        const parts = partsByMessage.get(row.message_id) ?? [];
        parts.push(JSON.parse(row.data));
        partsByMessage.set(row.message_id, parts);
    }
    return stripMetadata(
        messageRows.map((row) => ({
            info: {
                ...parseJson(row.data, `message:${row.id}`),
                id: row.id,
                sessionID: sessionId,
            },
            parts: partsByMessage.get(row.id) ?? [],
        })),
    );
}

function readTransformTags(contextDb: Database, sessionId: string): ContextTagRow[] {
    const rows = contextDb
        .prepare(
            `SELECT message_id, type, status, tag_number
             FROM tags WHERE session_id = ?
             ORDER BY tag_number ASC, id ASC`,
        )
        .all(sessionId) as RawContextTag[];
    return rows.map((row) => {
        if (row.type !== "message" && row.type !== "tool" && row.type !== "file") {
            throw new Error(`unsupported tag type ${row.type}`);
        }
        if (row.status !== "active" && row.status !== "dropped" && row.status !== "compacted") {
            throw new Error(`unsupported tag status ${row.status}`);
        }
        return {
            messageId: row.message_id,
            type: row.type,
            status: row.status,
            tagNumber: row.tag_number,
        };
    });
}

function readHygieneTags(contextDb: Database, sessionId: string): TagEntry[] {
    const rows = contextDb
        .prepare(
            `SELECT session_id, message_id, type, status, byte_size, tag_number,
                    reasoning_byte_size, drop_mode, tool_name, input_byte_size,
                    caveman_depth, tool_owner_message_id, token_count,
                    input_token_count, reasoning_token_count
             FROM tags
             WHERE session_id = ? AND (
                 status = 'active' OR (type = 'tool' AND tool_owner_message_id IS NULL)
             )
             ORDER BY tag_number ASC, id ASC`,
        )
        .all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
        sessionId: String(row.session_id),
        messageId: String(row.message_id),
        type: row.type as TagEntry["type"],
        status: row.status as TagEntry["status"],
        byteSize: Number(row.byte_size ?? 0),
        tagNumber: Number(row.tag_number),
        reasoningByteSize: Number(row.reasoning_byte_size ?? 0),
        dropMode:
            row.drop_mode === "truncated" ||
            row.drop_mode === "skeleton_real" ||
            row.drop_mode === "edit_marker"
                ? row.drop_mode
                : "full",
        toolName: row.tool_name === null ? null : String(row.tool_name),
        inputByteSize: Number(row.input_byte_size ?? 0),
        cavemanDepth: Number(row.caveman_depth ?? 0),
        toolOwnerMessageId:
            row.tool_owner_message_id === null ? null : String(row.tool_owner_message_id),
    }));
}

function band(u: number, t: number): string {
    const baseline = {
        baselineU: u,
        baselineT: t,
        turnDeltaU: 0,
        turnDeltaT: 0,
        evaluable: true,
        generationInvalidated: false,
    };
    if (evaluateChannel2(baseline).shouldTrigger) return "channel2";
    const channel1 = decideChannel1({
        ...baseline,
        lastNudgeUndropped: 0,
        lastNudgeLevel: "",
        hasRecentReduce: false,
    });
    return channel1.fire ? channel1.level : "quiet";
}

function percentile95(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
}

function measureWalkCostGate(): {
    fixtureT: number;
    p95Ms: number;
    limitMs: number;
    passed: boolean;
} {
    const messages = [
        {
            info: { id: "conversation", role: "user" },
            parts: [{ type: "text", text: "prose ".repeat(87_000) }],
        },
        {
            info: { id: "tool-owner", role: "assistant" },
            parts: [
                {
                    type: "tool-invocation",
                    callID: "call-live",
                    tool: "read",
                    args: { path: "fixture" },
                },
            ],
        },
        {
            info: { id: "tool-result", role: "user" },
            parts: [
                {
                    type: "tool_result",
                    tool_use_id: "call-live",
                    content: "result ".repeat(162_000),
                },
            ],
        },
    ] as MessageLike[];
    const tags: TagEntry[] = [
        {
            tagNumber: 1,
            messageId: "call-live",
            type: "tool",
            status: "active",
            dropMode: "full",
            toolName: "read",
            inputByteSize: 0,
            byteSize: 1,
            reasoningByteSize: 0,
            sessionId: "walk-cost-gate",
            cavemanDepth: 0,
            toolOwnerMessageId: "tool-owner",
        },
    ];
    const input = { messages, tags, protectedTagNumbers: new Set<number>() };
    const measured = measureTailHygiene(input);
    const durations: number[] = [];
    for (let sample = 0; sample < WALK_SAMPLES; sample += 1) {
        const started = performance.now();
        measureTailHygiene(input);
        durations.push(performance.now() - started);
    }
    const p95Ms = percentile95(durations);
    return { fixtureT: measured.t, p95Ms, limitMs: 15, passed: p95Ms < 15 };
}

function replaySession(
    contextDb: Database,
    opencodeDb: Database,
    label: string,
    sessionId: string,
    protectionFloor: number | null,
): CalibrationResult {
    const coverageRow = contextDb
        .prepare(
            `SELECT COALESCE(MAX(end_message), 0) AS coverage_end
             FROM compartments WHERE session_id = ?`,
        )
        .get(sessionId) as { coverage_end?: number } | undefined;
    const coverageEndOrdinal = Math.max(0, Number(coverageRow?.coverage_end ?? 0));
    const messages = readTailMessages(opencodeDb, sessionId, coverageEndOrdinal);
    const transformTags = readTransformTags(contextDb, sessionId);
    applyTransforms(messages, transformTags);
    const hygieneTags = readHygieneTags(contextDb, sessionId);
    const pendingDropTagNumbers = new Set(
        getPendingOps(contextDb, sessionId)
            .filter((operation) => operation.operation === "drop")
            .map((operation) => operation.tagId),
    );
    const protectionWindow = getProtectionWindowForSession(
        contextDb,
        sessionId,
        protectionFloor,
    );
    const input = {
        messages: messages as unknown as MessageLike[],
        tags: hygieneTags,
        protectedTagNumbers: protectionWindow.protectedTagNumbers,
        pendingDropTagNumbers,
    };
    const measured = measureTailHygiene(input);
    const durations: number[] = [];
    for (let sample = 0; sample < WALK_SAMPLES; sample += 1) {
        const started = performance.now();
        measureTailHygiene(input);
        durations.push(performance.now() - started);
    }

    const nudgeRow = contextDb
        .prepare(
            `SELECT last_nudge_tokens, last_input_tokens
             FROM session_meta WHERE session_id = ?`,
        )
        .get(sessionId) as PersistedNudgeRow | undefined;
    if (!nudgeRow) throw new Error(`no session_meta row for ${sessionId}`);
    const channel1State = getChannel1NudgeState(contextDb, sessionId);
    const channel2LeaseState = getChannel2NudgeState(contextDb, sessionId);
    const lastNudgeUndropped = getLastNudgeUndropped(contextDb, sessionId);
    const currentRealUserTurnCount = countRealUserMessages(input.messages);
    const ctxReduceAvailability = resolveCtxReduceAvailabilityFromMessages(
        sessionId,
        input.messages,
    );
    const baseline = {
        baselineU: measured.u,
        baselineT: measured.t,
        turnDeltaU: 0,
        turnDeltaT: 0,
        evaluable: true,
        generationInvalidated: false,
    };
    const channel1 = decideChannel1({
        ...baseline,
        lastNudgeUndropped,
        lastNudgeLevel: channel1State.level,
        lastFireOrdinal: channel1State.ordinal,
        currentRealUserTurnCount,
        hasRecentReduce: false,
        postReduceGracePending: channel1State.postReduceGracePending,
        postReduceGraceBaselineU: channel1State.postReduceGraceBaselineU,
        postReduceGracePreLevel: channel1State.postReduceGracePreLevel,
    });
    const channel2 = evaluateChannel2(baseline);
    const stickyElapsed =
        channel1State.ordinal > currentRealUserTurnCount
            ? CHANNEL1_STICKY_REAL_USER_TURN_GAP
            : currentRealUserTurnCount - channel1State.ordinal;
    const currentRank = { quiet: 0, gentle: 1, firm: 2, urgent: 3 }[channel1.band];
    const preReduceLevel = channel1State.postReduceGracePreLevel ?? channel1State.level;
    const preReduceRank = preReduceLevel === "" ? 0 : { gentle: 1, firm: 2, urgent: 3 }[preReduceLevel];
    const measuredPartTokens: Record<string, { t: number; u: number; count: number }> = {};
    for (const part of measured.parts) {
        const aggregate = measuredPartTokens[part.kind] ?? { t: 0, u: 0, count: 0 };
        aggregate.t += part.tokens;
        aggregate.u += part.uTokens;
        aggregate.count += 1;
        measuredPartTokens[part.kind] = aggregate;
    }

    return {
        label,
        sessionId,
        coverageEndOrdinal,
        renderedTailMessages: messages.length,
        activeTags: transformTags.filter((tag) => tag.status === "active").length,
        droppedTags: transformTags.filter((tag) => tag.status === "dropped").length,
        u: measured.u,
        t: measured.t,
        severity: measured.u / Math.max(measured.t, 1),
        band: band(measured.u, measured.t),
        walkP95Ms: percentile95(durations),
        measuredPartTokens,
        persisted: {
            lastNudgeTokensWholePromptAtReduce: nudgeRow.last_nudge_tokens,
            lastInputTokensWholePrompt: nudgeRow.last_input_tokens,
            lastNudgeUndropped,
            channel1State,
            channel2LeaseState,
        },
        gates: {
            ctxReduceAvailability: {
                pass: ctxReduceAvailability.callable,
                frozen: ctxReduceAvailability.frozen,
                reason: ctxReduceAvailability.callable ? "callable" : "filtered-out",
            },
            baseline: { pass: true, evaluable: true, generationInvalidated: false },
            protectionWindow: {
                floor: protectionWindow.status.floor,
                protectedCount: protectionWindow.status.protectedCount,
                protectedMass: protectionWindow.status.protectedMass,
                cutoff: protectionWindow.cutoff,
            },
            channel1MinimumTail: {
                actual: measured.t,
                threshold: CHANNEL1_MIN_TOKENS,
                pass: measured.t >= CHANNEL1_MIN_TOKENS,
            },
            channel1ReclaimableFloor: {
                actual: measured.u,
                threshold: CHANNEL1_FLOOR_TOKENS,
                pass: measured.u >= CHANNEL1_FLOOR_TOKENS,
            },
            postReduceComplianceGrace: {
                baselineU: channel1.graceBaselineU,
                growth: channel1.graceGrowth,
                growthThreshold: channel1.growthThreshold,
                formula: "max(25000, round(0.08 * T))",
                regrowthReached: channel1.graceGrowth >= channel1.growthThreshold,
                preReduceLevel,
                escalatedAbovePreReduceBand: currentRank > preReduceRank,
                holds: channel1.verdictReason === "post-reduce-compliance-grace",
            },
            cadence: {
                lastNudgeUndropped,
                growth: channel1.cadenceGrowth,
                growthThreshold: channel1.growthThreshold,
                pass: channel1.cadenceGrowth >= channel1.growthThreshold,
            },
            stickyFloor: {
                lastFireOrdinal: channel1State.ordinal,
                currentRealUserTurnCount,
                elapsed: stickyElapsed,
                threshold: CHANNEL1_STICKY_REAL_USER_TURN_GAP,
                turnsRemaining: channel1.stickyTurnsRemaining,
                pass: channel1.stickyTurnsRemaining === 0,
            },
            bandHysteresis: {
                previousLevel: channel1State.level,
                currentBand: channel1.band,
                holds: channel1.dampeningState === "band-hysteresis",
            },
            channel1Verdict: {
                fire: ctxReduceAvailability.callable && channel1.fire,
                dampening: channel1.dampeningState,
                reason: ctxReduceAvailability.callable
                    ? channel1.verdictReason
                    : "ctx-reduce-unavailable",
            },
            channel2MinimumTail: {
                actual: measured.t,
                threshold: CHANNEL1_MIN_TOKENS,
                pass: measured.t >= CHANNEL1_MIN_TOKENS,
            },
            channel2ReclaimableFloor: {
                actual: measured.u,
                threshold: CHANNEL2_FLOOR_TOKENS,
                pass: measured.u >= CHANNEL2_FLOOR_TOKENS,
            },
            channel2RatioCeiling: {
                actual: channel2.severity,
                threshold: CHANNEL2_SEVERITY_THRESHOLD,
                pass: channel2.severity >= CHANNEL2_SEVERITY_THRESHOLD,
            },
            channel2Lease: {
                state: channel2LeaseState || "empty",
                permitsArm: channel2LeaseState === "",
            },
            channel2Verdict: {
                trigger: ctxReduceAvailability.callable && channel2.shouldTrigger,
                reason: ctxReduceAvailability.callable
                    ? channel2.verdictReason
                    : "ctx-reduce-unavailable",
            },
        },
        channel1Log: formatChannel1Evaluation(channel1, ctxReduceAvailability.callable),
        channel2Log: formatChannel2Evaluation(channel2, {
            ctxReduceCallable: ctxReduceAvailability.callable,
            leaseBefore: channel2LeaseState,
        }),
    };
}

const { values } = parseArgs({
    options: {
        "context-db": { type: "string" },
        "opencode-db": { type: "string" },
        output: { type: "string" },
        session: { type: "string" },
    },
});
const testDataRootRaw = process.env.MAGIC_CONTEXT_TEST_DATA_DIR;
if (!testDataRootRaw) {
    throw new Error("MAGIC_CONTEXT_TEST_DATA_DIR is required for live-snapshot calibration");
}
const testDataRoot = realpathSync(resolve(testDataRootRaw));
const contextDbPath = guardedPath(
    values["context-db"] ?? resolve(testDataRoot, "context-snapshot.db"),
    testDataRoot,
);
const opencodeDbPath = guardedPath(
    values["opencode-db"] ?? resolve(testDataRoot, "opencode-snapshot.db"),
    testDataRoot,
);
const contextDb = new Database(contextDbPath, { readonly: true });
const opencodeDb = new Database(opencodeDbPath, { readonly: true });
contextDb.exec("PRAGMA query_only = ON");
opencodeDb.exec("PRAGMA query_only = ON");
try {
    const sessions = values.session
        ? [{ label: `requested-${values.session}`, sessionId: values.session, protectionFloor: null }]
        : CALIBRATION_SESSIONS.map((session) => ({
              ...session,
              protectionFloor: PROTECTED_TOKEN_FLOOR,
          }));
    const results = sessions.map(({ label, sessionId, protectionFloor }) =>
        replaySession(contextDb, opencodeDb, label, sessionId, protectionFloor),
    );
    const distribution = Object.fromEntries(
        ["quiet", "gentle", "firm", "urgent", "channel2"].map((name) => [
            name,
            results.filter((result) => result.band === name).length,
        ]),
    );
    const output = `${JSON.stringify(
        {
            formula: "clamp(U / max(T, 1), 0, 1)",
            constantsChanged: false,
            protectedTokenFloor: values.session ? "persisted-session-snapshot" : PROTECTED_TOKEN_FLOOR,
            snapshotMode: "readonly database replay",
            results,
            distribution,
            flagshipPositiveControl: {
                u: 162_000,
                t: 249_000,
                severity: 162_000 / 249_000,
                band: band(162_000, 249_000),
            },
            walkCostGate: measureWalkCostGate(),
        },
        null,
        2,
    )}\n`;
    if (values.output !== undefined) {
        writeFileSync(guardedOutputPath(values.output, testDataRoot), output, "utf8");
    }
    process.stdout.write(output);
} finally {
    contextDb.close();
    opencodeDb.close();
}

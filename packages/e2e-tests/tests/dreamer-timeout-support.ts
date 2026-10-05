/// <reference types="bun-types" />

/**
 * Shared fixtures for the OpenCode 1 dreamer timeout scenarios: isolation proof,
 * seeding file-mapped memories into the harness store, starting `/ctx-dream`,
 * and reading back the scheduler and ledger rows the scenarios assert on.
 */

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { join, resolve as pathResolve } from "node:path";
import { expect } from "bun:test";
import { CANONICAL_DREAM_TASKS } from "../../plugin/src/features/magic-context/dreamer/task-registry";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { insertMemory } from "../../plugin/src/features/magic-context/memory/storage-memory";
import { recordMemoryVerifications } from "../../plugin/src/features/magic-context/memory/storage-memory-verifications";
import type { TestHarness } from "../src/harness";
import { openTestDb } from "../src/test-db";

/** The verified_at every seeded mapping starts with; a banked verdict moves past it. */
export const SEEDED_VERIFIED_AT = 1_000;

export const VERIFY_SYSTEM_MARKER = "You are a memory verifier for the magic-context system.";
/** Heading of every verify batch's user prompt. */
export const VERIFY_BATCH_MARKER = "## Verify these memories against the code";

export const MOCK_USAGE = {
    input_tokens: 200,
    output_tokens: 40,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
};

/**
 * Dreamer config with exactly one task scheduled, so nothing else competes for
 * the lease or the mock. The model is pinned to the mock by the harness.
 */
export function dreamerConfig(
    task: "verify" | "verify-broad",
    timeoutMinutes: number,
): Record<string, unknown> {
    const tasks: Record<string, unknown> = {};
    for (const name of CANONICAL_DREAM_TASKS) {
        tasks[name] = { schedule: name === task ? "0 3 * * *" : "" };
    }
    return {
        disable: false,
        tasks,
        opencode: { tasks: { [task]: { timeout_minutes: timeoutMinutes } } },
    };
}

/**
 * Every `.db` the host process holds open must live under the harness's
 * throwaway data home, and none of the user's live stores may appear.
 */
export function assertIsolatedStores(h: TestHarness): void {
    const opened = spawnSync("lsof", ["-nP", "-p", String(h.opencode.pid)], { encoding: "utf8" });
    expect(opened.status).toBe(0);
    for (const forbidden of [
        "/.local/share/opencode/",
        "/.local/share/cortexkit/magic-context/",
        "/.config/opencode/",
        "/.config/cortexkit/",
    ]) {
        expect(opened.stdout).not.toContain(`${process.env.HOME}${forbidden}`);
    }
    const dbPaths = opened.stdout
        .split("\n")
        .flatMap((line) => line.match(/\S+\.db(?:-wal|-shm)?(?=\s|$)/g) ?? []);
    expect(dbPaths.length).toBeGreaterThan(0);
    const dataDir = realpathSync(h.opencode.env.dataDir);
    expect(dbPaths.filter((path) => !path.startsWith(`${dataDir}/`))).toEqual([]);
    console.log(`[isolation] host pid ${h.opencode.pid} db files: ${[...new Set(dbPaths)].join(", ")}`);
}

export function projectIdentity(h: TestHarness): string {
    return resolveProjectIdentity(realpathSync(pathResolve(h.workdir)));
}

function contextDbPath(h: TestHarness): string {
    return join(h.dataDir, "cortexkit", "magic-context", "context.db");
}

/** Insert `count` active memories, each mapped to a backing file, and return their ids. */
export function seedMappedMemories(h: TestHarness, identity: string, count: number): number[] {
    const db = openTestDb(contextDbPath(h));
    try {
        const ids: number[] = [];
        for (let index = 0; index < count; index += 1) {
            const memory = insertMemory(db as never, {
                projectPath: identity,
                category: "ARCHITECTURE",
                content: `Dreamer timeout scenario fact number ${index}.`,
                sourceSessionId: "ses-seed",
            });
            recordMemoryVerifications(db as never, memory.id, ["src/fact.ts"], SEEDED_VERIFIED_AT);
            ids.push(memory.id);
        }
        return ids;
    } finally {
        db.close();
    }
}

/** How many of `ids` a verify batch has banked (verified_at moved past the seed). */
export function countBanked(h: TestHarness, ids: readonly number[]): number {
    const db = openTestDb(contextDbPath(h), { readonly: true });
    try {
        const row = db
            .prepare(
                `SELECT COUNT(DISTINCT memory_id) AS n FROM memory_verifications
                  WHERE verified_at > ? AND memory_id IN (${ids.map(() => "?").join(",")})`,
            )
            .get(SEEDED_VERIFIED_AT, ...ids) as { n: number };
        return row.n;
    } finally {
        db.close();
    }
}

export interface TaskState {
    last_status: string | null;
    last_error: string | null;
    retry_count: number;
    next_due_at: number | null;
    last_run_at: number | null;
}

export function readTaskState(h: TestHarness, identity: string, task: string): TaskState | null {
    const db = openTestDb(contextDbPath(h), { readonly: true });
    try {
        return (
            (db
                .prepare(
                    "SELECT last_status, last_error, retry_count, next_due_at, last_run_at FROM task_schedule_state WHERE project_path = ? AND task = ?",
                )
                .get(identity, task) as TaskState | undefined) ?? null
        );
    } catch {
        return null;
    } finally {
        db.close();
    }
}

export interface InvocationRow {
    task: string | null;
    status: string;
    error: string | null;
    started_at: number;
    ended_at: number | null;
    provider_id: string | null;
    model_id: string | null;
    input_tokens: number;
    output_tokens: number;
}

export function readDreamerInvocations(h: TestHarness, parentSessionId: string): InvocationRow[] {
    const db = openTestDb(contextDbPath(h), { readonly: true });
    try {
        return db
            .prepare(
                `SELECT task, status, error, started_at, ended_at, provider_id, model_id, input_tokens, output_tokens
                   FROM subagent_invocations WHERE session_id = ? AND subagent = 'dreamer' ORDER BY id`,
            )
            .all(parentSessionId) as InvocationRow[];
    } finally {
        db.close();
    }
}

/**
 * Start `/ctx-dream <task>` through the command API without waiting for it. The
 * host answers this request only when the dream ends, so the test polls the
 * store instead. `timeout: false` keeps the test process's own fetch timer out
 * of a scenario that is about timers.
 */
export function startDream(h: TestHarness, sessionId: string, task: string): Promise<unknown> {
    return fetch(`${h.serverUrl}/session/${sessionId}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            messageID: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
            command: "ctx-dream",
            arguments: task,
            agent: "build",
            model: "mock-anthropic/mock-sonnet",
            parts: [],
        }),
        timeout: false,
    } as RequestInit).catch((error: unknown) => error);
}

/** Session ids the host currently reports as running a loop. */
export async function busySessions(h: TestHarness): Promise<string[]> {
    const status = (await fetch(`${h.serverUrl}/session/status`, { timeout: false } as RequestInit).then(
        (response) => response.json(),
    )) as Record<string, { type?: string }>;
    return Object.entries(status)
        .filter(([, value]) => value?.type === "busy" || value?.type === "retry")
        .map(([id]) => id);
}

/** All user-visible text in an Anthropic-shaped request body. */
export function requestText(body: Record<string, unknown>): string {
    const parts: string[] = [];
    const visit = (value: unknown): void => {
        if (typeof value === "string") parts.push(value);
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === "object") {
            const record = value as Record<string, unknown>;
            if (typeof record.text === "string") parts.push(record.text);
            if (record.content !== undefined) visit(record.content);
        }
    };
    visit(body.system);
    visit(body.messages);
    return parts.join("\n");
}

/** Memory ids a verify prompt asks about, in prompt order. */
export function verifyPromptIds(body: Record<string, unknown>): number[] {
    const messagesOnly = requestText({ messages: body.messages });
    return [...messagesOnly.matchAll(/^\[(\d+)\] [A-Z_]+$/gm)].map((match) => Number(match[1]));
}

/**
 * How many user messages in a provider request contain `marker`. The host re-sends
 * the same conversation when its own provider-request timer (300 s by default)
 * retries a step, so that count stays 1; a second prompt sent into the same child
 * (a fallback attempt) adds another user message and raises it.
 */
export function userMessagesContaining(body: Record<string, unknown>, marker: string): number {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    return messages.filter((message) => {
        const record = message as { role?: unknown };
        return record.role === "user" && requestText({ messages: [message] }).includes(marker);
    }).length;
}

export function isVerifyRequest(body: Record<string, unknown>): boolean {
    return requestText(body).includes(VERIFY_SYSTEM_MARKER);
}

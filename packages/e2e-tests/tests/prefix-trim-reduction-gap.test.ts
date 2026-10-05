/// <reference types="bun-types" />

/**
 * The "boundary sorts before the first live message" prefix-trim log on a real
 * OpenCode 1 host.
 *
 * Shape reproduced from production: the latest compartment ends on an
 * assistant step B in the middle of a turn, and the assistant steps after B
 * carry nothing but tool calls that were fully dropped earlier. OpenCode loads
 * all of them (its window starts at the compaction marker, before B). On the
 * first pass after a restart, compartment injection cuts the window through B,
 * then drop replay empties the tool-only steps after B and removes them, so the
 * first message left is the first step that still has content. The prefix trim
 * then finds B absent. It used to log "boundary B sorts before the first live
 * message F ... whole window kept", which read as if OpenCode's window started
 * after B and the steps between were lost. They were served to Magic Context
 * and removed on purpose, and the line now says they were cut or removed this
 * pass.
 *
 * The test builds that state directly: one turn with a small tool step (B), a
 * large tool step (the gap) and a text step (F); a compartment ending at B; the
 * gap step's tool tag recorded as fully dropped; the cached m[0] cleared so the
 * next pass materializes a baseline at B; then a restart. It asserts that the
 * gap step is in OpenCode's store and absent from the provider request, and
 * that the log line says the rows between were cut or removed this pass.
 */

import { afterAll, beforeAll, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clearCachedM0M1 } from "../../plugin/src/features/magic-context/storage-meta-shared";
import { TestHarness } from "../src/harness";
import type { MockResponse } from "../src/mock-provider/server";
import { findToolUse, type WireMessage } from "../src/anthropic-request-validator";
import { openTestDb } from "../src/test-db";

const LOW = {
    input_tokens: 1_000,
    output_tokens: 10,
    cache_creation_input_tokens: 0,
};

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        modelContextLimit: 20_000,
        magicContextConfig: {
            execute_threshold_percentage: 80,
            historian: { disable: true },
        },
    });
});

afterAll(async () => {
    await h?.dispose();
});

function pluginLogPath(): string {
    return join(h.dataDir, "cortexkit", "magic-context-e2e.log");
}

function openCodeRows(sessionId: string): Array<{ id: string; role: string }> {
    const db = openTestDb(join(h.dataDir, "opencode", "opencode.db"), { readonly: true });
    try {
        return db
            .prepare(
                `SELECT id, json_extract(data, '$.role') AS role
                   FROM message
                  WHERE session_id = ?
                  ORDER BY time_created, id`,
            )
            .all(sessionId) as Array<{ id: string; role: string }>;
    } finally {
        db.close();
    }
}

function partTypes(sessionId: string, messageId: string): string[] {
    const db = openTestDb(join(h.dataDir, "opencode", "opencode.db"), { readonly: true });
    try {
        return (
            db
                .prepare(
                    "SELECT json_extract(data, '$.type') AS type FROM part WHERE session_id = ? AND message_id = ? ORDER BY id",
                )
                .all(sessionId, messageId) as Array<{ type: string }>
        ).map((row) => row.type);
    } finally {
        db.close();
    }
}

it("reports tool-only steps after the boundary as cut or removed this pass, not as missing from the host window", async () => {
    const toolNamed = (body: Record<string, unknown>, name: string) =>
        (Array.isArray(body.tools) ? body.tools : [])
            .map((tool) => (tool as { name?: unknown }).name)
            .find((candidate): candidate is string =>
                typeof candidate === "string" && new RegExp(`(^|_)${name}$`).test(candidate),
            );

    h.mock.reset();
    let step = 0;
    h.mock.addMatcher((body): MockResponse | null => {
        if (step >= 2) return null;
        const bash = toolNamed(body, "bash");
        if (!bash) return null;
        step += 1;
        const input =
            step === 1
                ? { command: "echo boundary", description: "boundary step" }
                : {
                      command: `echo ${"G".repeat(3000)} > /dev/null`,
                      description: "gap step",
                  };
        return {
            content: [
                {
                    type: "tool_use",
                    id: step === 1 ? "toolu_boundary_bash" : "toolu_gap_bash",
                    name: bash,
                    input,
                },
            ],
            stop_reason: "tool_use",
            usage: LOW,
        };
    });
    h.mock.setDefault({ text: "first live step", usage: LOW });

    const sessionId = await h.createSession();
    await h.sendPrompt(sessionId, "run the boundary command, then the long one", {
        timeoutMs: 120_000,
    });
    await h.waitForMockQuiescence({ label: "turn one settles" });

    const rows = openCodeRows(sessionId);
    // user, boundary step, gap step, first live step
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "assistant", "assistant"]);
    const [user, boundary, gap, firstLive] = rows;
    expect(partTypes(sessionId, gap.id).filter((type) => type !== "step-start" && type !== "step-finish")).toEqual([
        "tool",
    ]);

    const writable = openTestDb(h.contextDbPath());
    try {
        // A compartment that ends on the boundary step, in the middle of the turn.
        // The historian ends a compartment mid-turn when the newest messages it may
        // summarize stop there.
        writable
            .prepare(
                `INSERT INTO compartments
                    (session_id, sequence, start_message, end_message, start_message_id, end_message_id,
                     title, content, p1, created_at, harness)
                 VALUES (?, 0, 1, 2, ?, ?, ?, ?, ?, ?, 'opencode')`,
            )
            .run(
                sessionId,
                user.id,
                boundary.id,
                "Boundary work",
                "The user asked for two commands; the first ran.",
                "The user asked for two commands; the first ran.",
                Date.now(),
            );
        // The gap step's tool call was dropped on an earlier pass and removed
        // with its result (the large-input "full" mode).
        const gapTags = writable
            .prepare(
                "SELECT tag_number AS tag, status FROM tags WHERE session_id = ? AND harness = 'opencode' AND type = 'tool' AND message_id = 'toolu_gap_bash' ORDER BY tag_number",
            )
            .all(sessionId) as Array<{ tag: number; status: string }>;
        expect(gapTags.length).toBeGreaterThan(0);
        writable
            .prepare(
                "UPDATE tags SET status = 'dropped', drop_mode = 'full' WHERE session_id = ? AND harness = 'opencode' AND tag_number = ?",
            )
            .run(sessionId, gapTags[0].tag);
        // The next pass must materialize m[0] with its baseline at the boundary.
        clearCachedM0M1(writable as never, sessionId);
    } finally {
        writable.close();
    }

    const configPath = join(h.opencode.env.configDir, "opencode.json");
    const databasePath = join(h.dataDir, "opencode", "opencode.db");
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(databasePath)).toBe(true);
    const logOffset = existsSync(pluginLogPath()) ? readFileSync(pluginLogPath()).length : 0;
    await h.restart();
    expect(existsSync(configPath)).toBe(true);
    expect(existsSync(databasePath)).toBe(true);
    h.mock.setDefault({ text: "after restart", usage: LOW });
    await h.sendPrompt(sessionId, "anything else?", { timeoutMs: 120_000 });
    await h.waitForMockQuiescence({ label: "post-restart turn settles" });

    // The first pass after a restart materializes m[0] and can outlast the mock's
    // quiet window, so wait for the pass to finish in the plugin log.
    const readLog = () => readFileSync(pluginLogPath()).subarray(logOffset).toString("utf8");
    const deadline = Date.now() + 60_000;
    while (
        !readLog()
            .split("\n")
            .some((entry) => entry.includes(sessionId) && entry.includes("transform completed")) &&
        Date.now() < deadline
    ) {
        await Bun.sleep(250);
    }
    const log = readLog();
    const trimLines = log
        .split("\n")
        .filter((line) => line.includes(sessionId) && line.includes("prefix trim:"));

    // The gap step is in OpenCode's store and was loaded into the window, but
    // the provider never sees its tool call: that is the intended reduction.
    const request = h
        .requests()
        .find((candidate) => JSON.stringify(candidate.body.messages ?? []).includes("anything else?"));
    expect(request).toBeDefined();
    const wire = (request!.body.messages ?? []) as WireMessage[];
    expect(findToolUse(wire, "toolu_gap_bash")).toBeUndefined();
    expect(JSON.stringify(wire)).toContain("first live step");

    expect(trimLines).toHaveLength(1);
    const line = trimLines[0];
    expect(line).toContain(
        `prefix trim: boundary ${boundary.id} precedes the first remaining message ${firstLive.id}; rows between were cut with the summarized history or removed by reduction this pass;`,
    );
    expect(line).not.toContain("sorts before the first live message");

    const evidenceDir = process.env.MC_PREFIX_TRIM_GAP_EVIDENCE;
    if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        writeFileSync(
            join(evidenceDir, "prefix-trim-log.txt"),
            `${trimLines.join("\n")}\n`,
        );
        const lsof = execFileSync("lsof", ["-p", String(h.opencode.pid)], { encoding: "utf8" });
        writeFileSync(
            join(evidenceDir, "opencode1-lsof-db.txt"),
            lsof
                .split("\n")
                .filter((entry) => /\.db(-wal|-shm)?$/.test(entry))
                .join("\n"),
        );
    }
}, 360_000);

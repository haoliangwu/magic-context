import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOpenCodeV1FixtureStore } from "../../../hooks/magic-context/opencode-v1-store-fixture";
import { Database } from "../../../shared/sqlite";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { advanceSessionActivity } from "../session-activity";
import {
    assertRetrospectiveHeap,
    measureRetrospective,
} from "./__tests__/retrospective-heap-fixture.test";
import {
    OpenCodeRetrospectiveRawProvider,
    readRetrospectiveScanWindow,
} from "./retrospective-raw-provider";

const dirs: string[] = [];
const original = process.env.OPENCODE_DB;
afterEach(() => {
    if (original === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = original;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(turns: number, huge = false) {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-retro-heap-"));
    dirs.push(dir);
    const path = join(dir, "opencode.db");
    process.env.OPENCODE_DB = path;
    writeOpenCodeV1FixtureStore(path, [
        {
            sessionId: "ses_retro",
            directory: "/fixture/retro",
            turns,
            toolOutputChars: 16_384,
            diagnosticsPerTool: 40,
        },
    ]);
    const db = new Database(path);
    const start = Date.now() - 10_000_000;
    db.prepare("UPDATE message SET time_created = time_created + ?").run(start);
    if (huge)
        db.exec(
            `UPDATE part SET data = json_set(data, '$.state.output', replace(hex(zeroblob(40 * 1024 * 1024)), '0', 'x')) WHERE id = (SELECT id FROM part WHERE json_extract(data, '$.type') = 'tool' ORDER BY time_created LIMIT 1)`,
        );
    const contextDb = new Database(":memory:");
    contextDb.exec(
        "CREATE TABLE session_projects(session_id TEXT, harness TEXT, project_path TEXT, updated_at INTEGER); CREATE TABLE session_meta(session_id TEXT, is_subagent INTEGER); CREATE TABLE schema_migrations_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    contextDb
        .prepare(
            "INSERT INTO session_projects VALUES ('ses_retro', 'opencode', 'git:retro-heap', ?)",
        )
        .run(Date.now());
    advanceSessionActivity(contextDb, "ses_retro", start + turns * 1000);
    const provider = new OpenCodeRetrospectiveRawProvider({ contextDb, opencodeDb: db });
    return { db, contextDb, provider };
}

test("OpenCode retrospective peak heap excludes huge selected tool output", async () => {
    const measurements = [];
    for (const turns of [500, 5_000]) {
        const { db, contextDb, provider } = fixture(turns, turns === 5_000);
        try {
            measurements.push(await measureRetrospective(provider));
        } finally {
            db.close();
            contextDb.close();
        }
    }
    assertRetrospectiveHeap(measurements[0], measurements[1]);
}, 60_000);

test("OpenCode retrospective input is byte-identical to full-data privacy filtering", async () => {
    const { db, contextDb, provider } = fixture(16);
    const states = [
        { output: "no errors or failure", error: "\uFEFF\t" },
        { output: "ERROR!" },
        { output: "xerror error_y" },
        { output: { nested: "\nerror", failed: false } },
        { output: ["exception", "traceback"] },
        { error: false },
        { error: {} },
        { output: "ok", isError: true },
        { status: "ERROR" },
        { output: "éerroré" },
        { output: "ok\u0000ERROR" },
        { error: "\u0000" },
        { output: { nested: "\nerror" } },
        { output: "failed\u0000ok" },
    ];
    const tools = db
        .prepare<[], { id: string }>(
            "SELECT id FROM part WHERE json_extract(data, '$.type') = 'tool' ORDER BY id",
        )
        .all();
    states.forEach((state, i) => {
        db.prepare("UPDATE part SET data = ? WHERE id = ?").run(
            JSON.stringify({ type: "tool", tool: "read", state }),
            tools[i].id,
        );
    });
    const projected = JSON.stringify(
        await readRetrospectiveScanWindow(provider, "git:retro-heap", 0, 0),
    );
    const prepare = db.prepare.bind(db);
    // Run the old full-data SELECT through the same normalization and prompt path.
    const legacy = spyOn(db, "prepare").mockImplementation(((sql: string) => {
        if (!sql.includes("FROM part")) return prepare(sql);
        const statement = prepare(
            sql.replace(
                /SELECT message_id,[\s\S]*?\n\s+FROM part/,
                "SELECT message_id, data FROM part",
            ),
        );
        const binds = sql.slice(sql.indexOf("FROM part")).split("?").length - 1;
        return { all: (...args: string[]) => statement.all(...args.slice(-binds)) };
    }) as typeof db.prepare);
    try {
        expect(projected).toBe(
            JSON.stringify(await readRetrospectiveScanWindow(provider, "git:retro-heap", 0, 0)),
        );
    } finally {
        legacy.mockRestore();
        db.close();
        contextDb.close();
    }
});

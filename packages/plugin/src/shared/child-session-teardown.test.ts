/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

import { sweepOrphanedRetrospectiveChildren } from "../features/magic-context/dreamer/retrospective-orphan-sweep";
import { teardownChildSession } from "./child-session-teardown";
import { _resetKeepSubagentsForTesting, setKeepSubagents } from "./keep-subagents";
import { Database } from "./sqlite";
import { closeQuietly } from "./sqlite-helpers";

interface TeardownFixture {
    client: {
        session: {
            delete: ReturnType<typeof mock>;
            update: ReturnType<typeof mock>;
        };
    };
    calls: string[];
    deleted: string[];
    archived: string[];
    messages: string[];
}

function teardownFixture(): TeardownFixture {
    const calls: string[] = [];
    const deleted: string[] = [];
    const archived: string[] = [];
    const messages: string[] = [];
    return {
        calls,
        deleted,
        archived,
        messages,
        client: {
            session: {
                update: mock(async ({ path }: { path: { id: string } }) => {
                    calls.push("archive");
                    archived.push(path.id);
                    return {};
                }),
                delete: mock(async ({ path }: { path: { id: string } }) => {
                    calls.push("delete");
                    deleted.push(path.id);
                    return {};
                }),
            },
        },
    };
}

afterEach(() => {
    _resetKeepSubagentsForTesting();
    mock.restore();
});

describe("teardownChildSession", () => {
    test("deletes an ordinary child only after its prompt settles", async () => {
        const fixture = teardownFixture();
        await teardownChildSession({
            client: fixture.client,
            sessionId: "settled-ordinary",
            sessionDirectory: "/repo",
            promptSettled: true,
            privacySensitive: false,
            context: "ordinary",
            log: (message) => fixture.messages.push(message),
        });

        expect(fixture.deleted).toEqual(["settled-ordinary"]);
        expect(fixture.archived).toEqual([]);
    });

    test("deletes a settled privacy child when keep_subagents is false", async () => {
        const fixture = teardownFixture();
        await teardownChildSession({
            client: fixture.client,
            sessionId: "settled-private",
            promptSettled: true,
            privacySensitive: true,
            context: "private",
            log: (message) => fixture.messages.push(message),
        });

        expect(fixture.deleted).toEqual(["settled-private"]);
        expect(fixture.archived).toEqual([]);
    });

    test("keeps both settled ordinary and privacy children under keep_subagents", async () => {
        setKeepSubagents(true);
        const ordinary = teardownFixture();
        await teardownChildSession({
            client: ordinary.client,
            sessionId: "kept-ordinary",
            promptSettled: true,
            privacySensitive: false,
            context: "ordinary",
            log: (message) => ordinary.messages.push(message),
        });
        expect(ordinary.deleted).toEqual([]);

        const privacy = teardownFixture();
        await teardownChildSession({
            client: privacy.client,
            sessionId: "kept-private",
            promptSettled: true,
            privacySensitive: true,
            context: "private",
            log: (message) => privacy.messages.push(message),
        });
        expect(privacy.deleted).toEqual([]);
    });

    test("leaves an unsettled privacy child to the sweep regardless of keep_subagents", async () => {
        for (const keepSubagents of [false, true]) {
            setKeepSubagents(keepSubagents);
            const fixture = teardownFixture();
            const sessionId = `unsettled-private-${keepSubagents}`;
            await teardownChildSession({
                client: fixture.client,
                sessionId,
                sessionDirectory: "/repo",
                promptSettled: false,
                privacySensitive: true,
                context: "private",
                log: (message) => fixture.messages.push(message),
            });

            expect(fixture.deleted).toEqual([]);
            expect(fixture.archived).toEqual([sessionId]);
        }
    });

    test("archives an unsettled child before logging, leaves it intact, then the age gate reaps it", async () => {
        const fixture = teardownFixture();
        const db = new Database(":memory:");
        db.exec(`
            CREATE TABLE session (
                id TEXT PRIMARY KEY,
                title TEXT,
                directory TEXT,
                time_created INTEGER
            );
            INSERT INTO session VALUES (
                'unsettled-private',
                'magic-context-dream-map-memories',
                '/repo',
                1
            );
        `);
        try {
            await teardownChildSession({
                client: fixture.client,
                sessionId: "unsettled-private",
                sessionDirectory: "/repo",
                promptSettled: false,
                privacySensitive: true,
                context: "[dreamer] map-memories",
                log: (message) => {
                    fixture.calls.push("log");
                    fixture.messages.push(message);
                },
            });

            expect(fixture.calls).toEqual(["archive", "log"]);
            expect(fixture.deleted).toEqual([]);
            expect(fixture.messages).toEqual([
                "[dreamer] map-memories: prompt unsettled — session unsettled-private left to the age-gated sweep",
            ]);
            expect(
                db.prepare("SELECT id FROM session WHERE id = ?").get("unsettled-private"),
            ).toEqual({
                id: "unsettled-private",
            });

            const swept = await sweepOrphanedRetrospectiveChildren({
                opencodeDb: db,
                client: fixture.client as never,
                sessionDirectory: "/repo",
                staleMs: 1_000,
                now: 1_002,
            });
            expect(swept).toBe(1);
            expect(fixture.deleted).toEqual(["unsettled-private"]);
        } finally {
            closeQuietly(db);
        }
    });
});

function productionTypeScriptFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...productionTypeScriptFiles(path));
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
    }
    return files;
}

function clientSessionDeleteOffsets(path: string, source: string): number[] {
    const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const offsets: number[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
            const deleteAccess = node.expression;
            const sessionAccess = deleteAccess.expression;
            if (
                deleteAccess.name.text === "delete" &&
                ts.isPropertyAccessExpression(sessionAccess) &&
                sessionAccess.name.text === "session" &&
                (ts.isIdentifier(sessionAccess.expression)
                    ? sessionAccess.expression.text === "client"
                    : ts.isPropertyAccessExpression(sessionAccess.expression) &&
                      sessionAccess.expression.name.text === "client")
            ) {
                offsets.push(node.getStart(sourceFile));
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return offsets;
}

describe("child-session delete source fence", () => {
    test("every client.session.delete call is the age-gated sweep or promptSettled-gated teardown", () => {
        const sourceRoot = join(import.meta.dir, "..");
        const sites: string[] = [];
        for (const path of productionTypeScriptFiles(sourceRoot)) {
            const source = readFileSync(path, "utf8");
            for (const offset of clientSessionDeleteOffsets(path, source)) {
                const line = source.slice(0, offset).split("\n").length;
                sites.push(`${relative(sourceRoot, path)}:${line}`);
            }
        }

        // Directory walk order differs between macOS and Linux; the fence is a set.
        expect(sites.map((site) => site.replace(/:\d+$/, "")).sort()).toEqual([
            "features/magic-context/dreamer/retrospective-orphan-sweep.ts",
            "shared/child-session-teardown.ts",
        ]);
        const teardownSource = readFileSync(
            join(sourceRoot, "shared/child-session-teardown.ts"),
            "utf8",
        );
        expect(teardownSource).toMatch(
            /if\s*\(\s*promptSettled[\s\S]{0,200}client\.session\.delete\s*\(/,
        );
    });
});

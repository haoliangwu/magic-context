import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createCtxExpandTools } from "./tools";

const toolContext = { sessionID: "ses-expand-validation" } as never;
const tools = createCtxExpandTools({ db: {} as never });

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("ctx_expand ordinal validation", () => {
    it("rejects zero and fractional message ordinals", async () => {
        expect(await tools.ctx_expand.execute({ message: 0 }, toolContext)).toBe(
            "Error: message must be a positive integer.",
        );
        expect(await tools.ctx_expand.execute({ message: 1.5 }, toolContext)).toBe(
            "Error: message must be a positive integer.",
        );
    });

    it("rejects zero and fractional range ordinals", async () => {
        const error =
            "Error: provide either message=<ordinal>, or start and end (positive integers, start <= end).";
        expect(await tools.ctx_expand.execute({ start: 0, end: 1 }, toolContext)).toBe(error);
        expect(await tools.ctx_expand.execute({ start: 1.5, end: 2 }, toolContext)).toBe(error);
        expect(await tools.ctx_expand.execute({ start: 1, end: 2.5 }, toolContext)).toBe(error);
    });
});

describe("ctx_expand required-all filler", () => {
    let db: Database;
    let expandTools: ReturnType<typeof createCtxExpandTools>;

    afterEach(() => {
        closeQuietly(db);
    });

    beforeEach(() => {
        db = createTestDb();
        expandTools = createCtxExpandTools({ db });
    });

    it("matches the clean call for every mode when unused fields are filled", async () => {
        const session = { sessionID: "ses-expand-filler" } as never;
        const rangeClean = await expandTools.ctx_expand.execute({ start: 1, end: 3 }, session);
        const rangeFiller = await expandTools.ctx_expand.execute(
            { start: 1, end: 3, message: 0, verbose: false },
            session,
        );
        const verboseClean = await expandTools.ctx_expand.execute(
            { start: 1, end: 3, verbose: true },
            session,
        );
        const verboseFiller = await expandTools.ctx_expand.execute(
            { start: 1, end: 3, verbose: true, message: 0 },
            session,
        );
        const messageClean = await expandTools.ctx_expand.execute({ message: 2 }, session);
        const messageFiller = await expandTools.ctx_expand.execute(
            { message: 2, start: 0, end: 0, verbose: false },
            session,
        );

        expect(rangeFiller).toBe(rangeClean);
        expect(verboseFiller).toBe(verboseClean);
        expect(messageFiller).toBe(messageClean);
        expect(rangeClean).toContain("No messages found in range 1-3");
        expect(verboseClean).toContain("No messages found in range 1-3");
        expect(messageClean).toContain("No message at ordinal 2");
    });
});

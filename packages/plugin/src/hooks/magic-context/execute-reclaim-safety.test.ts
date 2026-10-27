import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";

for (const generation of ["v1", "v2"] as const) {
    test(`${generation} execute state SQLITE_BUSY preserves a fitting turn without a last-good slot`, async () => {
        const { createAutoSearchReplayFixture } = await import("./auto-search-replay.fixture");
        const { createTransform } = await import("./transform");
        const { createMessagesTransformHandler } = await import("../../plugin/messages-transform");
        const { createTagger } = await import("../../features/magic-context/tagger");
        const { getTagsBySession, getPendingOps, queuePendingOp } = await import(
            "../../features/magic-context/storage"
        );
        const { dropSlot } = await import("./lkg-slot");
        const { Database } = await import("../../shared/sqlite");
        const fixture = createAutoSearchReplayFixture(
            generation === "v1" ? "opencode" : "opencode2",
            `busy-${generation}`,
        );
        const db = fixture.db;
        const id = fixture.sessionId;
        const raw = Array.from({ length: 18 }, (_, i) => ({
            info: {
                id: `message-${i}`,
                role: i % 2 ? "assistant" : "user",
                sessionID: id,
                time: { created: i + 1 },
            },
            parts: [{ type: "text", text: `Historical message ${i}: independent material.` }],
        }));
        let execute = false;
        const usage = new Map([
            [id, { usage: { percentage: 40, inputTokens: 40_000 }, updatedAt: Date.now() }],
        ]);
        const transform = createTransform({
            db,
            directory: fixture.directory,
            storeGeneration: generation,
            hostRawMessages: async () => raw as never,
            hostModelFallback: () => null,
            hostPrepareRawOrdinals: async () => true,
            tagger: createTagger(),
            scheduler: { shouldExecute: () => (execute ? "execute" : "defer") },
            contextUsageMap: usage,
            historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            protectedTokens: 0,
            historianRunnable: false,
        });
        const handler = createMessagesTransformHandler({
            magicContext: { "experimental.chat.messages.transform": transform },
        });
        const serve = async () => {
            const output = { messages: structuredClone(raw) };
            await handler({}, output as never);
            return output.messages;
        };
        try {
            const warm = await serve();
            const tag = getTagsBySession(db, id).find((t) => t.messageId.startsWith("message-7"));
            if (!tag) throw new Error("The warm pass did not tag the queued target");
            queuePendingOp(db, id, tag.tagNumber, "drop");
            dropSlot(id);
            execute = true;
            usage.set(id, {
                usage: { percentage: 76, inputTokens: 76_000 },
                updatedAt: Date.now(),
            });
            db.exec("PRAGMA busy_timeout=1");
            const prepare = db.prepare.bind(db);
            let reached = 0;
            let sqliteCode: unknown;
            const spy = spyOn(db, "prepare").mockImplementation(((sql: string) => {
                const statement = prepare(sql);
                if (
                    sql !==
                    "UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ? AND trailing_blank_decisions IS ?"
                )
                    return statement;
                return new Proxy(statement, {
                    get(target, key) {
                        if (key === "run")
                            return (...args: unknown[]) => {
                                if (!String(args[0]).includes('"heldPasses":1'))
                                    return (target.run as (...a: unknown[]) => unknown)(...args);
                                reached++;
                                const lock = new Database(join(fixture.directory, "context.db"));
                                lock.exec("BEGIN IMMEDIATE");
                                try {
                                    return (target.run as (...a: unknown[]) => unknown)(...args);
                                } catch (error) {
                                    sqliteCode = (error as { code?: string }).code;
                                    throw error;
                                } finally {
                                    lock.exec("ROLLBACK");
                                    lock.close();
                                }
                            };
                        const value = Reflect.get(target, key);
                        return typeof value === "function" ? value.bind(target) : value;
                    },
                });
            }) as typeof db.prepare);
            let failure: unknown;
            let served: unknown;
            try {
                served = await serve();
            } catch (error) {
                failure = error;
            } finally {
                spy.mockRestore();
            }
            console.log(
                "OPENCODE_BUSY_WITNESS",
                JSON.stringify({
                    generation,
                    reached,
                    sqliteCode,
                    error:
                        failure instanceof Error ? `${failure.name}: ${failure.message}` : failure,
                    pending: getPendingOps(db, id).length,
                }),
            );
            expect(reached).toBe(1);
            expect(sqliteCode).toBe("SQLITE_BUSY");
            expect(failure).toBeUndefined();
            expect(served).toEqual(warm);
            expect(getPendingOps(db, id)).toHaveLength(1);
        } finally {
            fixture.close();
        }
    }, 30_000);
}

test("stale in-progress flag without a runnable historian permits third-pass reclaim", async () => {
    const { createAutoSearchReplayFixture } = await import("./auto-search-replay.fixture");
    const { createTransform } = await import("./transform");
    const { createMessagesTransformHandler } = await import("../../plugin/messages-transform");
    const { createTagger } = await import("../../features/magic-context/tagger");
    const {
        updateSessionMeta,
        getPendingOps,
        getTagsBySession,
        queuePendingOp,
        getOrCreateSessionMeta,
    } = await import("../../features/magic-context/storage");
    const { readExecuteReclaimState } = await import("./execute-reclaim");
    const fixture = createAutoSearchReplayFixture("opencode", "stale-progress");
    const db = fixture.db,
        id = fixture.sessionId;
    const raw = Array.from({ length: 18 }, (_, i) => ({
        info: { id: `stale-${i}`, role: i % 2 ? "assistant" : "user", sessionID: id },
        parts: [{ type: "text", text: `Historical material ${i}` }],
    }));
    let execute = false;
    const usage = new Map([
        [id, { usage: { percentage: 40, inputTokens: 40000 }, updatedAt: Date.now() }],
    ]);
    const transform = createTransform({
        db,
        directory: fixture.directory,
        storeGeneration: "v1",
        hostRawMessages: async () => raw as never,
        hostModelFallback: () => null,
        hostPrepareRawOrdinals: async () => true,
        tagger: createTagger(),
        scheduler: { shouldExecute: () => (execute ? "execute" : "defer") },
        contextUsageMap: usage,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        protectedTokens: 0,
        historianRunnable: true,
    });
    const handler = createMessagesTransformHandler({
        magicContext: { "experimental.chat.messages.transform": transform },
    });
    const serve = async () => {
        const output = { messages: structuredClone(raw) };
        await handler({}, output as never);
        return output.messages;
    };
    try {
        const warm = await serve();
        const tag = getTagsBySession(db, id).find((t) => t.messageId.startsWith("stale-7"));
        if (!tag) throw new Error("Missing queued prose target");
        queuePendingOp(db, id, tag.tagNumber, "drop");
        updateSessionMeta(db, id, { compartmentInProgress: true });
        execute = true;
        usage.set(id, { usage: { percentage: 76, inputTokens: 76000 }, updatedAt: Date.now() });
        expect(await serve()).toEqual(warm);
        expect(await serve()).toEqual(warm);
        const drained = await serve();
        expect(drained).not.toEqual(warm);
        for (let i = 0; i < 3; i++) expect(await serve()).toEqual(drained);
        console.log(
            "STALE_PROGRESS_WITNESS",
            JSON.stringify({
                heldPasses: readExecuteReclaimState(db, id).heldPasses,
                inProgress: getOrCreateSessionMeta(db, id).compartmentInProgress,
                pending: getPendingOps(db, id).length,
            }),
        );
        expect(getOrCreateSessionMeta(db, id).compartmentInProgress).toBe(false);
        expect(getPendingOps(db, id)).toHaveLength(0);
        expect(readExecuteReclaimState(db, id).heldPasses).toBe(0);
    } finally {
        fixture.close();
    }
});

test("partial-compartment suffix is neither estimated nor persisted by an ordinary drain", async () => {
    const { Database } = await import("../../shared/sqlite");
    const { initializeDatabase } = await import("../../features/magic-context/storage-db");
    const { runMigrations } = await import("../../features/magic-context/migrations");
    const { createTagger } = await import("../../features/magic-context/tagger");
    const { getTagsBySession, getPendingOps, queuePendingOp } = await import(
        "../../features/magic-context/storage"
    );
    const { tagMessages } = await import("./tag-messages");
    const { estimateExecuteReclaimTokens, originateExecuteReclaim } = await import(
        "./execute-reclaim"
    );
    const { applyPendingOperations, applyFlushedStatuses } = await import("./apply-operations");
    const { markTagDropped } = await import("../../features/magic-context/storage-tags");
    const db = new Database(":memory:");
    const id = "partial-suffix";
    try {
        initializeDatabase(db);
        runMigrations(db);
        db.prepare(
            "INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, end_block_index, title, content, created_at) VALUES (?,1,0,1,'msg-0','msg-1',0,'partial','covers the first block',1)",
        ).run(id);
        const source = "Uncovered raw suffix must stay visible. ".repeat(1200);
        const messages = [
            {
                info: { id: "msg-1", role: "assistant", sessionID: id },
                parts: [
                    { type: "text", text: "covered block" },
                    { type: "text", text: source },
                ],
            },
        ];
        const tagger = createTagger();
        tagger.initFromDb(id, db);
        const { targets } = tagMessages(id, messages, tagger, db);
        const tags = getTagsBySession(db, id);
        const tag = tags.find((t) => t.messageId === "msg-1:p1");
        if (!tag) throw new Error("Missing uncovered suffix tag");
        queuePendingOp(db, id, tag.tagNumber, "drop");
        const pendingOps = getPendingOps(db, id);
        const estimate = estimateExecuteReclaimTokens({
            db,
            sessionId: id,
            pendingOps,
            tags,
            targets,
            protectedTagIds: new Set(),
        });
        const allowed = originateExecuteReclaim({
            db,
            sessionId: id,
            primaryExecute: true,
            summaryCanCome: false,
            alreadyBusting: false,
            reclaimableTokens: estimate,
            usableWindow: 96000,
        });
        const before = JSON.stringify(messages);
        const mutated = applyPendingOperations(id, db, targets, new Set(), tags, pendingOps);
        console.log(
            "PARTIAL_ESTIMATE_WITNESS",
            JSON.stringify({
                estimate,
                allowed,
                mutated,
                removedBytes: before.length - JSON.stringify(messages).length,
                pending: getPendingOps(db, id).length,
                status: getTagsBySession(db, id).find((t) => t.tagNumber === tag.tagNumber)?.status,
            }),
        );
        expect(estimate).toBe(0);
        expect(allowed).toBe(false);
        expect(mutated).toBe(false);
        expect(JSON.stringify(messages)).toBe(before);
        expect(getPendingOps(db, id)).toHaveLength(1);
        expect(getTagsBySession(db, id).find((t) => t.tagNumber === tag.tagNumber)?.status).toBe(
            "active",
        );
        // Old drains could persist a dropped status even though this suffix
        // stayed visible. Replaying those rows must retain the same bytes.
        markTagDropped(db, id, tag.tagNumber);
        expect(applyFlushedStatuses(id, db, targets)).toBe(false);
        expect(JSON.stringify(messages)).toBe(before);
    } finally {
        db.close();
    }
});

test("failed counter or floor-mark prerequisite declines worthwhile reclaim for only that pass", async () => {
    const { createAutoSearchReplayFixture } = await import("./auto-search-replay.fixture");
    const {
        maintainExecuteFloorMark,
        writeExecuteReclaimState,
        readExecuteReclaimState,
        originateExecuteReclaim,
    } = await import("./execute-reclaim");
    const h = createAutoSearchReplayFixture("opencode", "failed-prerequisite");
    try {
        const args = {
            db: h.db,
            sessionId: h.sessionId,
            primaryExecute: true,
            alreadyBusting: false,
            summaryCanCome: false,
            reclaimableTokens: 3000,
            usableWindow: 100000,
        };
        h.db.exec(
            `CREATE TRIGGER fail_execute_state BEFORE UPDATE OF trailing_blank_decisions ON session_meta BEGIN SELECT RAISE(FAIL, 'state persistence failed'); END;`,
        );
        expect(originateExecuteReclaim(args)).toBe(false);
        expect(readExecuteReclaimState(h.db, h.sessionId).heldPasses).toBe(0);
        h.db.exec("DROP TRIGGER fail_execute_state");
        maintainExecuteFloorMark(h.db, h.sessionId, "prompt", false);
        expect(originateExecuteReclaim(args)).toBe(true);
        h.db.exec(
            `CREATE TRIGGER fail_floor_state BEFORE UPDATE OF trailing_blank_decisions ON session_meta WHEN json_extract(NEW.trailing_blank_decisions,'$.executeReclaim.floorOrdinal') IS NOT NULL BEGIN SELECT RAISE(FAIL, 'floor persistence failed'); END;`,
        );
        expect(
            writeExecuteReclaimState(h.db, h.sessionId, {
                floorOrdinal: 3,
                floorPromptId: "prompt",
            }),
        ).toBe(false);
        expect(originateExecuteReclaim(args)).toBe(false);
        h.db.exec("DROP TRIGGER fail_floor_state");
        maintainExecuteFloorMark(h.db, h.sessionId, "prompt", false);
        expect(originateExecuteReclaim(args)).toBe(true);
    } finally {
        h.close();
    }
});

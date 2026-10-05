/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { moduleRawBlockMappings } from "../../plugin/src/hooks/magic-context/module-wire";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

interface SqliteRow {
    id: string;
    message_id?: string;
    session_id: string;
    time_created: number;
    time_updated: number;
    data: string;
}

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

/** The session's published compartments, in order. */
function contextHistoryRows(path: string, sessionId: string): Array<{ sequence: number; title: string }> {
    const db = new Database(path, { readonly: true });
    try {
        return db
            .query("SELECT sequence, title FROM compartments WHERE session_id = ? ORDER BY sequence")
            .all(sessionId) as Array<{ sequence: number; title: string }>;
    } finally {
        db.close();
    }
}

describe.skipIf(!rustPrereqs.ok)("rust invariant: compaction marker byte identity", () => {
    let h: RustTestHarness;

    beforeEach(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 30_000,
            // The historian gets its own 128k mock model: the 30k session window
            // builds pressure quickly but cannot hold a historian prompt.
            historianModelContextLimit: 128_000,
            magicContextConfig: {
                execute_threshold_percentage: 25,
                protected_tags: 1,
                compressor: { enabled: false },
            },
        });
    });

    afterEach(async () => {
        await h?.dispose();
    });

    it(
        "serves identical serialized arrays with the marker applied and deliberately absent",
        async () => {
            const sessionId = await h.createSession();
            const opencodeDb = new Database(join(h.env.dataDir, "opencode", "opencode.db"));
            // The harness's OpenCode server writes this database concurrently; bun:sqlite
            // defaults to no busy wait, so the marker deletes below would fail on the
            // first overlapping host write (seen as SQLITE_BUSY in release run r2).
            opencodeDb.exec("PRAGMA busy_timeout = 30000");

            for (let turn = 1; turn <= 20; turn += 1) {
                h.mock.setDefault({
                    text: `fold reply ${turn}`,
                    usage: {
                        input_tokens: 3_000 * turn,
                        output_tokens: 20,
                        cache_creation_input_tokens: 2_000,
                    },
                });
                await h.sendPrompt(sessionId, `marker fold turn ${turn}: ${h.ballast(6_000)}`);
                const markerCount = (
                    opencodeDb
                        .prepare(
                            `SELECT COUNT(*) AS count
                               FROM part
                              WHERE session_id = ?
                                AND json_extract(data, '$.type') = 'compaction'
                                AND json_extract(data, '$.auto') = 1`,
                        )
                        .get(sessionId) as { count: number }
                ).count;
                if (
                    markerCount > 0 ||
                    h.readRustPasses().some((pass) => pass.reason === "coverage_fold")
                ) {
                    break;
                }
                await Bun.sleep(200);
            }

            // Native markers discard an entire message; an indexed end normally forbids
            // that. Prove this fixture's end is the message's final CK block before
            // setting NULL to declare whole-message coverage. No suffix is discarded.
            h.mock.setDefault({ text: "whole-boundary probe", usage: { input_tokens: 500, output_tokens: 20 } });
            const contextWriter = new Database(join(h.env.dataDir, "cortexkit", "magic-context", "context.db"));
            contextWriter.exec("PRAGMA busy_timeout=5000");
            try {
                for (let attempt = 0; attempt < 5; attempt++) {
                    await Bun.sleep(100);
                    const raw = await h.listMessages(sessionId);
                    const rows = contextWriter.query("SELECT id,end_message_id,end_block_index FROM compartments WHERE session_id=? AND end_block_index IS NOT NULL").all(sessionId) as Array<{id:number,end_message_id:string,end_block_index:number}>;
                    for (const row of rows) {
                        const message = raw.find(message => message.info.id === row.end_message_id);
                        expect(message).toBeDefined();
                        const parts = message!.parts.filter(part => part.type !== "step-start" && part.type !== "step-finish");
                        expect(parts.length).toBeGreaterThan(0);
                        expect(parts.every(part => part.type === "text")).toBe(true);
                        expect(row.end_block_index).toBe(moduleRawBlockMappings({ id: message!.info.id, role: message!.info.role, parts: message!.parts } as never).at(-1)?.blockIndex);
                        contextWriter.query("UPDATE compartments SET end_block_index=NULL WHERE id=?").run(row.id);
                    }
                    // Restart the host so state_sync refreshes its cache after the fixture change.
                    await h.restart({ rust: true });
                    await h.sendPrompt(sessionId, `publish certified whole-message marker ${attempt}`);
                    const count = (opencodeDb.query("SELECT count(*) AS n FROM part WHERE session_id=? AND json_extract(data,'$.type')='compaction' AND json_extract(data,'$.auto')=1").get(sessionId) as {n:number}).n;
                    if (count > 0) break;
                }
            } finally { contextWriter.close(); }

            const summaryRows = opencodeDb
                .prepare(
                    `SELECT * FROM message
                      WHERE session_id = ?
                        AND json_extract(data, '$.summary') = 1
                        AND json_extract(data, '$.providerID') = 'magic-context'`,
                )
                .all(sessionId) as SqliteRow[];
            const compactionRows = opencodeDb
                .prepare(
                    `SELECT * FROM part
                      WHERE session_id = ?
                        AND json_extract(data, '$.type') = 'compaction'
                        AND json_extract(data, '$.auto') = 1`,
                )
                .all(sessionId) as SqliteRow[];
            if (summaryRows.length !== 1 || compactionRows.length !== 1) {
                const pluginLog = await Bun.file(h.logPath).text();
                throw new Error(
                    `expected one applied marker; summary=${summaryRows.length} compaction=${compactionRows.length}\n` +
                        `rust passes=${JSON.stringify(h.readRustPasses())}\n` +
                        `marker logs=${pluginLog
                            .split("\n")
                            .filter((line) => line.includes("compaction-marker"))
                            .join("\n")}\n` +
                        `module log tail=${h.subc.moduleLog().slice(-8_000)}`,
                );
            }
            const summaryPartRows = opencodeDb
                .prepare("SELECT * FROM part WHERE session_id = ? AND message_id = ?")
                .all(sessionId, summaryRows[0]!.id) as SqliteRow[];

            // For the baseline run, temporarily remove OpenCode's compaction-marker and summary
            // rows so the host supplies no marker. Restore them before the restart comparison
            // while leaving the module's durable fold unchanged.
            opencodeDb.transaction(() => {
                for (const row of [...compactionRows, ...summaryPartRows]) {
                    opencodeDb.prepare("DELETE FROM part WHERE id = ?").run(row.id);
                }
                opencodeDb.prepare("DELETE FROM message WHERE id = ?").run(summaryRows[0]!.id);
            })();

            // The three probe passes below must all render the same session history.
            // A historian run still in flight when the fixture loop above stops (on a
            // slow runner the run covering the newest turn often is) would publish a
            // compartment between the control pass and the marker pass, and the two
            // would differ by that compartment rather than by the marker. Let every
            // run finish, then stop the producer so no later run can publish while
            // the passes are compared, and restart the module so the control pass,
            // like the marker pass, is rendered by a module that has just read the
            // store.
            const historianDeadline = Date.now() + 120_000;
            let historianState: string | undefined;
            while (Date.now() < historianDeadline) {
                const status = (await h.subc.moduleStatus(sessionId, h.env.workdir)) as {
                    historian?: { state?: string };
                };
                historianState = status.historian?.state;
                if (historianState === "idle") break;
                await Bun.sleep(100);
            }
            expect(historianState).toBe("idle");
            h.subc.killProducer();
            await h.subc.waitForProducerDeath();
            await h.subc.restartModule();
            const publishedHistory = () =>
                contextHistoryRows(join(h.env.dataDir, "cortexkit", "magic-context", "context.db"), sessionId);
            const historyBeforeComparison = publishedHistory();

            const probe = "byte identity marker probe";
            const probeMessageId = "msg_01MKRBYT3ID3NT1TYPR0BE0000";
            await Bun.sleep(700);
            const controlPassesBefore = h.readRustPasses().length;
            await h.sendPrompt(sessionId, probe, { messageID: probeMessageId });
            const controlPasses = await h.waitForRustPasses(controlPassesBefore + 1);
            const controlInput = controlPasses.at(-1)!.inputCount;
            const controlSerialized = h.lastMainWireSerialized();
            const controlHash = sha256(controlSerialized);
            const controlProbe = (await h.listMessages(sessionId))
                .filter(
                    (message) =>
                        message.info?.role === "user" &&
                        message.parts?.some((part) => part.type === "text" && part.text === probe),
                )
                .at(-1)?.info?.id;
            expect(controlProbe).toBe(probeMessageId);
            await h.revertMessage(sessionId, controlProbe!);

            opencodeDb.transaction(() => {
                for (const row of summaryRows) {
                    opencodeDb
                        .prepare(
                            "INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
                        )
                        .run(row.id, row.session_id, row.time_created, row.time_updated, row.data);
                }
                for (const row of [...compactionRows, ...summaryPartRows]) {
                    opencodeDb
                        .prepare(
                            "INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
                        )
                        .run(
                            row.id,
                            row.message_id!,
                            row.session_id,
                            row.time_created,
                            row.time_updated,
                            row.data,
                        );
                }
            })();

            await h.subc.restartModule();
            await Bun.sleep(700);
            const markerPassesBefore = h.readRustPasses().length;
            await h.sendPrompt(sessionId, probe, { messageID: probeMessageId });
            const markerPasses = await h.waitForRustPasses(markerPassesBefore + 1);
            const markerInput = markerPasses.at(-1)!.inputCount;
            const markerSerialized = h.lastMainWireSerialized();
            const markerHash = sha256(markerSerialized);
            const markerProbe = (await h.listMessages(sessionId))
                .filter(
                    (message) =>
                        message.info?.role === "user" &&
                        message.parts?.some((part) => part.type === "text" && part.text === probe),
                )
                .at(-1)?.info?.id;
            expect(markerProbe).toBe(probeMessageId);
            await h.revertMessage(sessionId, markerProbe!);

            const replayPassesBefore = h.readRustPasses().length;
            await h.sendPrompt(sessionId, probe, { messageID: probeMessageId });
            const replayPasses = await h.waitForRustPasses(replayPassesBefore + 1);
            const replaySerialized = h.lastMainWireSerialized();
            const replayHash = sha256(replaySerialized);

            // No compartment may land while the passes are compared; the producer is
            // gone, so a change here means the drain above missed a run.
            expect(publishedHistory()).toEqual(historyBeforeComparison);
            console.log(`rust marker byte identity control sha256=${controlHash}`);
            console.log(`rust marker byte identity post-restart-1 sha256=${markerHash}`);
            console.log(`rust marker byte identity post-restart-2 sha256=${replayHash}`);
            expect(controlInput).toBeGreaterThan(markerInput);
            expect(replayPasses.at(-1)!.inputCount).toBe(markerInput);
            if (controlHash !== markerHash || markerHash !== replayHash) {
                const firstDifference =
                    controlHash !== markerHash
                        ? [...controlSerialized].findIndex(
                              (character, index) => character !== markerSerialized[index],
                          )
                        : [...markerSerialized].findIndex(
                              (character, index) => character !== replaySerialized[index],
                          );
                throw new Error(
                    `wire bytes diverged at ${firstDifference}: ` +
                        `control=${JSON.stringify(controlSerialized.slice(firstDifference, firstDifference + 500))} ` +
                        `postRestart1=${JSON.stringify(markerSerialized.slice(firstDifference, firstDifference + 500))} ` +
                        `postRestart2=${JSON.stringify(replaySerialized.slice(firstDifference, firstDifference + 500))}`,
                );
            }
            opencodeDb.close();
        },
        300_000,
    );
});

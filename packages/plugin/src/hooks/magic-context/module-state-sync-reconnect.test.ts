/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildFlags,
    buildFrame,
    computeProof,
    decodeHeader,
    type EnvelopeHeader,
    encodeFrame,
    FrameType,
    HEADER_LEN,
    Priority,
    SERVER_PROOF_DOMAIN,
} from "@cortexkit/subc-client";
import { runMigrations } from "../../features/magic-context/migrations";
import { updateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { setProjectState } from "../../features/magic-context/storage-project-state";
import { insertUserMemory } from "../../features/magic-context/user-memory/storage-user-memory";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { loadModuleWatermarks, syncModuleState } from "./module-state-sync";
import { SubcModuleTransport } from "./module-transport";

/**
 * These tests drive syncModuleState through the real SUBC transport and a real
 * socket, so the reconnect, connection-generation and backoff behaviour under
 * test is the transport's own rather than a mock's idea of it.
 */

const cleanups: Array<() => void> = [];

afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

class FakeServerReader {
    private buffered = Buffer.alloc(0);
    private readonly iterator: AsyncIterator<Uint8Array>;

    constructor(socket: Socket) {
        this.iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
    }

    async readExact(length: number): Promise<Buffer> {
        while (this.buffered.length < length) {
            const next = await this.iterator.next();
            if (next.done) throw new Error("fake subc peer closed");
            this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
        }
        const value = this.buffered.subarray(0, length);
        this.buffered = this.buffered.subarray(length);
        return value;
    }
}

async function readAuthMessage(reader: FakeServerReader): Promise<Record<string, unknown>> {
    const length = (await reader.readExact(4)).readUInt32LE(0);
    return JSON.parse((await reader.readExact(length)).toString("utf8")) as Record<string, unknown>;
}

function writeAuthMessage(socket: Socket, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length, 0);
    socket.write(Buffer.concat([length, body]));
}

async function readFrame(
    reader: FakeServerReader,
): Promise<{ header: EnvelopeHeader; body: Uint8Array }> {
    const header = decodeHeader(await reader.readExact(HEADER_LEN));
    const body = header.len === 0 ? new Uint8Array(0) : await reader.readExact(header.len);
    return { header, body };
}

function writeJsonResponse(socket: Socket, request: EnvelopeHeader, body: unknown): void {
    socket.write(
        encodeFrame(
            buildFrame(
                FrameType.Response,
                buildFlags(false, Priority.Interactive, false),
                request.channel,
                request.epoch,
                request.corr,
                Buffer.from(JSON.stringify(body)),
            ),
        ),
    );
}

async function listen(server: Server): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake subc server has no port");
    return address.port;
}

function writeConnectionFile(port: number): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), "state-sync-reconnect-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const connectionFile = join(dir, "subc-connection.json");
    writeFileSync(
        connectionFile,
        JSON.stringify({
            schema: 1,
            endpoints: [{ host: "127.0.0.1", port }],
            key: [...DAEMON_KEY],
            daemon_id: [...DAEMON_ID],
            pid: process.pid,
            daemon_ver: "fake-v2",
        }),
    );
    chmodSync(connectionFile, 0o600);
    return connectionFile;
}

const DAEMON_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const DAEMON_ID = Uint8Array.from({ length: 16 }, (_, index) => 100 + index);
const SERVER_NONCE = Uint8Array.from({ length: 32 }, (_, index) => 200 - index);

/**
 * A daemon that answers the capability probe but dies on every state_sync it is
 * sent, the way a module that crashes on one payload and is restarted by its
 * supervisor looks from the client. After `answerAfter` crashes it starts
 * answering, so a client that never gives up still finishes and the test reads
 * how many times it was hit instead of hanging.
 */
async function startCrashOnStateSyncDaemon(answerAfter: number): Promise<{
    connectionFile: string;
    stateSyncs: () => number;
    connections: () => number;
}> {
    let stateSyncs = 0;
    let connections = 0;
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        connections += 1;
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        void (async () => {
            const reader = new FakeServerReader(socket);
            const hello = await readAuthMessage(reader);
            const clientNonce = Uint8Array.from(hello.client_nonce as number[]);
            writeAuthMessage(socket, {
                server_nonce: [...SERVER_NONCE],
                daemon_id: [...DAEMON_ID],
                server_proof: [
                    ...computeProof(
                        DAEMON_KEY,
                        SERVER_PROOF_DOMAIN,
                        clientNonce,
                        SERVER_NONCE,
                        DAEMON_ID,
                    ),
                ],
            });
            await readAuthMessage(reader);
            for (;;) {
                const frame = await readFrame(reader);
                if (frame.header.ty !== FrameType.Request) continue;
                const body = JSON.parse(Buffer.from(frame.body).toString("utf8")) as Record<
                    string,
                    unknown
                >;
                if (body.op === "route.open") {
                    writeJsonResponse(socket, frame.header, { route_channel: 7, route_epoch: 77 });
                    continue;
                }
                if (body.method === "session.status") {
                    writeJsonResponse(socket, frame.header, {
                        result: { epochs: { state_sync_deltas: true } },
                    });
                    continue;
                }
                stateSyncs += 1;
                if (stateSyncs <= answerAfter) {
                    socket.destroy();
                    return;
                }
                writeJsonResponse(socket, frame.header, { result: { shadow_seq: 1 } });
            }
        })().catch(() => socket.destroy());
    });
    const port = await listen(server);
    cleanups.push(() => {
        for (const socket of sockets) socket.destroy();
        server.close();
    });
    return {
        connectionFile: writeConnectionFile(port),
        stateSyncs: () => stateSyncs,
        connections: () => connections,
    };
}

function changedSessionDb(): Database {
    const db = new Database(":memory:");
    cleanups.push(() => closeQuietly(db));
    initializeDatabase(db);
    runMigrations(db);
    insertUserMemory(db, "profile", []);
    setProjectState(db, "__global__", { projectUserProfileVersion: 1 });
    setProjectState(db, "/tmp/project", { projectMemoryEpoch: 1 });
    return db;
}

describe("state sync against a module that keeps dropping the connection", () => {
    it("fails the pass after a bounded number of reconnects instead of rebuilding forever", async () => {
        const daemon = await startCrashOnStateSyncDaemon(25);
        const transport = new SubcModuleTransport(daemon.connectionFile, "magic-context", 2_000);
        cleanups.push(() => transport.closeSession("ses-crash-loop"));
        const sessionId = "ses-crash-loop";
        const db = changedSessionDb();
        const state = {
            moduleGeneration: 1,
            lastAckedSeq: 0,
            lastAckedWatermarks: loadModuleWatermarks({
                db,
                sessionId,
                projectPath: "/tmp/project",
            }),
            idOrdinalMemoGeneration: 1,
            idOrdinalMemo: new Map<string, number>(),
            seedPassPending: false,
        };
        // A change since the last acknowledged watermarks, so the pass has a delta to send.
        updateSessionMeta(db, sessionId, { lastTodoState: '[{"content":"changed"}]' });

        const outcome = await syncModuleState({
            client: transport,
            state,
            pass: { db, sessionId, projectPath: "/tmp/project", nowMs: 1 },
            projectRoot: "/tmp/project",
            force: false,
        }).then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
        );

        // The pass must fail so the transform falls back to its last-known-good replay or
        // refusal; an acknowledged result here means every crash was retried.
        expect(outcome).toEqual({
            error: expect.objectContaining({ code: "state_sync_connection_unstable" }),
        });
        expect(daemon.stateSyncs()).toBe(3);
    });

    it("fails promptly when the daemon is down and the reconnect backoff is long", async () => {
        // Nothing listens on this port: bind one, then close it before the client connects.
        const placeholder = createServer();
        const port = await listen(placeholder);
        await new Promise<void>((resolve) => placeholder.close(() => resolve()));
        const transport = new SubcModuleTransport(writeConnectionFile(port), "magic-context", 500);
        // The 16 s rung of the reconnect backoff, past the in-pass wait budget, so each
        // connect attempt is refused immediately without touching the network.
        const internals = transport as unknown as { nextProbeMs: number; backoffMs: number };
        internals.nextProbeMs = Date.now() + 16_000;
        internals.backoffMs = 30_000;
        const sessionId = "ses-daemon-down";
        const db = changedSessionDb();
        const state = {
            moduleGeneration: 1,
            lastAckedSeq: 0,
            lastAckedWatermarks: loadModuleWatermarks({
                db,
                sessionId,
                projectPath: "/tmp/project",
            }),
            idOrdinalMemoGeneration: 1,
            idOrdinalMemo: new Map<string, number>(),
            seedPassPending: false,
        };
        updateSessionMeta(db, sessionId, { lastTodoState: '[{"content":"changed"}]' });

        const startedAt = performance.now();
        await expect(
            syncModuleState({
                client: transport,
                state,
                pass: { db, sessionId, projectPath: "/tmp/project", nowMs: 1 },
                projectRoot: "/tmp/project",
                force: false,
            }),
        ).rejects.toMatchObject({ code: "SUBC_CONNECTION_BACKOFF" });
        expect(performance.now() - startedAt).toBeLessThan(2_000);
    });
});

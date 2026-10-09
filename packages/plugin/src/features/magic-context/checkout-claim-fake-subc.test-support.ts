/**
 * A wire-compatible stand-in for the subc daemon, for checkout-claim tests.
 *
 * It completes subc's HMAC handshake, answers channel-0 `route.open` and
 * `catalog.list`, and hands every data-plane request on an opened route to a
 * responder, which plays ALF and engram. Clients under test use the real
 * `@cortexkit/subc-client` against it, so their bytes on the wire are the
 * production bytes. It never touches a real daemon or a real connection file:
 * the caller chooses the directory the connection file is written to.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
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

export interface FakeSubcRoute {
    target: Record<string, unknown>;
    identity: Record<string, unknown>;
    consumerIdentity: unknown;
}

export interface FakeSubcCall {
    route: FakeSubcRoute;
    method: string;
    params: unknown;
}

/** `result` is sent as `{"result": ...}`; `error` as an Error frame; `hang` never answers. */
export type FakeSubcReply =
    | { result: unknown }
    | { error: { code: string; message: string } }
    | { hang: true };

export interface FakeSubcDaemon {
    readonly connectionFile: string;
    readonly port: number;
    /** Every route.open, in arrival order. */
    readonly routeOpens: FakeSubcRoute[];
    /** Every data-plane request, in arrival order. */
    readonly calls: FakeSubcCall[];
    close(): Promise<void>;
}

class FrameReader {
    private buffered = Buffer.alloc(0);
    private readonly iterator: AsyncIterator<Uint8Array>;

    constructor(socket: Socket) {
        this.iterator = socket[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
    }

    async readExact(length: number): Promise<Buffer> {
        while (this.buffered.length < length) {
            const next = await this.iterator.next();
            if (next.done) throw new Error("peer closed");
            this.buffered = Buffer.concat([this.buffered, Buffer.from(next.value)]);
        }
        const value = this.buffered.subarray(0, length);
        this.buffered = this.buffered.subarray(length);
        return value;
    }
}

async function readAuthMessage(reader: FrameReader): Promise<Record<string, unknown>> {
    const length = (await reader.readExact(4)).readUInt32LE(0);
    return JSON.parse((await reader.readExact(length)).toString("utf8")) as Record<string, unknown>;
}

function writeAuthMessage(socket: Socket, value: unknown): void {
    const body = Buffer.from(JSON.stringify(value));
    const length = Buffer.alloc(4);
    length.writeUInt32LE(body.length, 0);
    socket.write(Buffer.concat([length, body]));
}

function writeFrame(socket: Socket, request: EnvelopeHeader, ty: FrameType, body: unknown): void {
    if (socket.destroyed) return;
    socket.write(
        encodeFrame(
            buildFrame(
                ty,
                buildFlags(false, Priority.Interactive, false),
                request.channel,
                request.epoch,
                request.corr,
                Buffer.from(JSON.stringify(body)),
            ),
        ),
    );
}

/**
 * Start the fake daemon and write its connection file (mode 0600, as the real
 * client requires) at `connectionFile`.
 */
export async function startFakeSubcDaemon(
    connectionFile: string,
    respond: (call: FakeSubcCall) => FakeSubcReply | Promise<FakeSubcReply>,
): Promise<FakeSubcDaemon> {
    const key = randomBytes(32);
    const daemonId = randomBytes(16);
    const routeOpens: FakeSubcRoute[] = [];
    const calls: FakeSubcCall[] = [];
    const sockets = new Set<Socket>();
    let nextChannel = 1;

    const serve = async (socket: Socket): Promise<void> => {
        const reader = new FrameReader(socket);
        const hello = await readAuthMessage(reader);
        const clientNonce = Uint8Array.from(hello.client_nonce as number[]);
        const serverNonce = randomBytes(32);
        writeAuthMessage(socket, {
            server_nonce: [...serverNonce],
            daemon_id: [...daemonId],
            server_proof: [
                ...computeProof(key, SERVER_PROOF_DOMAIN, clientNonce, serverNonce, daemonId),
            ],
        });
        await readAuthMessage(reader);
        const routes = new Map<number, FakeSubcRoute>();
        for (;;) {
            const header = decodeHeader(await reader.readExact(HEADER_LEN));
            const body = header.len === 0 ? new Uint8Array(0) : await reader.readExact(header.len);
            if (header.ty !== FrameType.Request) continue;
            const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as Record<
                string,
                unknown
            >;
            if (header.channel === 0) {
                if (parsed.op === "route.open") {
                    const route: FakeSubcRoute = {
                        target: parsed.target as Record<string, unknown>,
                        identity: parsed.identity as Record<string, unknown>,
                        consumerIdentity: parsed.consumer_identity,
                    };
                    routeOpens.push(route);
                    const channel = nextChannel++;
                    routes.set(channel, route);
                    writeFrame(socket, header, FrameType.Response, {
                        route_channel: channel,
                        route_epoch: 1,
                    });
                } else if (parsed.op === "catalog.list") {
                    writeFrame(socket, header, FrameType.Response, {
                        op: "catalog.list",
                        modules: [],
                    });
                } else {
                    writeFrame(socket, header, FrameType.Error, {
                        code: "unsupported_op",
                        message: `fake subc daemon does not serve ${String(parsed.op)}`,
                    });
                }
                continue;
            }
            const route = routes.get(header.channel);
            if (!route) {
                writeFrame(socket, header, FrameType.Error, {
                    code: "unknown_channel",
                    message: "no such route",
                });
                continue;
            }
            const call: FakeSubcCall = {
                route,
                method: String(parsed.method),
                params: parsed.params,
            };
            calls.push(call);
            void Promise.resolve(respond(call)).then((reply) => {
                if ("hang" in reply) return;
                if ("error" in reply) writeFrame(socket, header, FrameType.Error, reply.error);
                else writeFrame(socket, header, FrameType.Response, { result: reply.result });
            });
        }
    };

    const server: Server = createServer((socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        socket.on("error", () => undefined);
        void serve(socket).catch(() => socket.destroy());
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake subc daemon has no port");
    mkdirSync(dirname(connectionFile), { recursive: true });
    writeFileSync(
        connectionFile,
        JSON.stringify({
            schema: 1,
            endpoints: [{ host: "127.0.0.1", port: address.port }],
            key: [...key],
            daemon_id: [...daemonId],
            pid: process.pid,
            daemon_ver: "fake-checkout-claim",
        }),
    );
    chmodSync(connectionFile, 0o600);
    return {
        connectionFile,
        port: address.port,
        routeOpens,
        calls,
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/**
 * The fleet as the checkout-claim check sees it: ALF maps sessions to agents,
 * engram reports each agent's claim. Anything not listed answers as ALF and
 * engram do for unknown subjects (`agent_id: null`, an unclaimed epoch-0 view).
 */
export function fakeFleetResponder(fleet: {
    agents: Record<string, string>;
    claims: Record<string, Record<string, unknown>>;
}): (call: FakeSubcCall) => FakeSubcReply {
    return (call) => {
        const moduleId = call.route.target.module_id;
        if (moduleId === "prefrontal-core" && call.method === "agent.for_host_session") {
            const session = (call.params as { session?: string }).session ?? "";
            return { result: { agent_id: fleet.agents[session] ?? null } };
        }
        if (moduleId === "engram" && call.method === "claim.read") {
            const subject = (call.params as { subject?: string }).subject ?? "";
            const agentId = subject.replace(/^agent:/, "");
            return {
                result: fleet.claims[agentId] ?? {
                    absent: true,
                    epoch: 0,
                    held_here: false,
                    held_elsewhere: false,
                },
            };
        }
        return { error: { code: "unknown_method", message: `${String(moduleId)} ${call.method}` } };
    };
}

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
    chmodSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { log } from "./logger";
import {
    acknowledgeNotifications,
    drainNotifications,
    type NotificationSink,
    registerNotificationSink,
} from "./rpc-notifications";
import {
    inspectProcessesAsync,
    parseRpcPortFile,
    registerOwnRpcServerInstance,
    rpcPortDir,
    rpcPortFilePath,
} from "./rpc-utils";
import { shouldEnforcePrivateStoragePermissions } from "./storage-permissions";

type RpcHandler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Max body for an HTTP /rpc call. Matches the previous node:http guard. */
const MAX_BODY_BYTES = 1_048_576;
/** A WS client that doesn't authenticate within this window is closed. */
const WS_AUTH_TIMEOUT_MS = 5_000;
/** WS close code for an auth failure (private; client treats every close as
 *  expected and reconnects after rediscovery, so the exact code is advisory). */
const WS_CLOSE_UNAUTHORIZED = 4401;

/** Per-socket state carried on `ServerWebSocket.data`. */
interface WsData {
    authed: boolean;
    sessionId?: string;
    /** Removes this socket's sink from the notification registry. */
    unregister?: () => void;
    /** Fires if the client never sends a valid hello. */
    authTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Constant-time bearer-token comparison. `timingSafeEqual` throws on
 * length-mismatched buffers, so guard on length first (the length itself is not
 * secret — the token bytes are). Avoids leaking the token via response-timing on
 * the loopback auth check.
 */
function tokensMatch(presented: string, expected: string): boolean {
    const a = Buffer.from(presented, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

function bearerToken(req: Request): string {
    const auth = req.headers.get("authorization");
    return typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "") : "";
}

function websocketToken(req: Request): string {
    const headerToken = bearerToken(req);
    if (headerToken) return headerToken;
    // v0.32 TUI clients put the token in the upgrade URL. Keep this fallback only
    // for the v0.32→v0.32.1 skew window; remove it when v0.32 clients are unsupported.
    return new URL(req.url).searchParams.get("token") ?? "";
}

/**
 * Plugin-private localhost RPC server for TUI ↔ server-plugin communication.
 *
 * Runs on Bun (the OpenCode server runner is a Bun Worker), so it uses
 * `Bun.serve` to host BOTH:
 *  - HTTP request/reply routes (`/health`, `/rpc/<method>`) — the TUI's snapshot
 *    and dialog-result calls, which are event-driven, not idle; and
 *  - a WebSocket endpoint (`/ws`) — a single persistent connection per TUI over
 *    which the server PUSHES notifications (dialog/toast actions). This replaces
 *    the old 500ms HTTP poll, whose new-connection-per-tick cost was the source
 *    of idle TUI CPU (#200). Pi never imports this module, so `Bun.serve` is safe.
 */
export class MagicContextRpcServer {
    private server: Server<WsData> | null = null;
    private port = 0;
    private handlers = new Map<string, RpcHandler>();
    private portFilePath: string;
    private portDir: string;
    private startedAt = Date.now();
    private readonly instanceId = randomBytes(8).toString("hex");
    private unregisterOwnInstance: (() => void) | null = null;
    /** Every authenticated WS socket, so dispose can close them all. */
    private sockets = new Set<ServerWebSocket<WsData>>();
    // Unguessable per-process bearer token, published in the (user-private) port
    // file and required on every non-health RPC call AND in the WS hello. Defends
    // side-effecting endpoints (recomp/upgrade/dismiss) and the push channel
    // against any local process or browser-origin script that merely
    // discovers/guesses the port.
    private readonly token = randomBytes(32).toString("hex");

    constructor(storageDir: string, directory: string) {
        this.portFilePath = rpcPortFilePath(storageDir, directory, process.pid, this.instanceId);
        this.portDir = rpcPortDir(storageDir, directory);
    }

    /** Register an RPC method handler. */
    handle(method: string, handler: RpcHandler): void {
        this.handlers.set(method, handler);
    }

    /**
     * Run a registered handler from inside this process, skipping the HTTP hop.
     *
     * A caller that already lives in the server process (a host command callback,
     * for instance) must reach exactly the handler the TUI reaches over HTTP, so
     * the two entry points cannot drift apart. The loopback socket, its bearer
     * token and JSON encoding add nothing here, so they are skipped rather than
     * paid for; an unknown method is still an error, as it is over HTTP.
     */
    async dispatch(
        method: string,
        params: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        const handler = this.handlers.get(method);
        if (!handler) return { error: `Unknown method: ${method}` };
        return handler(params);
    }

    /** Start the server on a random port, write port to disk. */
    async start(): Promise<number> {
        if (typeof Bun === "undefined") {
            // The only RPC consumer is the terminal-TUI sidebar, which exists only
            // under the Bun runtime (OpenCode CLI). On Node/Electron (Desktop) there
            // is no consumer, and Bun.serve would throw — skip cleanly instead of
            // logging a misleading boot error.
            log("rpc server skipped: Bun runtime not available (no TUI consumer)");
            return 0;
        }
        this.startedAt = Date.now();
        const self = this;
        const server = Bun.serve<WsData>({
            port: 0,
            hostname: "127.0.0.1",
            fetch(req, srv) {
                return self.handleFetch(req, srv);
            },
            websocket: {
                open(ws) {
                    // Close the socket if it doesn't authenticate promptly. A
                    // never-authenticated socket holds no sink and is harmless,
                    // but we don't want to keep raw connections open forever.
                    ws.data.authTimer = setTimeout(() => {
                        if (!ws.data.authed) ws.close(WS_CLOSE_UNAUTHORIZED, "auth timeout");
                    }, WS_AUTH_TIMEOUT_MS);
                },
                message(ws, raw) {
                    self.handleWsMessage(ws, raw);
                },
                close(ws) {
                    if (ws.data.authTimer) clearTimeout(ws.data.authTimer);
                    ws.data.unregister?.();
                    self.sockets.delete(ws);
                },
            },
        });

        this.server = server;
        this.port = server.port ?? 0;

        // Write a per-instance port file atomically. Multi-instance OpenCode is
        // supported: TUI discovery scans all live files and picks the most
        // recent instead of cross-wiring via one shared project file.
        try {
            void this.warnIfOtherLiveInstance();
            const dir = dirname(this.portFilePath);
            // The port file carries the RPC bearer token. The normal policy keeps
            // it owner-only; a trusted-group deployment explicitly delegates every
            // storage mode to its operator, so this path must not chmod or supply a
            // restrictive creation mode in that case.
            const enforcePrivatePermissions = shouldEnforcePrivateStoragePermissions();
            if (enforcePrivatePermissions) {
                mkdirSync(dir, { recursive: true, mode: 0o700 });
                try {
                    chmodSync(dir, 0o700);
                } catch {
                    // Continue RPC startup when directory tightening is rejected.
                }
            } else {
                mkdirSync(dir, { recursive: true });
            }
            // Registered before the file appears, so the storage migration guard in
            // this process never sees its own discovery file as another live host.
            this.unregisterOwnInstance ??= registerOwnRpcServerInstance(this.instanceId);
            const tmpPath = `${this.portFilePath}.tmp`;
            // A stale tmp from a crashed write could exist with loose perms;
            // writeFileSync's mode only applies on create, so remove it first.
            try {
                rmSync(tmpPath, { force: true });
            } catch {
                // best-effort
            }
            // Synchronous write so the renameSync below sees a fully-written file.
            // The private mode keeps the bearer token out of other local accounts;
            // externally managed storage intentionally leaves its mode to the umask.
            writeFileSync(
                tmpPath,
                JSON.stringify({
                    port: this.port,
                    pid: process.pid,
                    started_at: this.startedAt,
                    kind: "OpenCode server",
                    token: this.token,
                    instance_id: this.instanceId,
                }),
                enforcePrivatePermissions
                    ? { encoding: "utf-8", mode: 0o600 }
                    : { encoding: "utf-8" },
            );
            renameSync(tmpPath, this.portFilePath);
            if (enforcePrivatePermissions) {
                try {
                    chmodSync(this.portFilePath, 0o600);
                } catch {
                    // Continue RPC startup when port-file tightening is rejected.
                }
            }
            log(`[rpc] server listening on 127.0.0.1:${this.port}`);
        } catch (err) {
            log(`[rpc] failed to write port file: ${err}`);
        }

        return this.port;
    }

    /** Stop the server: close every socket, stop accepting, remove port file. */
    stop(): void {
        for (const ws of this.sockets) {
            try {
                if (ws.data.authTimer) clearTimeout(ws.data.authTimer);
                ws.data.unregister?.();
                ws.close();
            } catch {
                // best-effort
            }
        }
        this.sockets.clear();
        if (this.server) {
            // `stop(true)` closes active connections too, not just the listener.
            this.server.stop(true);
            this.server = null;
        }
        try {
            unlinkSync(this.portFilePath);
        } catch {
            // Intentional: port file may already be gone
        }
        this.unregisterOwnInstance?.();
        this.unregisterOwnInstance = null;
    }

    private async warnIfOtherLiveInstance(): Promise<void> {
        try {
            for (const entry of readdirSync(this.portDir)) {
                if (!entry.startsWith("port-") || !entry.endsWith(".json")) continue;
                const record = parseRpcPortFile(readFileSync(`${this.portDir}/${entry}`, "utf-8"));
                if (!record || record.pid === process.pid) continue;
                const processes = await inspectProcessesAsync();
                if (processes.liveness(record.pid) !== "alive") continue;
                log(
                    `[rpc] another Magic Context RPC server is active for this project (pid ${record.pid}, port ${record.port}); starting separate instance on a new port`,
                );
                return;
            }
        } catch {
            // No discovery directory yet, or unreadable stale file. Not fatal.
        }
    }

    /** HTTP route handler (Bun fetch). Returns a Response, or undefined when the
     *  request was upgraded to a WebSocket. */
    private async handleFetch(req: Request, srv: Server<WsData>): Promise<Response | undefined> {
        const url = new URL(req.url);

        // WebSocket upgrade — the persistent push channel. Authenticate before
        // `srv.upgrade` so an unauthorized request never becomes a live socket.
        if (url.pathname === "/ws") {
            if (!tokensMatch(websocketToken(req), this.token)) {
                return new Response("Unauthorized", { status: 401 });
            }
            const ok = srv.upgrade(req, { data: { authed: false } });
            if (ok) return undefined;
            return new Response("upgrade failed", { status: 400 });
        }

        // No wildcard CORS: the only legitimate client is the in-process TUI
        // client, not a browser origin.
        if (req.method === "GET" && url.pathname === "/health") {
            return json({ ok: true, pid: process.pid, instance_id: this.instanceId });
        }

        if (req.method !== "POST" || !url.pathname.startsWith("/rpc/")) {
            return new Response("Not Found", { status: 404 });
        }

        // Require the per-process bearer token on every side-effecting call.
        if (!tokensMatch(bearerToken(req), this.token)) {
            return json({ error: "Unauthorized" }, 401);
        }

        const method = url.pathname.slice(5); // strip "/rpc/"
        const handler = this.handlers.get(method);
        if (!handler) {
            return json({ error: `Unknown method: ${method}` }, 404);
        }

        const bodyText = await req.text();
        if (bodyText.length > MAX_BODY_BYTES) {
            return new Response("Request too large", { status: 413 });
        }
        let params: Record<string, unknown> = {};
        if (bodyText.length > 0) {
            try {
                params = JSON.parse(bodyText);
            } catch {
                return json({ error: "Invalid JSON" }, 400);
            }
        }

        try {
            const result = await handler(params);
            return json(result);
        } catch (err) {
            log(`[rpc] handler error: ${method} => ${err}`);
            return json({ error: String(err) }, 500);
        }
    }

    /** WS message handler: hello (auth + sink registration + backlog delivery) and
     *  ack (exact removal or legacy cursor pruning). All other messages are ignored. */
    private handleWsMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
        let msg: {
            type?: string;
            token?: string;
            sessionId?: string;
            lastReceivedId?: number;
            globalLastReceivedId?: number;
            ackScope?: string;
            protocol?: number;
            instanceId?: string;
            ids?: unknown;
            cursor?: number;
        };
        try {
            msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
        } catch {
            return;
        }

        if (msg.type !== "hello" && !ws.data.authed) return;

        if (msg.type === "hello") {
            if (!tokensMatch(typeof msg.token === "string" ? msg.token : "", this.token)) {
                ws.send(JSON.stringify({ type: "error", error: "unauthorized" }));
                ws.close(WS_CLOSE_UNAUTHORIZED, "bad token");
                return;
            }
            if (ws.data.authTimer) {
                clearTimeout(ws.data.authTimer);
                ws.data.authTimer = undefined;
            }
            ws.data.authed = true;
            ws.data.sessionId =
                typeof msg.sessionId === "string" && msg.sessionId.length > 0
                    ? msg.sessionId
                    : undefined;

            // A session switch re-sends hello on the same socket. Remove the old
            // sink first so the registry has exactly one live sink per socket.
            ws.data.unregister?.();
            ws.data.unregister = undefined;

            // Register a live sink so future pushes reach this socket immediately.
            const sink: NotificationSink = {
                sessionId: ws.data.sessionId,
                protocol: msg.protocol,
                send: (notification) => {
                    ws.send(JSON.stringify({ type: "notification", notification }));
                },
            };
            ws.data.unregister = registerNotificationSink(sink);
            this.sockets.add(ws);

            const usesExactAcknowledgements = msg.protocol === 2;
            // The epoch arrives before backlog frames so the client can discard
            // cursors and deduplication entries from a replaced server first.
            ws.send(
                JSON.stringify({
                    type: "hello-ack",
                    protocol: 2,
                    instanceId: this.instanceId,
                }),
            );

            let backlog: ReturnType<typeof drainNotifications>;
            if (usesExactAcknowledgements) {
                // Protocol 2 never treats a high handled id as proof that lower ids
                // were consumed. Exact acknowledgements are the only destructive
                // operation, so declined or interrupted dialogs survive reconnects.
                backlog =
                    ws.data.sessionId === undefined
                        ? drainNotifications(0, undefined, { globalOnly: true })
                        : drainNotifications(0, ws.data.sessionId, {
                              globalLastReceivedId: 0,
                          });
            } else {
                // Legacy clients use independent session and global watermarks.
                const lastReceivedId = Number(msg.lastReceivedId ?? 0);
                const sessionCursor = Number.isFinite(lastReceivedId) ? lastReceivedId : 0;
                const hasGlobalCursor = typeof msg.globalLastReceivedId === "number";
                const globalLastReceivedId = hasGlobalCursor
                    ? Number.isFinite(msg.globalLastReceivedId)
                        ? msg.globalLastReceivedId
                        : 0
                    : 0;
                backlog =
                    ws.data.sessionId === undefined && hasGlobalCursor
                        ? drainNotifications(globalLastReceivedId, undefined, { globalOnly: true })
                        : drainNotifications(
                              sessionCursor,
                              ws.data.sessionId,
                              hasGlobalCursor
                                  ? { globalLastReceivedId: globalLastReceivedId }
                                  : undefined,
                          );
            }
            for (const notification of backlog) {
                ws.send(JSON.stringify({ type: "notification", notification }));
            }
            return;
        }

        if (msg.type === "ack") {
            if (Array.isArray(msg.ids)) {
                acknowledgeNotifications(
                    msg.ids.filter((id): id is number => typeof id === "number"),
                );
                return;
            }

            // Keep watermark acknowledgements during the one-release skew window.
            // Scope isolation remains mandatory for these legacy messages.
            const lastReceivedId = Number(msg.cursor ?? msg.lastReceivedId ?? 0);
            if (Number.isFinite(lastReceivedId) && lastReceivedId > 0) {
                if (msg.ackScope === "global") {
                    drainNotifications(lastReceivedId, undefined, { globalOnly: true });
                } else if (typeof msg.sessionId === "string" && msg.sessionId.length > 0) {
                    drainNotifications(lastReceivedId, msg.sessionId, { sessionOnly: true });
                } else {
                    // Compatibility path for older clients that only know one
                    // cursor for their current socket scope.
                    drainNotifications(lastReceivedId, ws.data.sessionId);
                }
            }
        }
    }
}

/** JSON Response helper. */
function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

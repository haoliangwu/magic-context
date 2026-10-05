import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    isPidAlive,
    legacyRpcPortFilePath,
    parseRpcPortFile,
    type RpcPortFileRecord,
    rpcPortDirsForLookup,
} from "./rpc-utils";

const MAX_RETRIES = 10;
const RETRY_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 5000;
const MAX_RERESOLVE_ATTEMPTS = 3;
const NON_RETRYABLE_RPC_ERROR = Symbol("nonRetryableRpcError");
type NonRetryableRpcError = Error & { [NON_RETRYABLE_RPC_ERROR]: true };

/** No live RPC server was found for the client's directory, after every retry. */
export class RpcServerNotFoundError extends Error {
    constructor() {
        super("Magic Context RPC server not available");
        this.name = "RpcServerNotFoundError";
    }
}

export interface MagicContextRpcClientOptions {
    /** Discovery directories to read instead of the ones derived from `directory`. */
    readonly portDirs?: readonly string[];
    /** Port-file passes per resolution (default 10, 500 ms apart). */
    readonly resolveAttempts?: number;
    /** Resolutions per call before giving up (default 3). */
    readonly reresolveAttempts?: number;
}

export class MagicContextRpcClient {
    private port: number | null = null;
    private token: string | null = null;
    private instanceId: string | null = null;
    private readonly portDirs: readonly string[];
    private legacyPortFilePath: string;
    private healthChecked = false;
    private readonly resolveAttempts: number;
    private readonly reresolveAttempts: number;

    constructor(storageDir: string, directory: string, options: MagicContextRpcClientOptions = {}) {
        this.portDirs = options.portDirs ?? rpcPortDirsForLookup(storageDir, directory);
        this.legacyPortFilePath = legacyRpcPortFilePath(storageDir, directory);
        this.resolveAttempts = options.resolveAttempts ?? MAX_RETRIES;
        this.reresolveAttempts = options.reresolveAttempts ?? MAX_RERESOLVE_ATTEMPTS;
    }

    /**
     * Find the live server that owns `sessionId` by asking every server that
     * has a discovery file under `storageDir`. The fallback for a session whose
     * directory spelling matches no discovery directory: an empty sidebar is
     * worse than one scan of the local servers. Null when none claims it.
     */
    static async findSessionOwner(
        storageDir: string,
        sessionId: string,
    ): Promise<MagicContextRpcClient | null> {
        const rpcRoot = join(storageDir, "rpc");
        let projectDirs: string[];
        try {
            projectDirs = readdirSync(rpcRoot).map((entry) => join(rpcRoot, entry));
        } catch {
            return null;
        }
        for (const portDir of projectDirs) {
            const candidate = new MagicContextRpcClient(storageDir, "", {
                portDirs: [portDir],
                resolveAttempts: 1,
                reresolveAttempts: 1,
            });
            try {
                const reply = await candidate.call<{ owner?: unknown }>("session-owner", {
                    sessionId,
                });
                if (reply.owner === true) return candidate;
            } catch {
                // Not running, unreachable, or an older server without the method.
            }
        }
        return null;
    }

    /** Call an RPC method. Retries port resolution if the server isn't ready yet. */
    async call<T = Record<string, unknown>>(
        method: string,
        params: Record<string, unknown> = {},
    ): Promise<T> {
        let lastError: unknown = null;

        for (let attempt = 0; attempt < this.reresolveAttempts; attempt++) {
            const port = await this.resolvePort();
            if (!port) {
                lastError = new RpcServerNotFoundError();
                this.reset();
                continue;
            }

            try {
                const response = await this.fetchWithTimeout(
                    `http://127.0.0.1:${port}/rpc/${method}`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            // The server requires this per-process token on all
                            // non-health calls; read from the same port file used
                            // for discovery. Older servers wrote no token — send
                            // nothing then (they also require nothing).
                            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
                        },
                        body: JSON.stringify(params),
                    },
                );

                if (!response.ok) {
                    const text = await response.text();
                    const error = new Error(`RPC ${method} failed (${response.status}): ${text}`);
                    if (response.status === 401 || response.status >= 500) {
                        lastError = error;
                        this.reset();
                        continue;
                    }
                    (error as NonRetryableRpcError)[NON_RETRYABLE_RPC_ERROR] = true;
                    throw error;
                }

                return (await response.json()) as T;
            } catch (err) {
                if (isNonRetryableRpcError(err)) {
                    throw err;
                }
                lastError = err;
                this.reset();
            }
        }

        if (lastError instanceof Error) {
            throw lastError;
        }
        throw new RpcServerNotFoundError();
    }

    /** Check if the RPC server is reachable. */
    async isAvailable(): Promise<boolean> {
        try {
            const port = await this.resolvePort();
            return port !== null;
        } catch {
            return false;
        }
    }

    /** Resolve the live server's port + bearer token (for opening the WS push
     *  channel). Reuses the same health-checked port-file discovery as `call`,
     *  so the WS client and the HTTP client always agree on which server instance
     *  (and token) to use. Returns null when no live server is found. */
    async resolveEndpoint(): Promise<{
        port: number;
        token: string | null;
        instanceId: string | null;
    } | null> {
        try {
            // The socket owns reconnect backoff, so endpoint discovery performs one
            // filesystem/health pass instead of nesting the HTTP client's retries.
            const port = await this.resolvePort(1);
            if (port === null) return null;
            return { port, token: this.token, instanceId: this.instanceId };
        } catch {
            return null;
        }
    }

    private async resolvePort(maxAttempts = this.resolveAttempts): Promise<number | null> {
        if (this.port && this.healthChecked) {
            return this.port;
        }

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            for (const record of this.readPortFiles()) {
                if (!(await this.healthCheck(record))) continue;
                this.port = record.port;
                this.token = record.token ?? null;
                this.instanceId = record.instance_id ?? null;
                this.healthChecked = true;
                return record.port;
            }

            this.reset();
            if (attempt < maxAttempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
            }
        }

        return null;
    }

    private readPortFiles(): RpcPortFileRecord[] {
        const records: RpcPortFileRecord[] = [];

        for (const portDir of this.portDirs) {
            try {
                for (const entry of readdirSync(portDir)) {
                    if (!entry.startsWith("port-") || !entry.endsWith(".json")) continue;
                    const record = parseRpcPortFile(readFileSync(join(portDir, entry), "utf-8"));
                    // A denied liveness probe still leaves this as a candidate; the
                    // mandatory health check below confirms whether its RPC server is reachable.
                    if (!record || isPidAlive(record.pid) === "dead") continue;
                    records.push(record);
                }
            } catch {
                // Directory may not exist yet. Fall back to the legacy file below.
            }
        }

        try {
            const legacy = parseRpcPortFile(readFileSync(this.legacyPortFilePath, "utf-8"));
            if (legacy && (!legacy.pid || isPidAlive(legacy.pid) !== "dead")) records.push(legacy);
        } catch {
            // Legacy discovery is optional.
        }

        // A TUI and its server plugin normally share a process. Prefer that exact
        // process before considering another live OpenCode instance for the project.
        records.sort((a, b) => {
            const aLocal = a.pid === process.pid ? 1 : 0;
            const bLocal = b.pid === process.pid ? 1 : 0;
            return bLocal - aLocal || b.started_at - a.started_at;
        });
        return records;
    }

    private async healthCheck(record: RpcPortFileRecord): Promise<boolean> {
        try {
            const response = await this.fetchWithTimeout(`http://127.0.0.1:${record.port}/health`, {
                method: "GET",
            });
            if (!response.ok) return false;
            const body = (await response.json()) as { pid?: unknown; instance_id?: unknown };
            if (body.pid !== record.pid) return false;
            // v0.32 health responses predate instance ids. A missing id is the
            // one-release discovery bridge; an id that is present must still match.
            return (
                body.instance_id === undefined ||
                record.instance_id === undefined ||
                body.instance_id === record.instance_id
            );
        } catch {
            return false;
        }
    }

    private async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timeout);
        }
    }

    reset(): void {
        this.port = null;
        this.token = null;
        this.instanceId = null;
        this.healthChecked = false;
    }
}

function isNonRetryableRpcError(err: unknown): err is NonRetryableRpcError {
    return typeof err === "object" && err !== null && NON_RETRYABLE_RPC_ERROR in err;
}

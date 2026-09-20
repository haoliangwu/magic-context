/**
 * TestHarness — one-stop facade for end-to-end scenarios.
 *
 * Wraps the mock Anthropic server, the `opencode serve` subprocess, and the SDK client
 * into a single object. Also exposes helpers for inspecting both OpenCode's database
 * and magic-context's `context.db` so tests can assert on persisted state.
 *
 * Usage:
 *
 *   const h = await TestHarness.create({ magicContextConfig: { execute_threshold_percentage: 40 } });
 *   h.mock.script([{ text: "ok", usage: { input_tokens: 100, output_tokens: 10 } }]);
 *   const sessionId = await h.createSession();
 *   await h.sendPrompt(sessionId, "hello");
 *   expect(h.mock.requests().length).toBe(1);
 *   await h.dispose();
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HostCapabilities, HostHarness } from "./host-harness";
import { assertHistorianMockRouting } from "./mock-routing";
import { MockProvider, type MockResponse } from "./mock-provider/server";
import { spawnOpencode, type SpawnedOpencode, type SpawnOptions } from "./opencode-runner/spawn";

export interface TestHarnessOptions {
    /** magic-context config overrides. Merged onto test defaults. */
    magicContextConfig?: Record<string, unknown>;
    /** Extra opencode.json config. Merged onto test defaults. */
    openCodeConfigExtra?: Record<string, unknown>;
    /** Override the mock model's context token limit. Default 200000. */
    modelContextLimit?: number;
    /** Set false only when the test intentionally verifies conflict-based self-disable behavior. */
    expectMagicContext?: boolean;
    /** Debug harnesses may boot the plugin with hooks configured off while retaining diagnostics. */
    expectedMagicContextState?: "enabled" | "configured-disabled" | "conflict-disabled";
    /**
     * Default response used when the mock queue is empty. Lets tests send extra
     * prompts without worrying about scripting every one.
     */
    mockDefault?: MockResponse;
}

export interface SdkClient {
    session: {
        create: (opts: {
            query: { directory: string };
            body?: { parentID?: string; title?: string };
        }) => Promise<{ data?: { id: string } }>;
        prompt: (opts: {
            path: { id: string };
            body: {
                model: { providerID: string; modelID: string };
                parts: Array<{ type: "text"; text: string }>;
                agent?: string;
            };
        }) => Promise<{ data?: unknown; error?: unknown }>;
    };
}

const DEFAULT_MOCK_RESPONSE: MockResponse = {
    text: "ok",
    usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 0,
    },
};

export class TestHarness implements HostHarness {
    readonly host = "opencode" as const;
    readonly harnessId = "opencode" as const;
    readonly capabilities: HostCapabilities = {
        childSessions: true,
        nativeCompact: true,
        sessionRemove: true,
        steerDelivery: false,
    };
    readonly mock: MockProvider;

    private opencodeInstance: SpawnedOpencode;
    private clientInstance: SdkClient;
    private contextDbCached: Database | null = null;
    private readonly expectMagicContext: boolean;
    private readonly spawnOptions: SpawnOptions;

    private constructor(
        mock: MockProvider,
        opencode: SpawnedOpencode,
        client: SdkClient,
        expectMagicContext: boolean,
        spawnOptions: SpawnOptions,
    ) {
        this.mock = mock;
        this.opencodeInstance = opencode;
        this.clientInstance = client;
        this.expectMagicContext = expectMagicContext;
        this.spawnOptions = spawnOptions;
    }

    get opencode(): SpawnedOpencode {
        return this.opencodeInstance;
    }

    get client(): SdkClient {
        return this.clientInstance;
    }

    /** Provides Rust-mode-only access to the historian and status interfaces running in the module's Rust stack. */
    get rustStack(): SpawnedOpencode["rustStack"] {
        return this.opencodeInstance.rustStack;
    }

    static async create(options: TestHarnessOptions = {}): Promise<TestHarness> {
        const mock = new MockProvider();
        const { baseURL } = await mock.start();

        // Always install a default so unexpected extra requests don't 500.
        mock.setDefault(options.mockDefault ?? DEFAULT_MOCK_RESPONSE);

        const expectedMagicContextState =
            options.expectedMagicContextState ??
            (options.expectMagicContext === false ? "conflict-disabled" : "enabled");
        const expectMagicContext = expectedMagicContextState === "enabled";
        const spawnOpts: SpawnOptions = {
            mockProviderURL: baseURL,
            magicContextConfig: options.magicContextConfig,
            openCodeConfigExtra: options.openCodeConfigExtra,
            modelContextLimit: options.modelContextLimit,
            prepareContextDatabase: expectMagicContext,
            expectedMagicContextState,
        };
        let opencode: SpawnedOpencode | undefined;
        try {
            opencode = await spawnOpencode(spawnOpts);
            const sdk = await import("@opencode-ai/sdk");
            const client = sdk.createOpencodeClient({ baseUrl: opencode.url }) as unknown as SdkClient;
            return new TestHarness(mock, opencode, client, expectMagicContext, spawnOpts);
        } catch (error) {
            await Promise.allSettled([opencode?.kill() ?? Promise.resolve(), mock.stop()]);
            throw error;
        }
    }

    /** Restart OpenCode with the same isolated files and user config. */
    async restart(): Promise<void> {
        if (this.contextDbCached) {
            try {
                this.contextDbCached.close();
            } catch {
                // ignore close errors in test helpers
            }
            this.contextDbCached = null;
        }
        const env = this.opencodeInstance.env;
        await this.opencodeInstance.kill();
        this.opencodeInstance = await spawnOpencode({
            ...this.spawnOptions,
            existingEnv: env,
        });
        const sdk = await import("@opencode-ai/sdk");
        this.clientInstance = sdk.createOpencodeClient({
            baseUrl: this.opencodeInstance.url,
        }) as unknown as SdkClient;
    }

    /** Create a session bound to the isolated workdir. Throws on failure. */
    async createSession(): Promise<string> {
        return this.createSessionWithRetry(
            () => this.client.session.create({ query: { directory: this.opencode.env.workdir } }),
            "session.create",
        );
    }

    /**
     * Post a session.create and retry the transient warmup failure where the
     * server reports ready on `/doc` but its session route briefly returns an
     * empty body under load (no `res.data`). This is harness readiness gating,
     * not a product retry: no session exists yet, so nothing under test has run.
     * A persistent failure (server actually down) still throws with captured
     * stderr/stdout after the attempts are exhausted.
     */
    private async createSessionWithRetry(
        attempt: () => Promise<{ data?: { id: string } | null }>,
        label: string,
    ): Promise<string> {
        const maxAttempts = 5;
        for (let i = 1; i <= maxAttempts; i++) {
            const res = await attempt();
            if (res.data) return res.data.id;
            if (i < maxAttempts) {
                await Bun.sleep(200 * i);
                continue;
            }
            throw new Error(
                `${label} failed after ${maxAttempts} attempts. stderr:\n${this.opencode.stderr()}\nstdout:\n${this.opencode.stdout()}`,
            );
        }
        // Unreachable: the loop either returns an id or throws.
        throw new Error(`${label} failed`);
    }

    /**
     * Create a child session (subagent) with the given parent. Mirrors what
     * OpenCode's `task` tool does internally: posts to /session with a
     * `parentID` body. The plugin's event-handler reads `parentID` from the
     * `session.created` event and marks the row `isSubagent=true`.
     *
     * Use this to drive subagent-specific behavior: reduced feature mode,
     * heuristic cleanup without historian, no 85%/95% emergency paths, no
     * nudges, no §N§ prefix injection.
     */
    async createChildSession(parentId: string, title?: string): Promise<string> {
        return this.createSessionWithRetry(
            () =>
                this.client.session.create({
                    query: { directory: this.opencode.env.workdir },
                    body: { parentID: parentId, ...(title ? { title } : {}) },
                }),
            "child session.create",
        );
    }

    /**
     * Read the persisted `isSubagent` flag for a session from context.db.
     * Returns null if the session_meta row doesn't exist yet (plugin may not
     * have processed the `session.created` event yet — wait with `waitFor`).
     */
    isSubagent(sessionId: string): boolean | null {
        try {
            const db = this.contextDb();
            const row = db
                .prepare("SELECT is_subagent FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { is_subagent: number } | null;
            if (!row) return null;
            return row.is_subagent === 1;
        } catch {
            return null;
        }
    }

    /**
     * Count tags in a specific status for a session. Status is one of
     * "active" | "dropped" (magic-context's TagStatus). Useful for
     * verifying heuristic cleanup actually dropped tool tags.
     */
    countTagsByStatus(sessionId: string, status: string): number {
        try {
            const db = this.contextDb();
            const row = db
                .prepare(
                    "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = ?",
                )
                .get(sessionId, status) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    /**
     * Send a user prompt. Returns the raw prompt response.
     * Default model routes to our mock-anthropic provider. Callers can override.
     */
    /**
     * Generate ~`tokens` tokens of varied, realistic prose ballast.
     *
     * The protected-tail boundary (v3) is SIZE-based: it measures the true-raw
     * token content of the session, not the mock's fabricated usage numbers.
     * Tests that fake pressure (90K `input_tokens` on a session whose actual
     * text is a few hundred tokens) leave the boundary with no eligible head —
     * the historian can never start, which is correct behavior for that
     * (production-unreachable) state. Pressure-driving turns must therefore
     * carry real content mass: `sendPrompt(id, prefix + h.ballast(N))`.
     *
     * Varied word bank (not single-char repeats): BPE tokenizers degrade
     * pathologically on degenerate repeats, and varied prose tokenizes at a
     * stable ~4 chars/token so the size math holds.
     */
    ballast(tokens: number): string {
        const words = [
            "boundary", "historian", "compartment", "schedule", "pressure",
            "tokens", "window", "publish", "transform", "session", "marker",
            "budget", "eligible", "protected", "ordinal", "snapshot", "replay",
            "decision", "threshold", "baseline", "measure", "archive", "deliver",
        ];
        const target = Math.max(0, Math.round(tokens * 4)); // ~4 chars/token
        const parts: string[] = [];
        let length = 0;
        let i = 0;
        while (length < target) {
            const w = words[i % words.length];
            parts.push(`${w}${i % 17 === 0 ? "." : ""}`);
            length += w.length + 1;
            i += 1;
        }
        return parts.join(" ");
    }

    async sendPrompt(
        sessionId: string,
        text: string,
        options: {
            modelID?: string;
            providerID?: string;
            agent?: string;
            timeoutMs?: number;
        } = {},
    ): Promise<unknown> {
        // Default bumped from 30s → 180s. CI runners (GitHub-hosted ubuntu)
        // can take 10-30s just for opencode serve to process a single prompt
        // when historian/compressor work is involved. 180s leaves room for
        // multi-step assistant turns while still catching genuinely stuck
        // prompts. Individual tests can still pass a smaller timeoutMs.
        const timeoutMs = options.timeoutMs ?? 180_000;
        const promptPromise = this.client.session.prompt({
            path: { id: sessionId },
            body: {
                model: {
                    providerID: options.providerID ?? "mock-anthropic",
                    modelID: options.modelID ?? "mock-sonnet",
                },
                parts: [{ type: "text", text }],
                ...(options.agent ? { agent: options.agent } : {}),
            },
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
        });
        const result = await Promise.race([promptPromise, timeout]).finally(() => clearTimeout(timer));
        if (result === null) {
            throw new Error(
                `sendPrompt did not complete within ${timeoutMs}ms. stderr:\n${this.opencode.stderr().slice(-2000)}`,
            );
        }
        if (result.data === undefined) {
            throw new Error(
                `sendPrompt returned without session data: ${JSON.stringify(result.error ?? null)}\n` +
                    `stdout:\n${this.opencode.stdout().slice(-2000)}\n` +
                    `stderr:\n${this.opencode.stderr().slice(-2000)}`,
            );
        }
        // OpenCode returns provider failures inside a successful HTTP/SDK envelope.
        // Presence of session data does not prove that the assistant answered.
        const assistant = result.data as { info?: { error?: unknown } } | null;
        if (assistant?.info?.error) {
            throw new Error(`sendPrompt assistant error: ${JSON.stringify(assistant.info.error)}`);
        }
        this.assertMagicContextProcessed(sessionId);
        return result;
    }

    /**
     * Require durable evidence that Magic Context processed this exact OpenCode session.
     * A successful provider reply alone can belong to an uninstrumented or delayed path.
     */
    assertMagicContextProcessed(sessionId: string): void {
        if (!this.expectMagicContext) return;
        const processed = this
            .contextDb()
            .prepare("SELECT 1 FROM session_meta WHERE session_id = ?")
            .get(sessionId);
        if (!processed) {
            throw new Error(`OpenCode Magic Context did not process session ${sessionId}`);
        }
    }

    /**
     * Wait until every captured provider request has answered and no new request
     * arrives during a short quiet window. Call this before replacing mock routes
     * or selecting a final capture so delayed background work cannot cross phases.
     */
    async waitForMockQuiescence(opts: { quietMs?: number; label?: string } = {}): Promise<void> {
        const quietMs = opts.quietMs ?? 250;
        let stableRequestCount: number | null = null;
        let quietSince = 0;
        await this.waitFor(
            () => {
                const requests = this.mock.requests();
                const allResponsesCompleted = requests.every(
                    (request) => request.responseCompletedAt !== undefined,
                );
                if (!allResponsesCompleted) {
                    stableRequestCount = null;
                    return false;
                }
                if (stableRequestCount !== requests.length) {
                    stableRequestCount = requests.length;
                    quietSince = Date.now();
                    return false;
                }
                return Date.now() - quietSince >= quietMs;
            },
            {
                intervalMs: Math.min(50, quietMs),
                label: opts.label ?? "mock provider quiescence",
            },
        );
    }

    /**
     * Open the magic-context SQLite database in read-only mode.
     * Cached per harness so repeated calls share the handle.
     */
    contextDb(): Database {
        if (this.contextDbCached) return this.contextDbCached;
        // Plugin v0.16+ uses the shared cortexkit/magic-context path so OpenCode
        // and Pi can share state. See packages/plugin/src/shared/data-path.ts.
        const dbPath = join(
            this.opencode.env.dataDir,
            "cortexkit",
            "magic-context",
            "context.db",
        );
        if (!existsSync(dbPath)) {
            throw new Error(`context.db not found at ${dbPath} — plugin may not have initialized yet.`);
        }
        this.contextDbCached = new Database(dbPath, { readonly: true });
        return this.contextDbCached;
    }

    /** Whether the plugin has created its database yet. */
    hasContextDb(): boolean {
        const dbPath = join(
            this.opencode.env.dataDir,
            "cortexkit",
            "magic-context",
            "context.db",
        );
        return existsSync(dbPath);
    }

    /** Poll until `predicate` returns true or `timeoutMs` elapses. */
    async waitFor<T>(
        predicate: () => T | null | undefined | false,
        opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
    ): Promise<T> {
        // Default bumped from 10s → 60s for CI. waitFor is called by tests
        // to poll for DB rows / queued ops to appear; on CI shared runners
        // there can be material latency between an event firing and the
        // SQLite row being visible. Individual tests can still pass a
        // smaller timeoutMs.
        const timeoutMs = opts.timeoutMs ?? 60_000;
        const intervalMs = opts.intervalMs ?? 100;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const value = predicate();
            if (value) return value as T;
            await Bun.sleep(intervalMs);
        }
        throw new Error(
            `waitFor timed out after ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ""}`,
        );
    }

    /**
     * Count compartments for a session. Returns 0 if the table is empty or missing.
     */
    countCompartments(sessionId: string): number {
        try {
            const db = this.contextDb();
            const row = db
                .prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?")
                .get(sessionId) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    /** Count tags for a session. Useful to verify the plugin ran at all. */
    countTags(sessionId: string): number {
        try {
            const db = this.contextDb();
            const row = db
                .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ?")
                .get(sessionId) as { n: number } | null;
            return row?.n ?? 0;
        } catch {
            return 0;
        }
    }

    /** All mock requests received in this session. */
    requests() {
        return this.mock.requests();
    }

    assertHistorianRequestsUseMock(): void {
        if (this.expectMagicContext && this.hasContextDb()) {
            assertHistorianMockRouting(this.contextDb(), "opencode", "mock-anthropic/mock-sonnet");
        }
    }

    async dispose(): Promise<void> {
        try {
            this.assertHistorianRequestsUseMock();
        } finally {
            if (this.contextDbCached) {
                try {
                    this.contextDbCached.close();
                } catch {
                    // The child still needs cleanup if a cached reader was already closed.
                }
                this.contextDbCached = null;
            }
            await this.opencode.kill();
            await this.mock.stop();
        }
    }
}

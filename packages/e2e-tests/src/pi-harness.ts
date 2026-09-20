/** PiTestHarness — facade for Pi Magic Context e2e tests. */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HostCapabilities, PiHostHarness } from "./host-harness";
import { assertHistorianMockRouting } from "./mock-routing";
import { MockProvider, type MockResponse } from "./mock-provider/server";
import { prepareContextDatabase } from "./prepare-context-db";
import {
  createPiIsolatedEnv,
  type PiIsolatedEnv,
  type PiRunnerHost,
  type PiRunResult,
} from "./pi-runner/spawn";
import {
  PiRpcClient,
  type PiMessage,
  type PiRpcEvent,
  type PiSessionStats,
  type PiState,
  requireSuccessfulResponse,
} from "./pi-runner/rpc-client";

export interface PiTestHarnessOptions {
  host?: PiRunnerHost;
  magicContextConfig?: Record<string, unknown>;
  piSettingsExtra?: Record<string, unknown>;
  modelContextLimit?: number;
  mockDefault?: MockResponse;
  extensionsBeforeMagicContext?: string[];
  /** Share the cortexkit DB with another harness. */
  sharedDataDir?: string;
  /** Optional working directory override before the persistent Pi process starts. */
  workdir?: string;
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

export class PiTestHarness implements PiHostHarness {
  readonly host: PiRunnerHost;
  readonly harnessId: PiRunnerHost;
  readonly capabilities: HostCapabilities = {
    childSessions: false,
    nativeCompact: true,
    sessionRemove: false,
    steerDelivery: true,
  };
  readonly mock: MockProvider;
  readonly env: PiIsolatedEnv;

  private readonly rpc: PiRpcClient;
  private readonly expectMagicContext: boolean;
  private contextDbCached: Database | null = null;
  private turns: PiRunResult[] = [];

  private constructor(
    host: PiRunnerHost,
    mock: MockProvider,
    rpc: PiRpcClient,
    expectMagicContext: boolean,
  ) {
    this.host = host;
    this.harnessId = host;
    this.mock = mock;
    this.rpc = rpc;
    this.env = rpc.env;
    this.expectMagicContext = expectMagicContext;
  }

  static async create(options: PiTestHarnessOptions = {}): Promise<PiTestHarness> {
    const mock = new MockProvider();
    await mock.start();
    mock.setDefault(options.mockDefault ?? DEFAULT_MOCK_RESPONSE);
    const host = options.host ?? "pi";
    const env = createPiIsolatedEnv(options.sharedDataDir, host);
    if (options.workdir) env.workdir = options.workdir;
    if (options.magicContextConfig?.enabled !== false) {
      try {
        prepareContextDatabase(env.dataDir);
      } catch (error) {
        await mock.stop();
        throw error;
      }
    }
    const rpc = new PiRpcClient({
      host,
      env,
      mockProviderURL: PiTestHarness.mockBaseURL(mock),
      magicContextConfig: options.magicContextConfig,
      piSettingsExtra: options.piSettingsExtra,
      modelContextLimit: options.modelContextLimit,
    });

    try {
      await rpc.start();
    } catch (error) {
      await Promise.allSettled([rpc.shutdown(), mock.stop()]);
      throw error;
    }

    return new PiTestHarness(host, mock, rpc, options.magicContextConfig?.enabled !== false);
  }

  /**
   * Generate ~`tokens` tokens of varied prose ballast. Mirror of
   * TestHarness.ballast (see harness.ts): the v3 protected-tail boundary
   * measures TRUE-RAW content, not mock usage numbers, so pressure-driving
   * turns must carry real content mass or the boundary resolves no eligible
   * head and the historian (correctly) never starts.
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

  async createSession(): Promise<string> {
    let state = await this.getState();
    if (!state.sessionId) {
      await this.newSession();
      state = await this.getState();
    }
    if (!state.sessionId) throw new Error(`${this.host} did not report a session id`);
    return state.sessionId;
  }

  async sendPrompt(
    text: string,
    options?: { timeoutMs?: number; continueSession?: boolean; images?: unknown[] },
  ): Promise<PiRunResult>;
  async sendPrompt(
    sessionId: string,
    text: string,
    options?: { timeoutMs?: number; continueSession?: boolean; images?: unknown[] },
  ): Promise<PiRunResult>;
  async sendPrompt(
    sessionOrText: string,
    textOrOptions: string | { timeoutMs?: number; continueSession?: boolean; images?: unknown[] } = {},
    contractOptions: { timeoutMs?: number; continueSession?: boolean; images?: unknown[] } = {},
  ): Promise<PiRunResult> {
    const contractCall = typeof textOrOptions === "string";
    const text = contractCall ? textOrOptions : sessionOrText;
    const options = contractCall ? contractOptions : textOrOptions;
    if (contractCall) {
      const state = await this.getState();
      if (state.sessionId !== sessionOrText) {
        throw new Error(
          `${this.host} prompt targeted session ${sessionOrText}, but the active session is ${state.sessionId ?? "missing"}`,
        );
      }
    }
    // Default bumped from 60s → 180s. Pi historian + ctx_search work spawn a
    // `pi --print` subprocess that calls the mock provider over HTTP, which on
    // GitHub-hosted ubuntu runners is ~3-5x slower than local hardware. 180s
    // covers the slowest known Pi paths (historian + compartment publish chain)
    // while still bounding tests. Individual call sites can pass smaller values.
    const timeoutMs = options.timeoutMs ?? 180_000;
    const events: PiRpcEvent[] = [];
    let capturing = false;
    let submittedTurnEnded = false;
    const unsubscribe = this.rpc.onEvent((event) => {
      if (event.type === "agent_start") capturing = true;
      if (capturing) events.push(event);
      if (event.type === "agent_end" && Array.isArray(event.messages)) {
        submittedTurnEnded ||= event.messages.some((message: { role?: string; content?: unknown }) => {
          if (message.role !== "user") return false;
          const content = typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content.filter((part) => part.type === "text").map((part) => part.text).join("")
              : undefined;
          return content === text;
        });
      }
    });
    // Pi emits agent_settled after extension-triggered continuations. OMP's RPC
    // protocol has no equivalent event, so its submitted agent_end is terminal.
    const agentEnd = this.rpc.waitForEvent(
      (event) =>
        submittedTurnEnded &&
        event.type === (this.host === "omp" ? "agent_end" : "agent_settled"),
      {
        timeoutMs,
        label: this.host === "omp" ? "submitted turn agent_end" : "submitted turn agent_settled",
      },
    );

    try {
      const promptResponse = await this.rpc.sendCommand(
        "prompt",
        { message: text, ...(options.images ? { images: options.images } : {}) },
        { timeoutMs, label: "prompt response" },
      );
      requireSuccessfulResponse(promptResponse);
      await agentEnd;
      const extensionErrors = this.rpc.getExtensionErrors();
      if (extensionErrors.length > 0) {
        throw new Error(`Pi extension error: ${JSON.stringify(extensionErrors)}`);
      }
      const state = await this.getState();
      const sessionId = typeof state.sessionId === "string" ? state.sessionId : null;
      // Extension diagnostics may arrive before this turn's event listener, so
      // require the durable session row rather than trusting a successful model reply.
      if (!sessionId && this.expectMagicContext) {
        throw new Error(`${this.host} did not report a session id for Magic Context verification`);
      }
      if (sessionId) this.assertMagicContextProcessed(sessionId);
      const result: PiRunResult = {
        sessionId,
        events: events as Array<Record<string, unknown>>,
        stdout: events.map((event) => JSON.stringify(event)).join("\n"),
        stderr: this.rpc.getStderr(),
        exitCode: null,
        signalCode: null,
      };
      this.turns.push(result);
      return result;
    } catch (error) {
      void agentEnd.catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n--- pi rpc stderr ---\n${this.rpc.getStderr()}`);
    } finally {
      unsubscribe();
    }
  }

  assertMagicContextProcessed(sessionId: string): void {
    if (!this.expectMagicContext) return;
    const processed = this
      .contextDb()
      .prepare("SELECT 1 FROM session_meta WHERE session_id = ? AND harness = ?")
      .get(sessionId, this.harnessId);
    if (!processed) throw new Error(`${this.host} Magic Context did not process session ${sessionId}`);
  }

  private static mockBaseURL(mock: MockProvider): string {
    const last = mock.requests()[0];
    if (last) return `http://${last.headers.host}`;
    // MockProvider doesn't expose baseURL after start; derive it from the Bun server by
    // reaching through the stable private field shape in tests.
    const server = (mock as unknown as { server?: { port?: number } }).server;
    const port = server?.port;
    if (!port) throw new Error("mock provider is not running");
    return `http://127.0.0.1:${port}`;
  }

  async getState(): Promise<PiState> {
    const response = await this.rpc.sendCommand<PiState>("get_state");
    return requireSuccessfulResponse(response);
  }

  async getMessages(): Promise<PiMessage[]> {
    const response = await this.rpc.sendCommand<{ messages: PiMessage[] }>("get_messages");
    return requireSuccessfulResponse(response).messages;
  }

  async getSessionStats(): Promise<PiSessionStats> {
    const response = await this.rpc.sendCommand<PiSessionStats>("get_session_stats");
    return requireSuccessfulResponse(response);
  }

  async compactNow(): Promise<void> {
    const response = await this.rpc.sendCommand("compact");
    requireSuccessfulResponse(response);
  }

  async compactNowExpectCancelled(): Promise<void> {
    const response = await this.rpc.sendCommand("compact");
    if (response.success || !response.error?.includes("Compaction cancelled")) {
      throw new Error(`Expected Pi compaction cancellation, received ${JSON.stringify(response)}`);
    }
  }

  async invokeExtensionCommand(command: string): Promise<void> {
    const response = await this.rpc.sendCommand("prompt", { message: `/${command}` });
    requireSuccessfulResponse(response);
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await this.getState();
      if (!state.isStreaming && !state.isCompacting) return;
      await Bun.sleep(20);
    }
    throw new Error(`Pi extension command /${command} did not settle`);
  }

  async newSession(): Promise<void> {
    const response = await this.rpc.sendCommand<{ cancelled?: boolean }>("new_session");
    const data = requireSuccessfulResponse(response);
    if (data?.cancelled) throw new Error("Pi new_session was cancelled by an extension");
  }

  /** Exercise Pi's in-process extension/resource reload without replacing the RPC process. */
  async reloadExtensions(): Promise<void> {
    const response = await this.rpc.sendCommand(
      "prompt",
      { message: "/e2e-reload-extensions" },
      { timeoutMs: 60_000, label: "Pi extension reload" },
    );
    requireSuccessfulResponse(response);
    const extensionErrors = this.rpc.getExtensionErrors();
    if (extensionErrors.length > 0) {
      throw new Error(`Pi extension reload error: ${JSON.stringify(extensionErrors)}`);
    }
  }

  /** Restart Pi and explicitly resume the same saved session. */
  async restart(): Promise<void> {
    const beforeRestart = await this.getState();
    this.closeContextDb();
    await this.rpc.restart();

    if (!beforeRestart.sessionFile) return;
    const response = await this.rpc.sendCommand<{ cancelled?: boolean }>(
      "switch_session",
      { sessionPath: beforeRestart.sessionFile },
      { timeoutMs: 60_000, label: "resume Pi session after restart" },
    );
    const resumed = requireSuccessfulResponse(response);
    if (resumed.cancelled) throw new Error("Pi session resume was cancelled by an extension");

    const afterRestart = await this.getState();
    if (beforeRestart.sessionId && afterRestart.sessionId !== beforeRestart.sessionId) {
      throw new Error(
        `Pi restart resumed session ${afterRestart.sessionId ?? "missing"}, expected ${beforeRestart.sessionId}`,
      );
    }
  }

  get lastTurn(): PiRunResult | null {
    return this.turns[this.turns.length - 1] ?? null;
  }

  contextDbPath(): string {
    return join(this.env.dataDir, "cortexkit", "magic-context", "context.db");
  }

  contextDb(): Database {
    if (this.contextDbCached) return this.contextDbCached;
    const dbPath = this.contextDbPath();
    if (!existsSync(dbPath)) throw new Error(`context.db not found at ${dbPath}`);
    this.contextDbCached = new Database(dbPath, { readonly: true });
    return this.contextDbCached;
  }

  closeContextDb(): void {
    if (!this.contextDbCached) return;
    try {
      this.contextDbCached.close();
    } catch {
      // ignore close errors in test polling helpers
    }
    this.contextDbCached = null;
  }

  hasContextDb(): boolean {
    return existsSync(this.contextDbPath());
  }

  countCompartments(sessionId: string, harness = this.harnessId): number {
    try {
      const row = this.contextDb()
        .prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ? AND harness = ?")
        .get(sessionId, harness) as { n: number } | null;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  countTags(sessionId: string, harness = this.harnessId): number {
    try {
      const row = this.contextDb()
        .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND harness = ?")
        .get(sessionId, harness) as { n: number } | null;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  countPendingOps(sessionId: string, harness = this.harnessId): number {
    try {
      const row = this.contextDb()
        .prepare("SELECT COUNT(*) AS n FROM pending_ops WHERE session_id = ? AND harness = ?")
        .get(sessionId, harness) as { n: number } | null;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  countTagsByStatus(sessionId: string, status: string, harness = this.harnessId): number {
    try {
      const row = this.contextDb()
        .prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND harness = ? AND status = ?")
        .get(sessionId, harness, status) as { n: number } | null;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  countDroppedTags(sessionId: string, harness = this.harnessId): number {
    return this.countTagsByStatus(sessionId, "dropped", harness);
  }

  async waitFor<T>(
    predicate: () => T | null | undefined | false,
    opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
  ): Promise<T> {
    // Default bumped from 10s → 60s for CI. waitFor polls for DB rows /
    // queued ops to appear; on CI shared runners there can be material
    // latency between an event firing and the SQLite row being visible.
    // Individual call sites can pass a smaller timeoutMs.
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = predicate();
      if (value) return value as T;
      await Bun.sleep(intervalMs);
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms${opts.label ? ` (${opts.label})` : ""}`);
  }

  async waitForMockQuiescence(opts: { quietMs?: number; label?: string } = {}): Promise<void> {
    const quietMs = opts.quietMs ?? 250;
    let stableRequestCount: number | null = null;
    let quietSince = 0;
    await this.waitFor(
      () => {
        const requests = this.mock.requests();
        if (requests.some((request) => request.responseCompletedAt === undefined)) {
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
      { intervalMs: Math.min(50, quietMs), label: opts.label ?? "mock provider quiescence" },
    );
  }

  requests() {
    return this.mock.requests();
  }

  assertHistorianRequestsUseMock(): void {
    if (this.expectMagicContext && this.hasContextDb()) {
      const model = this.host === "omp" ? "mock/mock-model" : "anthropic/claude-haiku-4-5";
      assertHistorianMockRouting(this.contextDb(), this.harnessId, model);
    }
  }

  async dispose(): Promise<void> {
    try {
      this.assertHistorianRequestsUseMock();
    } finally {
      this.closeContextDb();
      await this.rpc.shutdown();
      await this.mock.stop();
    }
  }
}

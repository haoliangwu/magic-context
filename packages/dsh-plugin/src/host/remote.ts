/**
 * host/remote — the `magicContext` Typert Remote namespace (Phase 2 slice C).
 *
 * The persistent-bundle client→host channel is NOT the dynamic-package
 * `harness.handle` / `host.call` pair (dsh-reference §G.1, §F.4): a persistent
 * bundle's browser half reaches the host through the Typert Gateway over the
 * shared `/api` RPC channel (`ctx.connection.rpc.call('/api',
 * 'magicContext/status', { args })`), and the host half registers a strict
 * InvocationDescriptor with `ctx.typert.register(...)`. This module registers
 * the `magicContext/status` endpoint against the live `magicContextHost`
 * service, with no runtime dependency beyond Cordis + the core — the
 * typertRemote binding is hand-built (the protocol package's frozen
 * `{service, serviceKey, namespace}` shape) and the descriptor uses src-json
 * codecs, so no decorators or generated artifacts are involved.
 */
import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Service, type Context } from "@deepseek-ai/cordis";
import { resolveCortexKitUserConfigPath } from "@magic-context/core/config/migrate-config-location";
import {
  LATEST_SUPPORTED_VERSION,
  getPersistedSchemaVersion,
} from "@magic-context/core/features/magic-context/storage-db";
import { computeM0BlockTokens } from "@magic-context/core/hooks/magic-context/m0-token-breakdown";
import {
  calibrateBuckets,
  resolveModelCalibration,
} from "@magic-context/core/hooks/magic-context/tokenizer-calibration";
import pkg from "../../package.json";
import type TypertRegistry from "@deepseek-ai/dsh-typert-registry";
import type { InvocationDescriptor } from "@deepseek-ai/dsh-typert-protocol";
import type { TypertContribution } from "@deepseek-ai/dsh-typert-registry/types";
import { MAGIC_CONTEXT_REMOTE_NAMESPACE } from "../compat/dsh-0.1/remote-seam";
import type { MagicContextHostService } from "../index";
import { formatDetail, MAGIC_CONTEXT_PACKAGE, resolveDshHome } from "../doctor/env";

/** Wire endpoint name (client calls `magicContext/status`). */
export const MAGIC_STATUS_METHOD = "status";

/** Wire endpoint name for the per-session diagnostics (Phase 4). */
export const MAGIC_DIAGNOSTICS_METHOD = "diagnostics";

/** Wire endpoint name for the per-session token breakdown (Phase 5). */
export const MAGIC_SNAPSHOT_METHOD = "sidebar-snapshot";

/** dsh-plugin package version, shipped with every snapshot payload. */
const MAGIC_CONTEXT_VERSION = pkg.version;

/**
 * JSON-safe sidebar snapshot subset (`magicContext/sidebar-snapshot`). The dsh
 * host cannot fill OpenCode's live-state fields (tool-definition measurement,
 * tail-hygiene scans, dreamer progress), so this is a strict subset of the
 * OpenCode `SidebarSnapshot`: the token breakdown the Context tab renders.
 */
export interface DshSidebarSnapshot {
  readonly sessionId: string;
  readonly usagePercentage: number;
  readonly inputTokens: number;
  readonly contextLimit: number;
  readonly executeThreshold: number;
  readonly systemPromptTokens: number;
  readonly docsTokens: number;
  readonly compartmentTokens: number;
  readonly factTokens: number;
  readonly memoryTokens: number;
  readonly profileTokens: number;
  readonly conversationTokens: number;
  readonly toolCallTokens: number;
  readonly toolDefinitionTokens: number;
  readonly tailHygiene?: { readonly u: number; readonly t: number; readonly severity: string };
  readonly version: string;
}

/** JSON-safe per-session diagnostics (outbox/tags/compartments/meta). */
export interface MagicSessionDiagnostics {
  readonly sessionId: string;
  readonly outbox: {
    readonly pending: number;
    readonly applied: number;
    readonly committed: number;
    readonly abandoned: number;
  };
  readonly tags: { readonly active: number; readonly dropped: number };
  readonly compartments: number;
  readonly meta: { readonly lastContextPercentage?: number; readonly hasM0: boolean };
}

/** JSON-safe status summary served to the browser card / header action. */
export interface MagicStatus {
  readonly package: string;
  readonly harness: "dsh";
  readonly storage: {
    readonly ok: boolean;
    readonly schemaVersion?: number;
    readonly latestSupported: number;
    readonly reason?: "schema-fence" | "migration-guard" | "error";
    readonly detail?: string;
  };
  readonly config: { readonly path: string; readonly exists: boolean };
  readonly preset: { readonly dir: string; readonly exists: boolean };
  readonly sessionId?: string | null;
}

/** Cordis Service backing the `magicContext` Remote namespace. */
export class MagicContextRemoteService extends Service {
  /** Hand-built Typert Gateway binding (protocol `bindTypertRemote` shape). */
  readonly typertRemote: Readonly<{
    service: MagicContextRemoteService;
    serviceKey: string;
    namespace: string;
  }>;

  constructor(
    ctx: Context,
    private readonly host: MagicContextHostService,
  ) {
    super(ctx, "magicContextRemote");
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: "magicContextRemote",
      namespace: MAGIC_CONTEXT_REMOTE_NAMESPACE,
    });
  }

  /** `magicContext/status` — current adapter state for one session. */
  async status(args: { sessionId?: string } = {}): Promise<MagicStatus> {
    const bootstrap = await this.host.ready;
    const storage = (() => {
      if (bootstrap.kind !== "ok") {
        return {
          ok: false,
          latestSupported: LATEST_SUPPORTED_VERSION,
          reason: bootstrap.reason,
          detail: formatDetail(bootstrap.detail) || undefined,
        };
      }
      return {
        ok: true,
        schemaVersion: getPersistedSchemaVersion(bootstrap.db),
        latestSupported: LATEST_SUPPORTED_VERSION,
      };
    })();
    const home = resolveDshHome();
    const configPath = resolveCortexKitUserConfigPath();
    const presetDir = join(home, ".agent-presets", "magic-standard");
    return {
      package: MAGIC_CONTEXT_PACKAGE,
      harness: "dsh",
      storage,
      config: { path: configPath, exists: existsSync(configPath) },
      preset: { dir: presetDir, exists: existsSync(join(presetDir, "agent.cordis.yml")) },
      ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
    };
  }

  /** `magicContext/diagnostics` — per-session context-management state. */
  async diagnostics(args: { sessionId: string }): Promise<MagicSessionDiagnostics> {
    // Security: bound the session id (Remote 限额 — PLAN §11) and never echo
    // unvalidated input into SQL beyond the bound parameter.
    const rawSessionId = String(args?.sessionId ?? "").slice(0, 512);
    const empty = {
      sessionId: rawSessionId,
      outbox: { pending: 0, applied: 0, committed: 0, abandoned: 0 },
      tags: { active: 0, dropped: 0 },
      compartments: 0,
      meta: { hasM0: false },
    };
    if (rawSessionId.length === 0) return empty;
    // The slot passes a DSH-native session id (header.id), but the shared DB
    // keys rows by the canonical Magic session id `dsh:<homeHash>:<id>`.
    // Accept either form: if parseKey already recognises it, it's canonical;
    // otherwise canonicalise a native id. Keeps the wire payload stable when
    // the client already sends a canonical key.
    const sessionId =
      this.host.parseKey(rawSessionId) !== undefined
        ? rawSessionId
        : this.host.canonicalKey(rawSessionId);
    const bootstrap = await this.host.ready;
    if (bootstrap.kind !== "ok") return empty;
    const db = bootstrap.db;
    const count = (sql: string, ...params: (string | number)[]) =>
      (db.prepare(sql).get(...params) as { n: number }).n;
    try {
      const outbox = {
        pending: count(
          "SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'pending'",
          sessionId,
        ),
        applied: count(
          "SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'applied'",
          sessionId,
        ),
        committed: count(
          "SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'committed'",
          sessionId,
        ),
        abandoned: count(
          "SELECT COUNT(*) AS n FROM dsh_context_outbox WHERE session_id = ? AND status = 'abandoned'",
          sessionId,
        ),
      };
      const tags = {
        active: count(
          "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = 'active'",
          sessionId,
        ),
        dropped: count(
          "SELECT COUNT(*) AS n FROM tags WHERE session_id = ? AND status = 'dropped'",
          sessionId,
        ),
      };
      const compartments = count(
        "SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?",
        sessionId,
      );
      const metaRow = db
        .prepare(
          "SELECT last_context_percentage, cached_m0_bytes FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as
        | { last_context_percentage: number | null; cached_m0_bytes: Uint8Array | null }
        | undefined;
      return {
        sessionId,
        outbox,
        tags,
        compartments,
        meta: {
          ...(typeof metaRow?.last_context_percentage === "number"
            ? { lastContextPercentage: metaRow.last_context_percentage }
            : {}),
          hasM0: metaRow?.cached_m0_bytes !== null && metaRow?.cached_m0_bytes !== undefined,
        },
      };
    } catch {
      return empty;
    }
  }

  /** `magicContext/sidebar-snapshot` — token breakdown for the Context tab. */
  async ["sidebar-snapshot"](args: { sessionId: string }): Promise<DshSidebarSnapshot> {
    // Security: bound the session id exactly like diagnostics (PLAN §11).
    const rawSessionId = String(args?.sessionId ?? "").slice(0, 512);
    const empty: DshSidebarSnapshot = {
      sessionId: rawSessionId,
      usagePercentage: 0,
      inputTokens: 0,
      contextLimit: 200_000,
      executeThreshold: 65,
      systemPromptTokens: 0,
      docsTokens: 0,
      compartmentTokens: 0,
      factTokens: 0,
      memoryTokens: 0,
      profileTokens: 0,
      conversationTokens: 0,
      toolCallTokens: 0,
      toolDefinitionTokens: 0,
      version: MAGIC_CONTEXT_VERSION,
    };
    if (rawSessionId.length === 0) return empty;
    // Accept canonical or DSH-native session ids (same policy as diagnostics).
    const sessionId =
      this.host.parseKey(rawSessionId) !== undefined
        ? rawSessionId
        : this.host.canonicalKey(rawSessionId);
    const bootstrap = await this.host.ready;
    if (bootstrap.kind !== "ok") return { ...empty, sessionId };
    const db = bootstrap.db;
    try {
      const row = db
        .prepare(
          `SELECT last_context_percentage, last_input_tokens, system_prompt_tokens,
                  conversation_tokens, tool_call_tokens, cached_m0_bytes,
                  memory_block_count, cached_m0_project_identity,
                  last_usage_context_limit, detected_context_limit
           FROM session_meta WHERE session_id = ?`,
        )
        .get(sessionId) as
        | {
            last_context_percentage: number | null;
            last_input_tokens: number | null;
            system_prompt_tokens: number | null;
            conversation_tokens: number | null;
            tool_call_tokens: number | null;
            cached_m0_bytes: Uint8Array | string | null;
            memory_block_count: number | null;
            cached_m0_project_identity: string | null;
            last_usage_context_limit: number | null;
            detected_context_limit: number | null;
          }
        | undefined;
      if (!row) return { ...empty, sessionId };

      const usagePercentage = Number(row.last_context_percentage ?? 0);
      const inputTokens = Number(row.last_input_tokens ?? 0);
      const systemPromptTokens = Number(row.system_prompt_tokens ?? 0);
      // conversation_tokens is the persisted estimate of output.messages[]
      // INCLUDING injected compartments/facts/memories/docs/profile (all live
      // in message[0]) — subtract them so "conversation" reflects real dialog.
      const messagesBlockTokens = Number(row.conversation_tokens ?? 0);
      const toolCallsLocal = Math.max(0, Number(row.tool_call_tokens ?? 0));
      // The m[0] per-block attribution is computed by the SHARED helper so the
      // dsh Context tab and the OpenCode sidebar can never diverge on how the
      // categories are measured.
      const cachedM0Bytes = row.cached_m0_bytes;
      const m0Text =
        cachedM0Bytes instanceof Uint8Array
          ? Buffer.from(cachedM0Bytes).toString("utf8")
          : typeof cachedM0Bytes === "string"
            ? (cachedM0Bytes as string)
            : "";
      const m0Blocks = computeM0BlockTokens(db, sessionId, {
        m0Text,
        projectIdentity: row.cached_m0_project_identity ?? undefined,
        injectionBudgetTokens: undefined,
        memoryBlockCount: Number(row.memory_block_count ?? 0),
      });
      const injectedInMessages =
        m0Blocks.compartmentTokens +
        m0Blocks.factTokens +
        m0Blocks.memoryTokens +
        m0Blocks.docsTokens +
        m0Blocks.profileTokens;
      const conversationLocal = Math.max(0, messagesBlockTokens - injectedInMessages);
      // No per-model resolution on the dsh host → neutral ratios (1.0/1.0).
      const contextLimit =
        Number(row.last_usage_context_limit ?? 0) > 0
          ? Number(row.last_usage_context_limit)
          : Number(row.detected_context_limit ?? 0) > 0
            ? Number(row.detected_context_limit)
            : 200_000;
      const calibrated = calibrateBuckets({
        inputTokens,
        systemLocal: systemPromptTokens,
        toolDefsLocal: 0, // dsh has no live tool-definition measurement
        compartmentsLocal: m0Blocks.compartmentTokens,
        factsLocal: m0Blocks.factTokens,
        memoriesLocal: m0Blocks.memoryTokens,
        docsLocal: m0Blocks.docsTokens,
        profileLocal: m0Blocks.profileTokens,
        conversationLocal,
        toolCallsLocal,
        calibration: resolveModelCalibration(undefined, undefined),
      });
      return {
        sessionId,
        usagePercentage,
        inputTokens,
        contextLimit,
        executeThreshold: 65, // runtime default; dsh has no per-model config
        systemPromptTokens: calibrated.systemTokens,
        docsTokens: calibrated.docsTokens,
        compartmentTokens: calibrated.compartmentTokens,
        factTokens: calibrated.factTokens,
        memoryTokens: calibrated.memoryTokens,
        profileTokens: calibrated.profileTokens,
        conversationTokens: calibrated.conversationTokens,
        toolCallTokens: calibrated.toolCallTokens,
        toolDefinitionTokens: calibrated.toolDefinitionTokens,
        version: MAGIC_CONTEXT_VERSION,
      };
    } catch {
      return { ...empty, sessionId };
    }
  }
}

/** Strict descriptor for `magicContext/status` (src-json codecs, no schemas). */
export function magicStatusDescriptor(): InvocationDescriptor {
  return {
    id: "magicContext.status",
    service: "magicContextRemote",
    namespace: MAGIC_CONTEXT_REMOTE_NAMESPACE,
    method: MAGIC_STATUS_METHOD,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "args",
        wire: "args",
        source: "json",
        codec: { mode: "src-json" },
      },
    ],
    result: { mode: "src-json" },
    sourceLocation: {
      file: "packages/dsh-plugin/src/host/remote.ts",
      line: 1,
      column: 1,
    },
  };
}

/** Strict descriptor for `magicContext/diagnostics` (Phase 4). */
export function magicDiagnosticsDescriptor(): InvocationDescriptor {
  return {
    id: "magicContext.diagnostics",
    service: "magicContextRemote",
    namespace: MAGIC_CONTEXT_REMOTE_NAMESPACE,
    method: MAGIC_DIAGNOSTICS_METHOD,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "args",
        wire: "args",
        source: "json",
        codec: { mode: "src-json" },
      },
    ],
    result: { mode: "src-json" },
    sourceLocation: {
      file: "packages/dsh-plugin/src/host/remote.ts",
      line: 1,
      column: 1,
    },
  };
}

/** Strict descriptor for `magicContext/sidebar-snapshot` (Phase 5). */
export function magicSnapshotDescriptor(): InvocationDescriptor {
  return {
    id: "magicContext.sidebar-snapshot",
    service: "magicContextRemote",
    namespace: MAGIC_CONTEXT_REMOTE_NAMESPACE,
    method: MAGIC_SNAPSHOT_METHOD,
    invocation: { kind: "direct" },
    parameters: [
      {
        name: "args",
        wire: "args",
        source: "json",
        codec: { mode: "src-json" },
      },
    ],
    result: { mode: "src-json" },
    sourceLocation: {
      file: "packages/dsh-plugin/src/host/remote.ts",
      line: 1,
      column: 1,
    },
  };
}

/**
 * Provide the remote service and register the `magicContext/status`
 * contribution. Returns a disposer, or undefined when the Typert registry is
 * absent from this host plane (headless profiles) — callers must tolerate
 * that. Registration is fiber-owned: the contribution auto-withdraws when the
 * calling plugin is stopped or updated.
 */
export function registerMagicContextRemote(
  ctx: Context,
  host: MagicContextHostService,
): (() => void) | undefined {
  const typert = ctx.get("typert") as TypertRegistry | undefined;
  if (typert === undefined) return undefined;

  const service = new MagicContextRemoteService(ctx, host);
  // The Service constructor provides `magicContextRemote`; no explicit
  // ctx.provide here (a second provide on the same fiber throws).

  const contribution: TypertContribution = {
    package: MAGIC_CONTEXT_PACKAGE,
    face: "host",
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [
      magicStatusDescriptor(),
      magicDiagnosticsDescriptor(),
      magicSnapshotDescriptor(),
    ],
  };
  const disposer = typert.register(contribution);
  return () => {
    void disposer();
  };
}

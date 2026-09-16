/**
 * agent/transcript — DshTranscript (Phase 3 slice T).
 *
 * Read-only view of a DSH session plus MutationPlan derivation. Mirrors the
 * Pi adapter's mapping semantics (`pi-plugin/read-session-pi.ts`) and the
 * design doc `docs/phase3-design.md` §3 / §9.9-9.12:
 *
 *   1. `readDshTranscript` — the model-visible transcript (surface nodes →
 *      core `RawMessage[]`, ONE per surface event — no tool-result folding),
 *      with a reversible event-seq ↔ ordinal map.
 *   2. `deriveMutationPlan` — runs the shared core pipeline stages
 *      (temporal markers → tagTranscript → applyPendingOperations →
 *      applyFlushedStatuses → reasoning replay) through a RECORDING
 *      transcript/target layer, producing `MutationOp`s that the coordinator
 *      slice (C) will apply through the surface CAS. This module NEVER
 *      mutates the view's messages or any source array (D4).
 *
 * B2 (cache/role semantics): each dirty message coalesces into ONE same-type
 * replace op (user rows → user/message, tool rows → tool/result); assistant
 * rows produce no ops (host rejects assistant/message replaces). Pure tag
 * prefixes on the current INCOMPLETE turn are gated — they land only once the
 * turn's `turn/end` is seen. Plan ids are deterministic digests so the
 * outbox CAS dedups crash-retried plans.
 *
 * Recording design: `RecordingPart` wraps each RawMessage part and records
 * every content mutation (`from` → `to`) on its owning `RecordingMessage`;
 * `RecordingTagTarget` implements the core `TagTarget` interface by
 * delegating to the shared tagTranscript-built targets (which call the
 * recording parts), so `applyPendingOperations`/`applyFlushedStatuses` run
 * unchanged and their effects land in the plan instead of the wire. At the
 * end, each dirty message coalesces into ONE replace op (per design §3:
 * "同一消息多个变更 → 合并为单个 replace op").
 *
 * Scope: tags / drops / reasoning / temporal stages only. The remaining
 * stages (nudge / decay / caveman / historian / recomp / wrapup / emergency)
 * arrive with later slices; stage lists are plain arrays so the pipeline is
 * extensible.
 *
 * Known Phase-4 handoffs (documented at each site):
 *   - reasoning clearing is REPLAY-only (watermark reads); the watermark-
 *     advancing clear pass lands with the coordinator, which owns pass type.
 *   - `minimalCacheClassForOp` is a temporary stand-in for the
 *     cache-classification slice (§6); the official `classifyPlan` replaces
 *     it at integration.
 */
import { createHash } from "node:crypto";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { RawMessage } from "@magic-context/core/hooks/magic-context/read-session-raw";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import {
  applyFlushedStatuses,
  applyPendingOperations,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import { applyHeuristicCleanup } from "@magic-context/core/hooks/magic-context/heuristic-cleanup";
import type {
  MessageLike,
  TagTarget,
} from "@magic-context/core/hooks/magic-context/tag-messages";
import type { ToolDropResult } from "@magic-context/core/hooks/magic-context/tool-drop-target";
import {
  byteSize,
  peelLeadingMcTagNotation,
  stripTagPrefix,
} from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import {
  formatGap,
  TEMPORAL_MARKER_PATTERN,
  temporalMarkerPrefix,
} from "@magic-context/core/hooks/magic-context/temporal-awareness";
import {
  getOrCreateSessionMeta,
  getPendingOps,
  getTagsBySession,
} from "@magic-context/core/features/magic-context/storage";
import { getProtectionWindowForSession } from "@magic-context/core/features/magic-context/protection-window";
import { getOverflowState, resolveEpochFloorForPass } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import type {
  Transcript,
  TranscriptMessage,
  TranscriptPart,
  TranscriptPartKind,
} from "@magic-context/core/shared/transcript";
import type { KnowledgeSessionView } from "./knowledge-gate";
import { sessionEventsOf } from "./session-events";
import {
  deriveEventMessage,
  type SessionEvent,
} from "../compat/dsh-0.1/session";

/* ─────────────────────────────── public types ─────────────────────────────── */

/** Input to {@link readDshTranscript}: the DSH session structural view. */
export interface DshTranscriptInput {
  readonly session: KnowledgeSessionView & {
    readonly header: { readonly id?: string; readonly cwd?: string };
  };
  readonly canonicalSessionId: string;
}

/**
 * Read-only transcript view (design §3). `messages` are the model-visible
 * (surface) messages in surface order; `surfaceNodes` are the DSH surface
 * event seqs they were derived from. `inputDigest` =
 * sha256(JSON(messages))[0:16]; `sourceWatermark` = the last log seq covered;
 * `generation` = surface.replaceGeneration snapshot.
 *
 * Each view message carries NON-ENUMERABLE metadata (invisible to
 * JSON.stringify, so the digest is unaffected): its surface node span
 * (read via {@link messageNodeSpan}) and its knowledge-baseline flag (read
 * via {@link isKnowledgeBaselineMessage}). The mutation plan uses those to
 * index ops into `surfaceNodes` and to keep the m[0]/m[1] knowledge baseline
 * out of the tag/drop pipeline (see `buildRecordingTranscript`).
 */
export interface DshTranscriptView {
  readonly sessionId: string;
  readonly sourceWatermark: number;
  readonly inputDigest: string;
  readonly generation: number;
  readonly messages: readonly RawMessage[];
  readonly surfaceNodes: readonly number[];
  /**
   * Highest turn number with a seen `turn/end` (0 when none). A message
   * belongs to a completed turn iff its stamped turn >= 1 and <= currentTurn;
   * messages stamped `0` (pre-turn, no turn/start seen) are always treated as
   * completed. See the completed-turn gate in `deriveMutationPlan`.
   */
  readonly currentTurn: number;
}

/**
 * The surface event type a view message derives from. Same-type surface
 * replacements (B2) keep each row's role on the wire: user rows rewrite as
 * user/message, tool rows as tool/result. assistant/message rows never
 * produce ops — `assertProvenance` (dsh-session/lib/types/surface.js) makes an
 * assistant/message replace impossible on 0.1.5-rc.2 (see deriveMutationPlan).
 */
export type SurfaceType = "user/message" | "assistant/message" | "tool/result";

export type MutationKind =
  | "tags"
  | "drops"
  | "reasoning"
  | "temporal"
  | "nudge"
  | "decay"
  | "caveman"
  | "historian"
  | "recomp"
  | "wrapup"
  | "emergency";

/**
 * Temporary local cache-class union. The cache-classification slice
 * (`src/agent/cache-classification.ts`) owns the official `CacheClass`;
 * until it lands, `minimalCacheClassForOp` is the stand-in.
 */
export type CacheClass = "soft-plus" | "soft" | "hard";

export interface MutationOp {
  readonly kind: MutationKind;
  /** Surface node range [start, end) (pre-replacement indices into view.surfaceNodes). */
  readonly start: number;
  readonly end: number;
  /**
   * Replacement payload, union:
   *  - flat string for temporal-marker merge ops (insertion),
   *  - structured content blocks for same-type ops (B2). tool/result ops
   *    carry exactly one cloned tool-result block whose inner content was
   *    mutated (the host's `assertToolResultRewrite` allows only message
   *    content changes). user/message ops carry the flat rendered text (their
   *    parts are text-only, so flat == single text block).
   */
  readonly replacement: string | readonly ContentBlock[];
  /** Same-type surface event type of the shadowed row (B2). */
  readonly surfaceType: SurfaceType;
  readonly cacheClass: CacheClass;
  readonly reason: string;
  /** DSH event seqs of every shadowed surface node (sourceEventSeqs coverage). */
  readonly shadowedSeqs: readonly number[];
}

export interface MutationPlan {
  readonly opId: string;
  readonly sessionId: string;
  readonly sourceWatermark: number;
  readonly inputDigest: string;
  readonly generation: number;
  readonly ops: readonly MutationOp[];
}

/** Reversible DSH event seq ↔ ordinal mapping (ctx_expand traceability). */
export interface DshOrdinalMap {
  readonly ordinalToSeq: ReadonlyMap<number, number>;
  readonly seqToOrdinal: ReadonlyMap<number, number>;
}

/** Plan-derivation context (design §3). */
export interface PlanContext {
  readonly db: Database;
  /** Usable soft context window feeding the protection-window floor
   *  derivation (upstream token-mass model). Falls back to the persisted
   *  epoch floor snapshot (or 0) when absent. */
  readonly usableSoft?: number;
  /** Injectable clock; reserved for later stages (decay/nudge). Unused by this slice. */
  readonly now?: () => number;
  /** Heuristic cleanup config (Pi/OpenCode parity): routine dedup + optional
   *  caveman text compression. Emergency tier runs only on force passes and is
   *  intentionally not wired here. */
  readonly heuristicCleanup?: {
    readonly caveman?: { readonly enabled: boolean; readonly minChars: number };
  };
}

/* ────────────────────────────── event accessors ───────────────────────────── */

// Keep in sync with the Context tab fallback chain (host/remote.ts
// sidebarSnapshot): last_usage_context_limit → detected_context_limit → 200k.
// The protection floor and the displayed window must never disagree.
const DSH_DEFAULT_CONTEXT_LIMIT = 200_000;

/**
 * Usable-soft window for protection-floor derivation. The DSH host has no
 * overflow detection (that is an OpenCode/Pi provider-error path), so the
 * session_meta columns stay NULL and the chain ends at the same 200k default
 * the Context tab renders. Without this fallback the floor resolves to 0 and
 * the protection window collapses to the newest tie-group only — every older
 * tool arc is compacted on every pre-step (session-f319897f regression).
 */
function sessionUsableSoftOf(db: Database, sessionId: string): number {
  const overflowLimit = detectedContextLimitOf(db, sessionId);
  if (overflowLimit !== undefined) return overflowLimit;
  try {
    const row = db
      .prepare(
        "SELECT last_usage_context_limit, detected_context_limit FROM session_meta WHERE session_id = ?",
      )
      .get(sessionId) as
      | { last_usage_context_limit?: number | null; detected_context_limit?: number | null }
      | undefined;
    for (const value of [row?.last_usage_context_limit, row?.detected_context_limit]) {
      if (typeof value === "number" && value > 0) return value;
    }
  } catch {
    // Pre-migration database — fall through to the default.
  }
  return DSH_DEFAULT_CONTEXT_LIMIT;
}

/** Detected provider-proven context limit for the session, when known. */
function detectedContextLimitOf(db: Database, sessionId: string): number | undefined {
  try {
    const detected = getOverflowState(db, sessionId).detectedContextLimit;
    return typeof detected === "number" && detected > 0 ? detected : undefined;
  } catch {
    return undefined;
  }
}

interface EventLike {
  readonly type?: unknown;
  readonly seq?: unknown;
  readonly time?: unknown;
  readonly data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asEvent(value: unknown): EventLike | null {
  return isRecord(value) ? (value as unknown as EventLike) : null;
}

function seqOf(event: EventLike): number {
  return typeof event.seq === "number" ? event.seq : -1;
}

function timeOf(event: EventLike): number | undefined {
  return typeof event.time === "number" ? event.time : undefined;
}

function dataOf(event: EventLike): Record<string, unknown> | null {
  return isRecord(event.data) ? event.data : null;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/* ───────────────────────────── message conversion ─────────────────────────── */

/** `synth-user-` prefix for synthetic tail user messages (legacy fold; B2 walk no longer produces these — kept for callers). */
export const SYNTH_USER_ID_PREFIX = "synth-user-";

function isSyntheticUserMessage(message: RawMessage): boolean {
  return typeof message.id === "string" && message.id.startsWith(SYNTH_USER_ID_PREFIX);
}

/** True for Magic-injected knowledge messages (source.plugin === 'magic-context'). */
function isKnowledgeMessage(message: Record<string, unknown>): boolean {
  const source = isRecord(message.source) ? message.source : null;
  return source !== null && source.kind === "plugin" && source.plugin === "magic-context";
}

/**
 * True for DSH skill-catalog user messages (dsh-tool-skill's durable catalog
 * reminder: `source.kind === 'skill-catalog'` with `entries`). These must be
 * treated like knowledge baselines — excluded from the tag/drop pipeline — or
 * the §N§ prefix injection forces a surface replace each round, the catalog's
 * original event seq leaves the visible surface, `catalogHistory` can no
 * longer find a visible digest, and dsh-tool-skill re-injects the catalog on
 * every subsequent pre-step (the per-round <system-reminder> loop).
 */
function isSkillCatalogMessage(message: Record<string, unknown>): boolean {
  const source = isRecord(message.source) ? message.source : null;
  return source !== null && source.kind === "skill-catalog";
}

/**
 * True for durable agent-instructions baselines (source.kind==='agent-instructions',
 * 6500a728 digest). Durable injected context — large, stable across steps,
 * compress gain ≈0. Must stay out of the tag/drop pipeline, otherwise the
 * magic-context surface replace shadows the visible baseline, visibleBaselineSource
 * / RuntimeContextProjection see it missing, and the host re-injects it every
 * step — the injection-compression loop (session-11d586ad: 116 baselines,
 * 58 dsh-system-prompt snapshots re-injected each round).
 */
function isAgentInstructionsMessage(message: Record<string, unknown> | RawMessage): boolean {
  const rec = message as unknown as Record<string, unknown>;
  const source = isRecord(rec.source) ? (rec.source as Record<string, unknown>) : null;
  return source !== null && source.kind === "agent-instructions";
}

/**
 * True for durable dsh-system-prompt snapshots
 * (source.kind==='plugin' && source.plugin==='@deepseek-ai/dsh-system-prompt').
 * Durable injected context — stable prompt snapshot re-injected each step when
 * shadowed. Same loop as agent-instructions: compress gain ≈0, must stay out
 * of tag/drop pipeline or visibleBaselineSource misses it and host re-injects.
 */
function isDshSystemPromptMessage(message: Record<string, unknown> | RawMessage): boolean {
  const rec = message as unknown as Record<string, unknown>;
  const source = isRecord(rec.source) ? (rec.source as Record<string, unknown>) : null;
  return source !== null && source.kind === "plugin" && source.plugin === "@deepseek-ai/dsh-system-prompt";
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** User content blocks → `{type:"text", text}` parts; image/other blocks dropped (§9.9). */
function userTextParts(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  const parts: unknown[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
    parts.push({ type: "text", text: block.text });
  }
  return parts;
}

/**
 * Assistant content blocks → text parts + `{type:"tool", state:{input}}` parts
 * for tool calls (Pi `synthesizeAssistantParts` mirror). With
 * `keepReasoning`, `{type:"reasoning", text}` blocks are retained as parts so
 * the reasoning stage can plan their removal — the pure conversion drops them
 * (§9.9 "assistant thinking 丢弃"). Images/unknown dropped.
 */
function assistantParts(
  message: Record<string, unknown>,
  keepReasoning: boolean,
  toolNameByCallId: Map<string, string>,
): unknown[] {
  const content = message.content;
  if (!Array.isArray(content)) return [];
  const parts: unknown[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "tool-call" && typeof block.id === "string") {
      const name = typeof block.name === "string" ? block.name : "unknown";
      if (typeof block.name === "string" && block.name.length > 0) {
        toolNameByCallId.set(block.id, block.name);
      }
      parts.push({
        type: "tool",
        tool: name,
        callID: block.id,
        state: { input: parseToolArguments(block.arguments) },
      });
    } else if (
      keepReasoning &&
      (block.type === "reasoning" || block.type === "thinking") &&
      typeof block.text === "string"
    ) {
      parts.push({ type: "reasoning", text: block.text });
    }
  }
  return parts;
}

/**
 * ToolResultMessage → one `{type:"tool", tool, callID, state:{output}}` part;
 * multiple text fragments joined with "\n" (Pi `synthesizeToolResultParts`
 * mirror). The tool name resolves from `tool/call` events (or assistant
 * tool-call blocks) by callId; falls back to "unknown".
 */
function toolResultParts(
  message: Record<string, unknown>,
  toolNameByCallId: ReadonlyMap<string, string>,
): unknown[] {
  const content = Array.isArray(message.content) ? message.content : [];
  let callId: string | undefined;
  const source = isRecord(message.source) ? message.source : null;
  if (source && typeof source.callId === "string" && source.callId.length > 0) {
    callId = source.callId;
  }
  if (!callId) {
    for (const block of content) {
      if (
        isRecord(block) &&
        block.type === "tool-result" &&
        typeof block.toolCallId === "string" &&
        block.toolCallId.length > 0
      ) {
        callId = block.toolCallId;
        break;
      }
    }
  }
  if (!callId) return [];

  const fragments: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool-result") continue;
    const inner = block.content;
    if (!Array.isArray(inner)) continue;
    for (const fragment of inner) {
      if (isRecord(fragment) && fragment.type === "text" && typeof fragment.text === "string") {
        fragments.push(fragment.text);
      }
    }
  }
  return [
    {
      type: "tool",
      tool: toolNameByCallId.get(callId) ?? "unknown",
      callID: callId,
      state: { output: fragments.join("\n") },
    },
  ];
}

/* ─────────────────────────── log → RawMessage walk ────────────────────────── */

/**
 * Per-message surface span: which surface node range (indices into
 * `surfaceNodes`) and event seqs a view message covers. A user message that
 * absorbed tool-result nodes covers [firstToolNode .. userNode].
 */
export interface DshMessageSpan {
  readonly nodeStart: number;
  readonly nodeEnd: number;
  readonly seqs: readonly number[];
}

/** Non-enumerable span marker attached to view messages (digest-invisible). */
export const DSH_MESSAGE_SPAN_KEY = "__dshMessageNodeSpan";
/** Non-enumerable surface event type of the view message (B2 same-type ops). */
export const DSH_SURFACE_TYPE_KEY = "__dshSurfaceType";
/** Non-enumerable turn number the view message belongs to (B2 gate). */
export const DSH_TURN_KEY = "__dshTurn";
/** Non-enumerable ORIGINAL dsh content blocks (renderBlocks block-preserving source). */
export const DSH_CONTENT_BLOCKS_KEY = "__dshContentBlocks";
/** Non-enumerable knowledge-baseline marker attached to view messages. */
export const DSH_KNOWLEDGE_KEY = "__dshKnowledgeBaseline";
/** Non-enumerable skill-catalog marker attached to view messages. */
export const DSH_SKILL_CATALOG_KEY = "__dshSkillCatalog";
/** Non-enumerable agent-instructions marker (durable injected baseline). */
export const DSH_AGENT_INSTRUCTIONS_KEY = "__dshAgentInstructionsBaseline";
/** Non-enumerable dsh-system-prompt marker (durable injected snapshot). */
export const DSH_SYSTEM_PROMPT_KEY = "__dshSystemPromptBaseline";

/** The surface span of a view message, or null for messages without one. */
export function messageNodeSpan(message: RawMessage): DshMessageSpan | null {
  const span = (message as unknown as Record<string, unknown>)[DSH_MESSAGE_SPAN_KEY];
  return span !== null && typeof span === "object" ? (span as DshMessageSpan) : null;
}

/** True when the view message is a Magic-context knowledge baseline (m0/m1). */
export function isKnowledgeBaselineMessage(message: RawMessage): boolean {
  return (message as unknown as Record<string, unknown>)[DSH_KNOWLEDGE_KEY] === true;
}

/** The surface event type a view message derives from (B2 same-type ops). */
export function messageSurfaceType(message: RawMessage): SurfaceType {
  const type = (message as unknown as Record<string, unknown>)[DSH_SURFACE_TYPE_KEY];
  return type === "user/message" || type === "assistant/message" || type === "tool/result"
    ? type
    : "user/message";
}

/** Turn number the view message belongs to (0 = pre-turn / no turn/start seen). */
export function messageTurn(message: RawMessage): number {
  const turn = (message as unknown as Record<string, unknown>)[DSH_TURN_KEY];
  return typeof turn === "number" ? turn : 0;
}

/** ORIGINAL dsh content blocks the view message was derived from (renderBlocks source). */
export function messageContentBlocks(message: RawMessage): readonly unknown[] {
  const blocks = (message as unknown as Record<string, unknown>)[DSH_CONTENT_BLOCKS_KEY];
  return Array.isArray(blocks) ? (blocks as unknown[]) : [];
}

/** True when the view message is a DSH skill-catalog reminder (dsh-tool-skill). */
export function isSkillCatalogBaselineMessage(message: RawMessage): boolean {
  return (message as unknown as Record<string, unknown>)[DSH_SKILL_CATALOG_KEY] === true;
}

/** True when the view message is a durable agent-instructions baseline (source.kind==='agent-instructions'). */
export function isAgentInstructionsBaselineMessage(message: RawMessage): boolean {
  const rec = message as unknown as Record<string, unknown>;
  if (rec[DSH_AGENT_INSTRUCTIONS_KEY] === true) return true;
  const source = isRecord(rec.source) ? (rec.source as Record<string, unknown>) : null;
  return source !== null && source.kind === "agent-instructions";
}

/** True when the view message is a durable dsh-system-prompt snapshot (plugin==='@deepseek-ai/dsh-system-prompt'). */
export function isDshSystemPromptBaselineMessage(message: RawMessage): boolean {
  const rec = message as unknown as Record<string, unknown>;
  if (rec[DSH_SYSTEM_PROMPT_KEY] === true) return true;
  const source = isRecord(rec.source) ? (rec.source as Record<string, unknown>) : null;
  return source !== null && source.kind === "plugin" && source.plugin === "@deepseek-ai/dsh-system-prompt";
}

/**
 * True for any durable injected message that must stay out of the tag/drop
 * pipeline (knowledge, skill-catalog, agent-instructions, dsh-system-prompt).
 * These are externally re-injected when shadowed, so compressing them yields
 * ≈0 gain and causes the injection-compression loop (session-11d586ad).
 */
export function isDurableInjectedMessage(message: RawMessage): boolean {
  return (
    isKnowledgeBaselineMessage(message) ||
    isSkillCatalogBaselineMessage(message) ||
    isAgentInstructionsBaselineMessage(message) ||
    isDshSystemPromptBaselineMessage(message)
  );
}

interface DshWalkResult {
  readonly messages: RawMessage[];
  readonly spans: ReadonlyArray<DshMessageSpan | null>;
  readonly turns: ReadonlyArray<number>;
  readonly blocks: ReadonlyArray<readonly unknown[]>;
  readonly surfaceTypes: ReadonlyArray<SurfaceType>;
  readonly completedTurn: number;
  readonly knowledgeOrdinals: ReadonlySet<number>;
  readonly skillCatalogOrdinals: ReadonlySet<number>;
  readonly agentInstructionsOrdinals: ReadonlySet<number>;
  readonly dshSystemPromptOrdinals: ReadonlySet<number>;
  readonly ordinalToSeq: Map<number, number>;
  readonly seqToOrdinal: Map<number, number>;
}

/**
 * Shared walk. With `surfaceNodes` (surface order iteration) it produces the
 * model-visible messages; with null it walks the whole log in seq order (the
 * pure Pi-mirror conversion).
 *
 * B2 per-node mapping: every surface-eligible event becomes ONE message row
 * carrying its own surface event type (user/message → user row,
 * assistant/message → assistant row, tool/result → tool row). There is no
 * result-folding: the surface keeps the assistant tool-call node and its
 * tool/result node adjacent, so the LLM API always sees a valid
 * assistant-`tool_calls` → tool sequence, and same-type ops can rewrite each
 * row without flattening roles into user rows (the old flatten-to-user-role
 * behavior that caused the re-acknowledgment loop + per-step cache busts).
 *
 * Turn stamping: each message is stamped with the turn of the OPEN
 * `turn/start` at its own event seq (`openTurnAt(seq)` — the same positional
 * rule for every event type; assistant/tool events are not read for their
 * `data.turn`). `completedTurn` is the highest turn with a seen `turn/end` —
 * the gate in `deriveMutationPlan` leans on it.
 */
function walkDshLog(events: readonly unknown[], surfaceNodes: readonly number[] | null): DshWalkResult {
  const eventBySeq = new Map<number, EventLike>();
  const toolNameByCallId = new Map<string, string>();
  const turnStartBySeq = new Map<number, number>();
  const turnEndBySeq = new Map<number, number>();
  for (const raw of events) {
    const event = asEvent(raw);
    if (!event) continue;
    const seq = seqOf(event);
    if (seq >= 0 && !eventBySeq.has(seq)) eventBySeq.set(seq, event);
    const data = dataOf(event);
    if (event.type === "tool/call" && data) {
      const callId = data.callId;
      const name = data.name;
      if (typeof callId === "string" && callId.length > 0 && typeof name === "string") {
        toolNameByCallId.set(callId, name);
      }
    } else if (event.type === "turn/start" && data && typeof data.turn === "number") {
      turnStartBySeq.set(seq, data.turn);
    } else if (event.type === "turn/end" && data && typeof data.turn === "number") {
      turnEndBySeq.set(data.turn, seq);
    }
  }

  const ordered: EventLike[] =
    surfaceNodes !== null
      ? surfaceNodes
          .map((seq) => eventBySeq.get(seq))
          .filter((event): event is EventLike => event !== undefined)
      : events
          .map(asEvent)
          .filter((event): event is EventLike => event !== null);

  /** Open turn at an event seq: the latest turn/start at or before it, unless already closed. */
  const openTurnAt = (seq: number): number => {
    let open = 0;
    let openStart = -1;
    for (const [startSeq, turn] of turnStartBySeq) {
      if (startSeq <= seq && startSeq > openStart) {
        openStart = startSeq;
        const closeSeq = turnEndBySeq.get(turn);
        open = closeSeq !== undefined && closeSeq <= seq ? 0 : turn;
      }
    }
    return open;
  };

  const messages: RawMessage[] = [];
  const spans: Array<DshMessageSpan | null> = [];
  const turns: number[] = [];
  const blocks: Array<readonly unknown[]> = [];
  const surfaceTypes: SurfaceType[] = [];
  const knowledgeOrdinals = new Set<number>();
  const skillCatalogOrdinals = new Set<number>();
  const agentInstructionsOrdinals = new Set<number>();
  const dshSystemPromptOrdinals = new Set<number>();
  const ordinalToSeq = new Map<number, number>();
  const seqToOrdinal = new Map<number, number>();
  let completedTurn = 0;
  for (const [turn, endSeq] of turnEndBySeq) {
    if (turn > completedTurn) completedTurn = turn;
  }

  for (let nodeIndex = 0; nodeIndex < ordered.length; nodeIndex += 1) {
    const event = ordered[nodeIndex];
    const type = event.type;
    if (type !== "user/message" && type !== "assistant/message" && type !== "tool/result") {
      continue; // log-only events (tool/call, turn/*, request/*, ...) — skipped
    }
    const message = deriveEventMessage(event as unknown as SessionEvent);
    if (!message) continue; // e.g. empty-content assistant/message
    const record = message as unknown as Record<string, unknown>;
    const seq = seqOf(event);
    const ordinal = messages.length + 1;
    const createdAt = timeOf(event) ?? null;
    const turn = openTurnAt(seq);

    if (type === "user/message") {
      const contentBlocks = Array.isArray(record.content) ? (record.content as unknown[]) : [];
      messages.push({
        ordinal,
        id: String(message.id),
        role: "user",
        parts: userTextParts(record.content),
        createdAt,
        version: seq >= 0 ? seq : null,
      });
      blocks.push(contentBlocks);
    } else if (type === "assistant/message") {
      const contentBlocks = Array.isArray(record.content) ? (record.content as unknown[]) : [];
      const parts = assistantParts(record, surfaceNodes !== null, toolNameByCallId);
      messages.push({
        ordinal,
        id: String(message.id),
        role: "assistant",
        parts,
        createdAt,
        version: seq >= 0 ? seq : null,
      });
      blocks.push(contentBlocks);
    } else {
      // tool/result — its own row (B2; no folding into a user message).
      const contentBlocks = Array.isArray(record.content) ? (record.content as unknown[]) : [];
      messages.push({
        ordinal,
        id: String(message.id),
        role: "tool",
        parts: toolResultParts(record, toolNameByCallId),
        createdAt,
        version: seq >= 0 ? seq : null,
      });
      blocks.push(contentBlocks);
    }

    spans.push(
      surfaceNodes !== null ? { nodeStart: nodeIndex, nodeEnd: nodeIndex + 1, seqs: [seq] } : null,
    );
    turns.push(turn);
    surfaceTypes.push(type as SurfaceType);

    const knowledge = type === "user/message" && isKnowledgeMessage(record);
    const skillCatalog = type === "user/message" && isSkillCatalogMessage(record);
    const agentInstructions = type === "user/message" && isAgentInstructionsMessage(record);
    const dshSystemPrompt = type === "user/message" && isDshSystemPromptMessage(record);
    if (knowledge) knowledgeOrdinals.add(ordinal);
    if (skillCatalog) skillCatalogOrdinals.add(ordinal);
    if (agentInstructions) agentInstructionsOrdinals.add(ordinal);
    if (dshSystemPrompt) dshSystemPromptOrdinals.add(ordinal);
    ordinalToSeq.set(ordinal, seq);
    if (seq >= 0) seqToOrdinal.set(seq, ordinal);
  }

  return {
    messages,
    spans,
    turns,
    blocks,
    surfaceTypes,
    completedTurn,
    knowledgeOrdinals,
    skillCatalogOrdinals,
    agentInstructionsOrdinals,
    dshSystemPromptOrdinals,
    ordinalToSeq,
    seqToOrdinal,
  };
}

/**
 * Pure conversion of a DSH event log into core `RawMessage[]` (Pi-mirror
 * mapping; see module doc). Ordinals are 1-based and monotonic over message
 * events only; tool results and assistant tool-call rows each get their own
 * message (B2 per-node mapping — no folding). Assistant thinking is dropped
 * here (the VIEW keeps it for the reasoning stage).
 */
export function convertDshEventsToRawMessages(events: readonly unknown[]): RawMessage[] {
  return walkDshLog(events, null).messages;
}

/**
 * Reversible DSH event seq ↔ ordinal map for a log (or, with `surfaceNodes`,
 * for the surface view). `ordinalToSeq` maps each message to its own event
 * seq; `seqToOrdinal` maps every contributing event seq back to its ordinal.
 */
export function buildDshOrdinalMap(
  events: readonly unknown[],
  surfaceNodes?: readonly number[],
): DshOrdinalMap {
  const walk = walkDshLog(events, surfaceNodes ?? null);
  return { ordinalToSeq: new Map(walk.ordinalToSeq), seqToOrdinal: new Map(walk.seqToOrdinal) };
}

/** Convenience reverse lookup: the DSH event seq that produced `ordinal`. */
export function dshSeqForOrdinal(
  events: readonly unknown[],
  ordinal: number,
  surfaceNodes?: readonly number[],
): number | undefined {
  return buildDshOrdinalMap(events, surfaceNodes).ordinalToSeq.get(ordinal);
}

/** Surface node indices occupied by Magic-context knowledge messages (m0/m1). */
export function findKnowledgeBaselineNodeIndices(
  events: readonly unknown[],
  surfaceNodes: readonly number[],
): number[] {
  const eventBySeq = new Map<number, EventLike>();
  for (const raw of events) {
    const event = asEvent(raw);
    if (!event) continue;
    const seq = seqOf(event);
    if (seq >= 0) eventBySeq.set(seq, event);
  }
  const out: number[] = [];
  surfaceNodes.forEach((seq, index) => {
    const event = eventBySeq.get(seq);
    if (!event || event.type !== "user/message") return;
    const data = dataOf(event);
    if (data && isKnowledgeMessage(data)) out.push(index);
  });
  return out;
}

/* ────────────────────────────────── view ──────────────────────────────────── */

/** Build the read-only transcript view (design §3). */
export function readDshTranscript(input: DshTranscriptInput): DshTranscriptView {
  const events = sessionEventsOf(input.session);
  const nodes = Array.isArray(input.session.surface?.nodes)
    ? [...input.session.surface.nodes]
    : [];
  const walk = walkDshLog(events, nodes);

  for (let i = 0; i < walk.messages.length; i += 1) {
    const message = walk.messages[i];
    const span = walk.spans[i];
    if (span !== null) {
      Object.defineProperty(message, DSH_MESSAGE_SPAN_KEY, {
        value: span,
        enumerable: false,
        configurable: true,
      });
    }
    const surfaceType = walk.surfaceTypes[i] ?? "user/message";
    Object.defineProperty(message, DSH_SURFACE_TYPE_KEY, {
      value: surfaceType,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(message, DSH_TURN_KEY, {
      value: walk.turns[i] ?? 0,
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(message, DSH_CONTENT_BLOCKS_KEY, {
      value: walk.blocks[i] ?? [],
      enumerable: false,
      configurable: true,
    });
    if (walk.knowledgeOrdinals.has(message.ordinal)) {
      Object.defineProperty(message, DSH_KNOWLEDGE_KEY, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }
    if (walk.skillCatalogOrdinals.has(message.ordinal)) {
      Object.defineProperty(message, DSH_SKILL_CATALOG_KEY, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }
    if (walk.agentInstructionsOrdinals.has(message.ordinal)) {
      Object.defineProperty(message, DSH_AGENT_INSTRUCTIONS_KEY, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }
    if (walk.dshSystemPromptOrdinals.has(message.ordinal)) {
      Object.defineProperty(message, DSH_SYSTEM_PROMPT_KEY, {
        value: true,
        enumerable: false,
        configurable: true,
      });
    }
  }

  return {
    sessionId: input.canonicalSessionId,
    sourceWatermark: maxEventSeq(events),
    inputDigest: sha256Hex(JSON.stringify(walk.messages)).slice(0, 16),
    generation:
      typeof input.session.surface?.replaceGeneration === "number"
        ? input.session.surface.replaceGeneration
        : 0,
    messages: walk.messages,
    surfaceNodes: nodes,
    currentTurn: walk.completedTurn,
  };
}

function maxEventSeq(events: readonly unknown[]): number {
  let max = 0;
  for (const raw of events) {
    const event = asEvent(raw);
    if (!event) continue;
    const seq = seqOf(event);
    if (seq > max) max = seq;
  }
  return max;
}

/* ─────────────────────────── recording transcript ─────────────────────────── */

/** Canonical dropped placeholder (byte-identical to buildReplacementContent). */
const DROPPED_SENTINEL_PATTERN = /^\[dropped\s+\u00a7\d+\u00a7\]$/;

export type RecordingPartField = "text" | "output" | "input" | "sentinel" | "reasoning";

/** A well-formed tag prefix injection (`§N§ `) — the tagger's only text mutation shape. */
const TAG_PREFIX_PATTERN = /^\u00a7\d+\u00a7\s/;

/** Block kind for renderBlocks block↔part pairing (same eligibility as the walk). */
type RenderBlockKind = "text" | "tool-call" | "tool-result" | "thinking" | "ineligible";

function classifyBlockKind(block: Record<string, unknown>): RenderBlockKind {
  switch (block.type) {
    case "text":
      return "text";
    case "tool-call":
      return "tool-call";
    case "tool-result":
      return "tool-result";
    case "reasoning":
    case "thinking":
      return "thinking";
    default:
      return "ineligible";
  }
}

/** One recorded content change: which part went from what to what. */
export interface MutationRecord {
  /** Index into the owning message's parts; -1 for message-level records (reasoning). */
  readonly partIndex: number;
  readonly field: RecordingPartField;
  readonly from: string;
  readonly to: string;
  /** Tag number the mutation belongs to (reasoning watermark records). */
  readonly tag?: number;
}

function classifyRecordingPart(raw: Record<string, unknown>): TranscriptPartKind {
  switch (raw.type) {
    case "text":
      return "text";
    case "reasoning":
    case "thinking":
      return "thinking";
    case "tool": {
      const state = isRecord(raw.state) ? raw.state : null;
      return state !== null && state.output !== undefined ? "tool_result" : "tool_use";
    }
    case "image":
      return "image";
    default:
      return "unknown";
  }
}

/**
 * Recording TranscriptPart: wraps one RawMessage part, exposes the shared
 * `TranscriptPart` mutation surface, and records every mutation on its
 * owning RecordingMessage instead of changing any source array.
 */
export class RecordingPart implements TranscriptPart {
  readonly kind: TranscriptPartKind;
  readonly id: string | undefined;
  readonly partIndex: number;
  private readonly owner: RecordingMessage;
  private readonly raw: Record<string, unknown>;
  private readonly toolName: string | undefined;
  private readonly callId: string | undefined;
  private payload: string | undefined;
  private input: Record<string, unknown> | null;

  constructor(owner: RecordingMessage, partIndex: number, raw: unknown) {
    this.owner = owner;
    this.partIndex = partIndex;
    this.raw = isRecord(raw) ? raw : {};
    this.kind = classifyRecordingPart(this.raw);
    this.callId = typeof this.raw.callID === "string" ? this.raw.callID : undefined;
    this.toolName = typeof this.raw.tool === "string" ? this.raw.tool : undefined;
    this.id = this.callId;
    this.input = this.readInputState();
    this.payload = this.initPayload();
  }

  private readInputState(): Record<string, unknown> | null {
    if (this.kind !== "tool_use" && this.kind !== "tool_result") return null;
    const state = isRecord(this.raw.state) ? this.raw.state : null;
    return state !== null && isRecord(state.input) ? state.input : null;
  }

  private initPayload(): string | undefined {
    if (this.kind === "text") return typeof this.raw.text === "string" ? this.raw.text : "";
    if (this.kind === "thinking") {
      const text = typeof this.raw.text === "string" ? this.raw.text : undefined;
      return text ?? (typeof this.raw.thinking === "string" ? this.raw.thinking : "");
    }
    if (this.kind === "tool_use") return JSON.stringify(this.input ?? {});
    if (this.kind === "tool_result") {
      const state = isRecord(this.raw.state) ? this.raw.state : null;
      const output = state !== null ? state.output : undefined;
      if (typeof output === "string") return output;
      return output !== undefined ? JSON.stringify(output) : "";
    }
    return "";
  }

  private record(field: RecordingPartField, from: string, to: string, tag?: number): void {
    const record: MutationRecord = {
      partIndex: this.partIndex,
      field,
      from,
      to,
      ...(tag !== undefined ? { tag } : {}),
    };
    this.owner.mutations.push(record);
  }

  getText(): string | undefined {
    return this.payload;
  }

  setText(newText: string): boolean {
    if (newText === this.payload) return false;
    const from = this.payload ?? "";
    this.payload = newText;
    this.record("text", from, newText);
    return true;
  }

  setToolOutput(newText: string): boolean {
    if (newText === this.payload) return false;
    const from = this.payload ?? "";
    this.payload = newText;
    this.record("output", from, newText);
    return true;
  }

  getToolInput(): Record<string, unknown> | null {
    return this.input;
  }

  setToolInput(input: Record<string, unknown>): boolean {
    if (input === this.input) return false;
    const from = JSON.stringify(this.input ?? {});
    this.input = input;
    this.record("input", from, JSON.stringify(input));
    return true;
  }

  getToolMetadata(): {
    toolName: string | undefined;
    inputByteSize: number;
    inputTokenCount: number;
  } {
    if (this.kind === "tool_use" || this.kind === "tool_result") {
      return {
        toolName: this.toolName,
        inputByteSize: byteSize(JSON.stringify(this.input ?? {})),
        inputTokenCount: 0,
      };
    }
    return { toolName: undefined, inputByteSize: 0, inputTokenCount: 0 };
  }

  replaceWithSentinel(sentinelText: string): boolean {
    if (this.payload === sentinelText) return false;
    const from = this.payload ?? "";
    this.payload = sentinelText;
    this.record("sentinel", from, sentinelText);
    return true;
  }

  /** Deterministic text rendering of this part's CURRENT state. */
  render(): string | null {
    if (this.kind === "thinking" || this.kind === "image") return null;
    const payload = this.payload ?? "";
    if (this.kind === "text" || this.kind === "unknown") return payload.length > 0 ? payload : null;
    if (DROPPED_SENTINEL_PATTERN.test(payload)) return payload.length > 0 ? payload : null;
    const head = this.kind === "tool_use" ? "tool" : "tool result";
    const lines = [
      `[${head}: ${this.toolName ?? "tool"}${this.callId ? ` #${this.callId}` : ""}]`,
    ];
    if (this.input) lines.push(`input: ${JSON.stringify(this.input)}`);
    if (this.kind === "tool_result" && payload.length > 0) lines.push(`output:\n${payload}`);
    return lines.join("\n");
  }
}

/**
 * Recording TranscriptMessage: accumulates {@link MutationRecord}s from its
 * parts and coalesces them into one op at plan time.
 */
export class RecordingMessage implements TranscriptMessage {
  readonly info: { id?: string; role: string; sessionId?: string };
  readonly parts: RecordingPart[] = [];
  readonly span: DshMessageSpan | null;
  readonly mutations: MutationRecord[] = [];
  /** Same-type surface event type of the message's row (B2). */
  readonly surfaceType: SurfaceType;
  /** Turn the message belongs to (0 = pre-turn); gate input for B2. */
  readonly turn: number;
  /** ORIGINAL dsh content blocks the row was derived from (renderBlocks). */
  readonly contentBlocks: readonly unknown[];

  constructor(
    info: { id?: string; role: string; sessionId?: string },
    span: DshMessageSpan | null,
    surfaceType: SurfaceType,
    turn: number,
    contentBlocks: readonly unknown[],
  ) {
    this.info = info;
    this.span = span;
    this.surfaceType = surfaceType;
    this.turn = turn;
    this.contentBlocks = contentBlocks;
  }

  addPart(raw: unknown): RecordingPart {
    const part = new RecordingPart(this, this.parts.length, raw);
    this.parts.push(part);
    return part;
  }

  isDirty(): boolean {
    return this.mutations.length > 0;
  }

  /**
   * True when every mutation is a tagger prefix injection on a text part
   * (field "text", new value starts with a well-formed `§N§ ` prefix). This is
   * DISCRIMINATED from heuristic/caveman text edits (whose `to` never carries
   * the prefix — caveman compresses from the persisted original and writes the
   * bare compressed text) and from drops/reasoning (sentinels/fields).
   */
  onlyTagPrefixDirty(): boolean {
    if (this.mutations.length === 0) return false;
    return this.mutations.every((record) => record.field === "text" && TAG_PREFIX_PATTERN.test(record.to));
  }

  /** Coalesced op kind: the "worst" of this message's mutations (drops > reasoning > tags). */
  opKind(): MutationKind {
    if (
      this.mutations.some(
        (record) =>
          record.field === "sentinel" ||
          record.field === "output" ||
          record.field === "input" ||
          DROPPED_SENTINEL_PATTERN.test(record.to),
      )
    ) {
      return "drops";
    }
    if (this.mutations.some((record) => record.field === "reasoning")) return "reasoning";
    return "tags";
  }

  /** Deterministic human-readable reason for the coalesced op. */
  reason(): string {
    const parts: string[] = [];
    for (const record of this.mutations) {
      if (record.field === "sentinel") {
        parts.push(`drop → ${record.to}`);
      } else if (record.field === "reasoning") {
        parts.push(`reasoning cleared through tag §${record.tag ?? "?"}§`);
      } else if (/^\u00a7\d+\u00a7/.test(record.to)) {
        const space = record.to.indexOf(" ");
        parts.push(`tag prefix ${space > 0 ? record.to.slice(0, space) : record.to}`);
      } else {
        parts.push(`${record.field} → ${record.to}`);
      }
    }
    return parts.join("; ");
  }

  /** Full Magic-rendered text of this message in its CURRENT (recorded) state. */
  render(): string {
    return this.parts
      .map((part) => part.render())
      .filter((value): value is string => value !== null && value.length > 0)
      .join("\n\n");
  }

  /**
   * Block-preserving render (B2): clone the ORIGINAL dsh content blocks of the
   * message and overlay the recorded per-part mutations, so a pure tag-prefix
   * mutation yields the original blocks with ONLY the first text block prefixed
   * `§N§ ` — roles, tool-call blocks, and every other block preserved verbatim.
   *
   * Parts map to blocks in eligible order (text/tool-call/tool-result/reasoning
   * — the same filter the walk used to build the parts), so a part's recorded
   * final state is applied to its owning original block:
   *   - text part       → block text = mutated text;
   *   - tool-call part  → block `arguments` = JSON.stringify(mutated input);
   *   - tool-result part→ block inner content = [text(mutated output)];
   *   - thinking part   → dropped when the reasoning stage cleared it,
   *                       otherwise kept verbatim.
   * Non-eligible blocks (image/file/unknown, dropped from the parts by the
   * walk) pass through untouched.
   */
  renderBlocks(): ContentBlock[] {
    const out: ContentBlock[] = [];
    let partIndex = 0;
    for (const block of this.contentBlocks) {
      if (!isRecord(block)) {
        out.push(block as unknown as ContentBlock);
        continue;
      }
      const kind = classifyBlockKind(block);
      if (kind === "ineligible") {
        out.push(block as unknown as ContentBlock);
        continue;
      }
      if (kind === "thinking") {
        const part = this.parts[partIndex];
        partIndex += 1;
        // Existing replay logic drops cleared reasoning entirely.
        const reasoningCleared = this.mutations.some(
          (record) =>
            record.partIndex === part?.partIndex &&
            record.field === "reasoning" &&
            record.to === "[cleared]",
        );
        if (!reasoningCleared) out.push(block as unknown as ContentBlock);
        continue;
      }
      const part = this.parts[partIndex];
      partIndex += 1;
      if (kind === "text") {
        if (part === undefined) {
          // Pairing miss (malformed/multi-block row): fail open — keep the
          // original block untouched; the pre-step message loop has no
          // try/catch, so renderBlocks must never throw.
          out.push(block as unknown as ContentBlock);
          continue;
        }
        out.push({ ...block, text: part.getText() ?? "" } as unknown as ContentBlock);
      } else if (kind === "tool-call") {
        out.push({
          ...block,
          arguments: JSON.stringify(part?.getToolInput() ?? {}),
        } as unknown as ContentBlock);
      } else if (kind === "tool-result" && this.surfaceType === "tool/result") {
        // One block per tool row; the recorded payload IS the mutated output.
        const text = part?.getText() ?? "";
        out.push({ ...block, content: [{ type: "text", text }] } as unknown as ContentBlock);
      } else {
        out.push(block as unknown as ContentBlock);
      }
    }
    return out;
  }
}

/** Recording Transcript: same shape the shared tagTranscript walks. */
export class RecordingTranscript implements Transcript {
  readonly harness: "opencode" = "opencode";
  readonly messages: RecordingMessage[];

  constructor(messages: RecordingMessage[]) {
    this.messages = messages;
  }

  /** Recording never mutates source arrays; nothing to commit. */
  commit(): void {}
}

/**
 * Recording TagTarget (design §9.3): implements the core TagTarget interface
 * by delegating to the shared tagTranscript-built target. The shared target
 * calls our RecordingParts, so every setContent/drop/truncate/editMarker
 * lands as MutationRecords on the affected messages instead of changing any
 * source array. One tag → one target; per-message records are coalesced into
 * one replace op at plan time.
 */
export class RecordingTagTarget implements TagTarget {
  constructor(
    readonly tagId: number,
    private readonly inner: TagTarget,
  ) {}

  setContent(content: string): boolean {
    return this.inner.setContent(content);
  }

  getContent(): string | null {
    return this.inner.getContent?.() ?? null;
  }

  drop(): ToolDropResult {
    return this.inner.drop?.() ?? "absent";
  }

  truncate(): ToolDropResult {
    return this.inner.truncate?.() ?? "absent";
  }

  editMarker(): ToolDropResult {
    return this.inner.editMarker?.() ?? "absent";
  }

  canDrop(): boolean {
    return this.inner.canDrop?.() ?? false;
  }

  readInput(): Record<string, unknown> | null {
    return this.inner.readInput?.() ?? null;
  }

  get message(): MessageLike | undefined {
    return this.inner.message;
  }
}

/* ────────────────────────────── plan derivation ───────────────────────────── */

function buildRecordingTranscript(
  view: DshTranscriptView,
): { transcript: RecordingTranscript; byMessageId: Map<string, RecordingMessage> } {
  const messages: RecordingMessage[] = [];
  const byMessageId = new Map<string, RecordingMessage>();
  for (const raw of view.messages) {
    // Knowledge-baseline (m0/m1) messages stay out of the tag/drop pipeline:
    // the coordinator's surface replace would give them a NEW event id each
    // pass, so tag numbers (and §N§ prefixes) would churn forever — the
    // replay invariant (design §3) would break. They remain in the view
    // (digest + cache classification) but never produce ops.
    //
    // Skill-catalog reminders (dsh-tool-skill) get the same protection: the
    // catalog's digest must stay visible to the session surface unchanged or
    // catalogHistory() cannot find the published digest and dsh-tool-skill
    // re-injects the <system-reminder> on every pre-step. Tagging/prefixing
    // them would force a surface replace each round (new seq), breaking the
    // visible-digest invariant and causing the per-round catalog loop.
    //
    // Agent-instructions (6500a728) and dsh-system-prompt snapshots are also
    // durable injected context — large, stable, compress gain ≈0. The magic-context
    // surface replace shadows them, visibleBaselineSource / RuntimeContextProjection
    // see them missing, and the host re-injects them every step, causing the
    // injection-compression loop (session-11d586ad: 116 baselines + 58 snapshots
    // re-injected each round). They must stay out of the pipeline too.
    if (isDurableInjectedMessage(raw)) continue;
    const message = new RecordingMessage(
      { id: raw.id, role: raw.role, sessionId: view.sessionId },
      messageNodeSpan(raw),
      messageSurfaceType(raw),
      messageTurn(raw),
      messageContentBlocks(raw),
    );
    for (const part of raw.parts) message.addPart(part);
    messages.push(message);
    if (typeof raw.id === "string") byMessageId.set(raw.id, message);
  }
  return { transcript: new RecordingTranscript(messages), byMessageId };
}

/**
 * Temporary cache classification (design §6 stand-in). Rules:
 *   - pure tail append (insertion at/after the last surface node) → soft-plus;
 *   - a replace covering a knowledge-baseline node (m0/m1) → hard;
 *   - everything else → soft.
 * The cache-classification slice owns the official `classifyPlan`; this is
 * replaced at integration.
 */
export function minimalCacheClassForOp(
  range: { readonly start: number; readonly end: number },
  surfaceNodeCount: number,
  baselineNodeIndices: readonly number[] = [],
): CacheClass {
  if (range.start >= surfaceNodeCount) return "soft-plus";
  for (let i = range.start; i < range.end; i += 1) {
    if (baselineNodeIndices.includes(i)) return "hard";
  }
  return "soft";
}

function baselineNodeIndices(view: DshTranscriptView): number[] {
  // Collect all durable injected baselines for hard cache classification symmetry
  // (knowledge, skill-catalog, agent-instructions, dsh-system-prompt). Any op
  // covering these nodes must be hard — compress gain ≈0 and host re-injects
  // when shadowed (session-11d586ad loop). Backward compat: knowledge-only
  // baseline was the original; now expanded to isDurableInjectedMessage.
  const out: number[] = [];
  for (const message of view.messages) {
    if (!isDurableInjectedMessage(message)) continue;
    const span = messageNodeSpan(message);
    if (span !== null) out.push(span.nodeStart);
  }
  return out;
}

/**
 * Stage 1: temporal gap markers (design §9.10.1). Idempotent: skipped when
 * the user message already carries a marker prefix or the immediately
 * preceding message IS a marker message. Produces "insertion" ops with
 * start === end === insertion point (the user message's node span start) and
 * empty shadowedSeqs. NOTE for the coordinator slice: the DSH surface has no
 * pure-insert surface op, so insertion ops must be merged into an adjacent
 * replace (or appended at the tail) at apply time.
 */
function planTemporalMarkers(view: DshTranscriptView): MutationOp[] {
  const ops: MutationOp[] = [];
  const baseline = baselineNodeIndices(view);
  let prev: RawMessage | null = null;
  for (const message of view.messages) {
    const isGapEligibleUser =
      message.role === "user" &&
      !isDurableInjectedMessage(message) &&
      !isSyntheticUserMessage(message);
    if (isGapEligibleUser && prev !== null) {
      const prevTime = typeof prev.createdAt === "number" ? prev.createdAt : null;
      const currTime = typeof message.createdAt === "number" ? message.createdAt : null;
      if (prevTime !== null && currTime !== null) {
        const gapSeconds = Math.floor((currTime - prevTime) / 1000);
        const marker = temporalMarkerPrefix(gapSeconds);
        if (marker !== null && !hasTemporalMarker(message) && !isTemporalMarkerMessage(prev)) {
          const span = messageNodeSpan(message);
          if (span !== null) {
            ops.push({
              kind: "temporal",
              start: span.nodeStart,
              end: span.nodeStart,
              replacement: marker,
              // Insertion ops have no shadowed node; the coordinator merges
              // them into the node at `start` (a user row) as a user/message.
              surfaceType: "user/message",
              cacheClass: minimalCacheClassForOp(
                { start: span.nodeStart, end: span.nodeStart },
                view.surfaceNodes.length,
                baseline,
              ),
              reason: `temporal gap ${formatGap(gapSeconds) ?? "?"}`,
              shadowedSeqs: [],
            });
          }
        }
      }
    }
    if (!isDurableInjectedMessage(message)) {
      prev = message;
    }
  }
  return ops;
}

function hasTemporalMarker(message: RawMessage): boolean {
  for (const part of message.parts) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
    return TEMPORAL_MARKER_PATTERN.test(peelLeadingMcTagNotation(part.text).body);
  }
  return false;
}

/** True when every non-empty text part of the message is a temporal marker. */
function isTemporalMarkerMessage(message: RawMessage): boolean {
  let sawMarker = false;
  for (const part of message.parts) {
    if (!isRecord(part) || part.type !== "text") continue;
    const text = typeof part.text === "string" ? part.text : "";
    if (text.trim().length === 0) continue;
    if (TEMPORAL_MARKER_PATTERN.test(peelLeadingMcTagNotation(text).body)) {
      sawMarker = true;
    } else {
      return false;
    }
  }
  return sawMarker;
}

/**
 * Stage 5: reasoning replay (design §9.10.7, Pi `replayClearedReasoning`
 * mirror). For assistant messages whose max tag number is at or below the
 * `clearedReasoningThroughTag` watermark and whose content still carries
 * reasoning blocks, record a reasoning mutation — the message's replacement
 * render then excludes the reasoning. Minimal deterministic version; the
 * watermark-advancing clear pass and inline `<thinking>` stripping land in
 * Phase 4 (the coordinator owns pass type).
 */
function planReasoningReplay(
  view: DshTranscriptView,
  byMessageId: ReadonlyMap<string, RecordingMessage>,
  targets: ReadonlyMap<number, TagTarget>,
  db: Database,
): void {
  const meta = getOrCreateSessionMeta(db, view.sessionId);
  const watermark = typeof meta.clearedReasoningThroughTag === "number" ? meta.clearedReasoningThroughTag : 0;
  if (watermark <= 0) return;

  const maxTagById = new Map<string, number>();
  for (const [tagId, target] of targets) {
    const id = target.message?.info?.id;
    if (typeof id !== "string" || id.length === 0) continue;
    const prev = maxTagById.get(id) ?? 0;
    if (tagId > prev) maxTagById.set(id, tagId);
  }

  for (const message of view.messages) {
    if (message.role !== "assistant" || typeof message.id !== "string") continue;
    const msgTag = maxTagById.get(message.id) ?? 0;
    if (msgTag === 0 || msgTag > watermark) continue;
    const reasoningTexts: string[] = [];
    for (const part of message.parts) {
      if (!isRecord(part)) continue;
      const type = part.type;
      if (type !== "reasoning" && type !== "thinking") continue;
      const text =
        typeof part.text === "string"
          ? part.text
          : typeof part.thinking === "string"
            ? part.thinking
            : "";
      if (text.length > 0 && text !== "[cleared]") reasoningTexts.push(text);
    }
    if (reasoningTexts.length === 0) continue;
    const recording = byMessageId.get(message.id);
    if (!recording) continue;
    recording.mutations.push({
      partIndex: -1,
      field: "reasoning",
      from: reasoningTexts.join("\n"),
      to: "[cleared]",
      tag: msgTag,
    });
  }
}

/**
 * Derive a MutationPlan from the view + shared DB state (design §3).
 *
 * Pipeline (this slice: stages 1-5 of §9.10, all through the recording
 * layer — the view's messages are never mutated):
 *   1. temporal gap markers (idempotent insertion ops);
 *   2. tagTranscript (shared; §N§ prefix injections recorded on parts);
 *   3. applyPendingOperations (shared, recording TagTargets, preloaded reads);
 *   4. applyFlushedStatuses (every pass; byte-level drop replay);
 *   5. reasoning replay from the clearedReasoningThroughTag watermark.
 *
 * Determinism: the view is immutable, so re-deriving from the same log +
 * DB state yields byte-identical ops (replay invariant). Returns null when
 * nothing changed.
 */
export function deriveMutationPlan(view: DshTranscriptView, ctx: PlanContext): MutationPlan | null {
  const db = ctx.db;
  const sessionId = view.sessionId;
  // Upstream token-mass protection window (replaces the old newest-N count):
  // resolve the epoch floor (dsh carries no absolute override, so the floor
  // derives from usableSoft) and walk the persisted tool rows. Every dsh
  // pre-step rebuilds the wire, so each pass is epoch-resolving like a
  // cache-busting pass upstream. usableSoft resolves from the session's
  // detected context limit, the session_meta usage columns, or the shared
  // 200k default — never 0 (see sessionUsableSoftOf).
  const usableSoft = ctx.usableSoft ?? sessionUsableSoftOf(db, sessionId);
  const protectionWindow = getProtectionWindowForSession(
    db,
    sessionId,
    resolveEpochFloorForPass(db, sessionId, {
      usableSoft,
      isCacheBustingPass: true,
    }).floor,
  );

  const ops: MutationOp[] = [...planTemporalMarkers(view)];

  const { transcript, byMessageId } = buildRecordingTranscript(view);
  if (transcript.messages.length > 0) {
    const tagger = createTagger();
    tagger.initFromDb(sessionId, db);
    const tagged = tagTranscript(sessionId, transcript, tagger, db);

    // Wrap the shared targets: recording targets delegate to them, and the
    // shared targets call our recording parts — every mutation is recorded.
    const recordingTargets = new Map<number, TagTarget>();
    for (const [tagId, target] of tagged.targets) {
      recordingTargets.set(tagId, new RecordingTagTarget(tagId, target));
    }

    // Preloaded reads: avoid re-reading tags/pending ops inside the shared
    // stages (the transaction body reads them otherwise).
    const preloadedTags = getTagsBySession(db, sessionId);
    const preloadedPendingOps = getPendingOps(db, sessionId);
    applyPendingOperations(
      sessionId,
      db,
      recordingTargets,
      protectionWindow.protectedTagNumbers,
      preloadedTags,
      preloadedPendingOps,
    );
    applyFlushedStatuses(sessionId, db, recordingTargets, preloadedTags);

    // Heuristic cleanup (Pi/OpenCode parity): routine dedup + optional caveman
    // text compression. Mutations go through the recording targets → dirty →
    // ops, so the surface CAS pipeline handles them exactly like drops.
    const cleanupCfg = ctx.heuristicCleanup;
    if (cleanupCfg !== undefined) {
      try {
        const messageTagNumbers = new Map<MessageLike, number>();
        for (const [tagId, target] of recordingTargets) {
          const message = target.message;
          if (message !== undefined) messageTagNumbers.set(message, tagId);
        }
        applyHeuristicCleanup(
          sessionId,
          db,
          recordingTargets,
          messageTagNumbers,
          {
            protectedTagNumbers: protectionWindow.protectedTagNumbers,
            protectedCutoff: protectionWindow.cutoff,
            caveman: cleanupCfg.caveman,
          },
          preloadedTags,
        );
      } catch {
        // Cleanup must never break the pre-step chain (fail-open).
      }
    }

    planReasoningReplay(view, byMessageId, recordingTargets, db);

    const baseline = baselineNodeIndices(view);
    for (const message of transcript.messages) {
      if (!message.isDirty()) continue;
      // B2: assistant/message rows can never be rewritten — the DSH host's
      // assertProvenance (dsh-session/lib/types/surface.js) rejects ANY
      // assistant/message event carrying sourceEventSeqs, and a replace
      // without them leaves the shadowed node uncovered. Skip their ops so
      // the model's own replies stay byte-identical on the surface (no role
      // corruption, no re-render, no cache bust). THIS IS A HOST CONSTRAINT
      // DEVIATION from the B2 brief (assistant same-type replace "officially
      // supported" is not true on @deepseek-ai/dsh-session@0.1.5-rc.2).
      if (message.surfaceType === "assistant/message") continue;
      // B2 completed-turn gate: a message with ONLY tag-prefix dirt that still
      // belongs to the current INCOMPLETE turn (its turn/end not yet seen)
      // produces no op — the tag is assigned and persisted, the prefix lands
      // once the turn completes (message.turn <= view.currentTurn). Drops /
      // pending ops / flushed statuses / caveman dirt (anything not pure
      // tag-prefix) still produce ops immediately — no gate for those.
      if (message.onlyTagPrefixDirty() && message.turn > view.currentTurn) continue;
      const span = message.span;
      if (span === null || span.seqs.length === 0) continue; // no surface coverage
      ops.push({
        kind: message.opKind(),
        start: span.nodeStart,
        end: span.nodeEnd,
        replacement:
          message.surfaceType === "tool/result" ? message.renderBlocks() : message.render(),
        surfaceType: message.surfaceType,
        cacheClass: minimalCacheClassForOp(
          { start: span.nodeStart, end: span.nodeEnd },
          view.surfaceNodes.length,
          baseline,
        ),
        reason: message.reason(),
        shadowedSeqs: [...span.seqs],
      });
    }
  }

  if (ops.length === 0) return null;
  ops.sort((left, right) => left.start - right.start || left.end - right.end);
  return {
    opId: planOpId(view, ops),
    sessionId: view.sessionId,
    sourceWatermark: view.sourceWatermark,
    inputDigest: view.inputDigest,
    generation: view.generation,
    ops,
  };
}

/**
 * Deterministic plan id (B2): a sha256 digest over
 * {sessionId, generation, inputDigest, ops:[{start, end, shadowedSeqs,
 * surfaceType, digest-of-render}]}, formatted `mc-<24 hex>`. Re-deriving the
 * same view + DB state yields the same id, so a crash-retried plan dedups on
 * the outbox opId CAS; any content/generation change yields a different id.
 * (Keeps a same-render-but-new-plan from re-applying and re-busting the
 * provider cache on every pre-step.)
 */
function planOpId(view: DshTranscriptView, ops: readonly MutationOp[]): string {
  const digest = createHash("sha256")
    .update(view.sessionId, "utf8")
    .update("\0", "utf8")
    .update(String(view.generation), "utf8")
    .update("\0", "utf8")
    .update(view.inputDigest, "utf8")
    .update("\0", "utf8");
  for (const op of ops) {
    digest.update(
      JSON.stringify([
        op.kind,
        op.start,
        op.end,
        op.shadowedSeqs,
        op.surfaceType,
        op.replacement,
      ]),
      "utf8",
    );
  }
  return `mc-${digest.digest("hex").slice(0, 24)}`;
}

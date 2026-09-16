import { describe, expect, it } from "bun:test";
import { sessionEventsOf } from "./session-events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, SessionId } from "@deepseek-ai/dsh-session";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  magicUserMessage,
} from "../compat/dsh-0.1/session";
import { createTestDb } from "../test-utils";
import type { Database } from "@magic-context/core/shared/sqlite";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage";
import {
  buildDshOrdinalMap,
  convertDshEventsToRawMessages,
  deriveMutationPlan,
  dshSeqForOrdinal,
  DSH_AGENT_INSTRUCTIONS_KEY,
  DSH_SYSTEM_PROMPT_KEY,
  findKnowledgeBaselineNodeIndices,
  isAgentInstructionsBaselineMessage,
  isDshSystemPromptBaselineMessage,
  isDurableInjectedMessage,
  isKnowledgeBaselineMessage,
  isSkillCatalogBaselineMessage,
  readDshTranscript,
  RecordingMessage,
  type DshTranscriptView,
} from "./transcript";

/** Build a real DSH session with a scripted conversation (append-only). */
function buildSession() {
  const session = Session.create(SessionId("sess-transcript"));
  const user1 = createUserMessage({
    content: [{ type: "text", text: "hello" }],
    source: { kind: "user" },
  });
  session.append("user/message", user1, { surfaceOp: "append" });
  const assistant1 = createAssistantMessage({
    content: [
      { type: "text", text: "let me check" },
      { type: "tool-call", id: "call-1", name: "read_file", arguments: '{"path":"a.ts"}' },
    ],
    provider: "deepseek",
    model: "deepseek-chat",
    source: { kind: "model" },
  });
  session.append("assistant/message", { turn: 1, step: 1, message: assistant1 }, { surfaceOp: "append" });
  const tool1 = createToolResultMessage({
    callId: "call-1",
    content: [{ type: "text", text: "file contents" }],
    isError: false,
  });
  session.append("tool/result", { turn: 1, step: 1, message: tool1 }, { surfaceOp: "append" });
  session.append("tool/call", { turn: 1, step: 1, callId: "call-1", name: "read_file", arguments: "{}" });
  const user2 = createUserMessage({
    content: [{ type: "text", text: "thanks" }],
    source: { kind: "user" },
  });
  session.append("user/message", user2, { surfaceOp: "append" });
  const assistant2 = createAssistantMessage({
    content: [{ type: "text", text: "done" }],
    provider: "deepseek",
    model: "deepseek-chat",
    source: { kind: "model" },
  });
  session.append("assistant/message", { turn: 2, step: 1, message: assistant2 }, { surfaceOp: "append" });
  // Dangling tool result at the tail (no following user).
  const tool2 = createToolResultMessage({
    callId: "call-2",
    content: [{ type: "text", text: "tail output" }],
    isError: false,
  });
  session.append("tool/result", { turn: 2, step: 1, message: tool2 }, { surfaceOp: "append" });
  return session;
}

function viewOf(session: Session): DshTranscriptView {
  return readDshTranscript({
    session: {
      events: sessionEventsOf(session),
      surface: session.surface,
      header: { cwd: "C:/work" },
    },
    canonicalSessionId: "dsh:a1b2c3d4:sess-transcript",
  });
}

async function cleanupDir(dir: string, db?: Database): Promise<void> {
  try {
    db?.close();
  } catch {
    // already closed
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

describe("transcript mapping (DSH events → RawMessage[])", () => {
  it("maps every surface event to its own row (B2 per-node: no tool-result folding)", () => {
    const session = buildSession();
    const messages = convertDshEventsToRawMessages(sessionEventsOf(session));
    // user1, assistant1(tool-call), tool1, user2, assistant2, tool2 — one row
    // per surface event, roles preserved (no flattening into user rows).
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant", "tool"]);
    expect(messages.map((m) => m.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
    // The tool-call assistant keeps its tool part; the tool row owns the result.
    const assistant1 = messages[1]!;
    expect(assistant1.parts.some((p) => isToolPart(p, "call-1"))).toBe(true);
    const tool1 = messages[2]!;
    expect(tool1.role).toBe("tool");
    expect(tool1.parts.some((p) => isToolPart(p, "call-1"))).toBe(true);
    // Tail tool result stays a tool row (no synthetic user tail).
    const tail = messages[5]!;
    expect(tail.role).toBe("tool");
    expect(tail.id.startsWith("synth-user-")).toBe(false);
  });

  it("builds a reversible seq ↔ ordinal map", () => {
    const session = buildSession();
    const events = sessionEventsOf(session);
    const map = buildDshOrdinalMap(events);
    // Every message-producing event maps to its OWN ordinal (no folding).
    const seqs = events.map((e) => e.seq);
    expect(dshSeqForOrdinal(events, 1)).toBe(seqs[0]); // user1
    expect(dshSeqForOrdinal(events, 2)).toBe(seqs[1]); // assistant1
    expect(map.seqToOrdinal.get(seqs[2]!)).toBe(3); // tool1
    expect(dshSeqForOrdinal(events, 4)).toBe(seqs[4]); // user2
    const assistant2Seq = seqs[5]!;
    expect(map.seqToOrdinal.get(assistant2Seq)).toBe(5);
  });

  it("produces a stable read-only view with digest/watermark/generation", () => {
    const session = buildSession();
    const view = viewOf(session);
    expect(view.sessionId).toBe("dsh:a1b2c3d4:sess-transcript");
    expect(view.generation).toBe(0);
    expect(view.sourceWatermark).toBe(sessionEventsOf(session)[sessionEventsOf(session).length - 1]!.seq);
    expect(view.inputDigest.length).toBe(16);
    expect(view.surfaceNodes).toEqual([...session.surface.nodes]);
    // Same input → same digest.
    expect(viewOf(session).inputDigest).toBe(view.inputDigest);
  });

  it("detects the Magic knowledge baseline (m0) in the surface", () => {
    const session = Session.create(SessionId("sess-kb"));
    session.append(
      "user/message",
      magicUserMessage("knowledge baseline", {
        kind: "plugin",
        plugin: "magic-context",
        messageId: "mc-kb:1:digest",
      }),
      { surfaceOp: "append" },
    );
    session.append(
      "user/message",
      createUserMessage({ content: [{ type: "text", text: "hi" }], source: { kind: "user" } }),
      { surfaceOp: "append" },
    );
    const view = viewOf(session);
    expect(view.messages.some((m) => isKnowledgeBaselineMessage(m))).toBe(true);
    const indices = findKnowledgeBaselineNodeIndices(sessionEventsOf(session), view.surfaceNodes);
    expect(indices).toEqual([0]);
  });

  it("detects agent-instructions and dsh-system-prompt baselines via view markers and source fallback", () => {
    const session = Session.create(SessionId("sess-durable"));
    const aiMsg = createUserMessage({
      content: [{ type: "text", text: "agent instructions" }],
      source: { kind: "agent-instructions" } as never,
    });
    session.append("user/message", aiMsg, { surfaceOp: "append" });
    const promptMsg = createUserMessage({
      content: [{ type: "text", text: "system prompt snapshot" }],
      source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" } as never,
    });
    session.append("user/message", promptMsg, { surfaceOp: "append" });
    const view = viewOf(session);
    const aiView = view.messages.find((m) => isAgentInstructionsBaselineMessage(m))!;
    const promptView = view.messages.find((m) => isDshSystemPromptBaselineMessage(m))!;
    expect(aiView).toBeDefined();
    expect(promptView).toBeDefined();
    expect(isDurableInjectedMessage(aiView)).toBe(true);
    expect(isDurableInjectedMessage(promptView)).toBe(true);
    // Baseline helpers fallback to source when marker absent
    const rawAi: any = { source: { kind: "agent-instructions" }, parts: [] };
    const rawPrompt: any = { source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" }, parts: [] };
    expect(isAgentInstructionsBaselineMessage(rawAi)).toBe(true);
    expect(isDshSystemPromptBaselineMessage(rawPrompt)).toBe(true);
    // Marker path
    const markerAi: any = { source: { kind: "user" }, parts: [] };
    Object.defineProperty(markerAi, DSH_AGENT_INSTRUCTIONS_KEY, { value: true, enumerable: false });
    expect(isAgentInstructionsBaselineMessage(markerAi)).toBe(true);
    const markerPrompt: any = { source: { kind: "user" }, parts: [] };
    Object.defineProperty(markerPrompt, DSH_SYSTEM_PROMPT_KEY, { value: true, enumerable: false });
    expect(isDshSystemPromptBaselineMessage(markerPrompt)).toBe(true);
    // Non-durable is false
    const normal: any = { source: { kind: "user" }, parts: [{ type: "text", text: "hi" }] };
    expect(isDurableInjectedMessage(normal as any)).toBe(false);
  });

  it("isDurableInjectedMessage covers all durable kinds and buildRecordingTranscript skips them (no ops)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-durable-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = Session.create(SessionId("sess-durable-skip"));
      const aiCatalog = createUserMessage({
        content: [{ type: "text", text: "agent instructions durable" }],
        source: { kind: "agent-instructions" } as never,
      });
      session.append("user/message", aiCatalog, { surfaceOp: "append" });
      const promptSnap = createUserMessage({
        content: [{ type: "text", text: "prompt snapshot" }],
        source: { kind: "plugin", plugin: "@deepseek-ai/dsh-system-prompt" } as never,
      });
      session.append("user/message", promptSnap, { surfaceOp: "append" });
      const view = viewOf(session);
      expect(view.messages.every((m) => isDurableInjectedMessage(m))).toBe(true);
      const plan = deriveMutationPlan(view, { db, protectedTags: 0 });
      expect(plan).toBeNull();
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });
});

describe("deriveMutationPlan (recording pipeline)", () => {
  it("records §N§ prefix injections on the first pass and replays byte-identically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const view = viewOf(session);

      const first = deriveMutationPlan(view, { db, protectedTags: 0 });
      expect(first).not.toBeNull();
      expect(first!.ops.length).toBeGreaterThan(0);
      // Every landing op is a user- or tool-row tag embed (assistant skips).
      expect(first!.ops.every((op) => op.surfaceType !== "assistant/message")).toBe(true);
      const userOp = first!.ops.find((op) => op.surfaceType === "user/message")!;
      expect(userOp.replacement).toContain("\u00a7");
      // tool rows carry structured block replacements with the prefix inside.
      const toolOp = first!.ops.find((op) => op.surfaceType === "tool/result");
      if (toolOp !== undefined) {
        expect(Array.isArray(toolOp.replacement)).toBe(true);
        const blocks = toolOp.replacement as Array<Record<string, unknown>>;
        expect(blocks[0]!.type).toBe("tool-result");
        expect(JSON.stringify(toolOp.replacement)).toContain("\u00a7");
      }
      expect(first!.sessionId).toBe(view.sessionId);
      expect(first!.inputDigest).toBe(view.inputDigest);
      expect(first!.generation).toBe(view.generation);

      // The view is immutable, so re-deriving against the SAME view yields the
      // same plan (replay invariant) INCLUDING the deterministic opId;
      // surface-side idempotency is enforced by the coordinator's outbox CAS.
      const second = deriveMutationPlan(view, { db, protectedTags: 0 });
      expect(second).not.toBeNull();
      expect(second!.ops).toEqual(first!.ops);
      expect(second!.opId).toBe(first!.opId);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("derives a drop op from a queued pending operation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const view = viewOf(session);
      // First pass assigns tags.
      deriveMutationPlan(view, { db, protectedTags: 0 });
      const tags = getTagsBySession(db, view.sessionId);
      expect(tags.length).toBeGreaterThan(0);
      const textTag = tags.find((t) => t.type === "message")!;
      queuePendingOp(db, view.sessionId, textTag.tagNumber, "drop", Date.now());

      const plan = deriveMutationPlan(view, { db, protectedTags: 0 });
      expect(plan).not.toBeNull();
      const dropOp = plan!.ops.find((op) => op.kind === "drops");
      expect(dropOp).toBeDefined();
      expect(dropOp!.replacement).toContain(`[dropped \u00a7${textTag.tagNumber}\u00a7]`);
      expect(dropOp!.shadowedSeqs.length).toBeGreaterThan(0);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("resolves the protection floor from the 200k default when dsh has no usage limit (f319897f regression)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const view = viewOf(session);
      // First pass assigns tags; no overflow state and no session_meta usage
      // columns exist (dsh has no provider-overflow detection path).
      deriveMutationPlan(view, { db });
      // The floor must resolve to deriveDefaultProtectedTokens(200_000) = 16000
      // and persist. A 0 floor collapses the protection window to the newest
      // tie-group and compacts every older tool arc on every pre-step.
      const row = db
        .prepare("SELECT protected_tokens_effective FROM session_meta WHERE session_id = ?")
        .get(view.sessionId) as { protected_tokens_effective: number | null } | undefined;
      expect(row?.protected_tokens_effective).toBe(16000);
      // The tiny session's whole tool mass sits inside the 16k window: a
      // queued drop on a tool tag must be exempt (no compaction op).
      const tags = getTagsBySession(db, view.sessionId);
      const toolTag = tags.find((t) => t.type === "tool")!;
      queuePendingOp(db, view.sessionId, toolTag.tagNumber, "drop", Date.now());
      const plan = deriveMutationPlan(view, { db });
      expect(plan).not.toBeNull();
      expect(plan!.ops.some((op) => op.kind === "drops")).toBe(false);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("is deterministic: identical views + DB state produce identical ops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const view = viewOf(session);
      const a = deriveMutationPlan(view, { db, protectedTags: 0 })!;
      const b = deriveMutationPlan(view, { db, protectedTags: 0 })!;
      expect(a.ops).toEqual(b.ops);
      // B2: the deterministic opId must be identical for the identical plan.
      expect(a.opId).toMatch(/^mc-[0-9a-f]{24}$/);
      expect(b.opId).toBe(a.opId);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("B2 deterministic opId: any content/render change yields a different id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const view = viewOf(session);
      const planA = deriveMutationPlan(view, { db, protectedTags: 0 })!;
      // A queued drop changes one op's render — the SAME view + new DB state
      // must produce a DIFFERENT deterministic id (the outbox CAS then treats
      // it as a new plan, and the re-derived old id stays deduped).
      deriveMutationPlan(view, { db, protectedTags: 0 }); // assign tags first
      const tags = getTagsBySession(db, view.sessionId);
      const textTag = tags.find((t) => t.type === "message")!;
      queuePendingOp(db, view.sessionId, textTag.tagNumber, "drop", Date.now());
      const planB = deriveMutationPlan(view, { db, protectedTags: 0 })!;
      expect(planB.opId).toMatch(/^mc-[0-9a-f]{24}$/);
      expect(planB.opId).not.toBe(planA.opId);
      // And re-deriving WITH the same state is stable again.
      const planC = deriveMutationPlan(view, { db, protectedTags: 0 })!;
      expect(planC.opId).toBe(planB.opId);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("B2 tool/result drop: same-type op whose block output carries the sentinel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      // Push call-1's tool tag OUT of the protection window: a small usableSoft
      // (10k) shrinks the floor (~800 tokens) below the newest tool mass, so
      // the newest three tool arcs stay protected while call-1 (the oldest,
      // negligible mass) becomes droppable — the state a production drop
      // targets (newest arcs are never reclaim candidates).
      const ctx = { db, usableSoft: 3_000, protectedTags: 0 };
      const appendToolPair = (turn: number, callId: string, outputLen: number) => {
        session.append(
          "assistant/message",
          {
            turn,
            step: 1,
            message: createAssistantMessage({
              content: [
                { type: "text", text: `pair ${callId}` },
                { type: "tool-call", id: callId, name: "read_file", arguments: "{}" },
              ],
              provider: "deepseek",
              model: "deepseek-chat",
              source: { kind: "model" },
            }),
          },
          { surfaceOp: "append" },
        );
        session.append(
          "tool/result",
          {
            turn,
            step: 1,
            message: createToolResultMessage({
              callId,
              content: [{ type: "text", text: "x".repeat(outputLen) }],
              isError: false,
            }),
          },
          { surfaceOp: "append" },
        );
      };
      appendToolPair(3, "call-big-1", 25_000);
      appendToolPair(3, "call-big-2", 1000);
      appendToolPair(3, "call-big-3", 1000);
      appendToolPair(4, "call-big-4", 1000);
      const view = viewOf(session);
      deriveMutationPlan(view, ctx); // assign tags
      const tags = getTagsBySession(db, view.sessionId);
      // call-1 is the OLDEST tool tag (lowest number) — outside the newest-3
      // window once four later tool pairs exist.
      const toolTag = tags.filter((t) => t.type === "tool").sort((a, b) => a.tagNumber - b.tagNumber)[0]!;
      expect(toolTag).toBeDefined();
      queuePendingOp(db, view.sessionId, toolTag.tagNumber, "drop", Date.now());

      const plan = deriveMutationPlan(view, ctx);
      expect(plan).not.toBeNull();
      const dropOp = plan!.ops.find((op) => op.kind === "drops" && op.surfaceType === "tool/result");
      expect(dropOp).toBeDefined();
      // Single-node, same-type.
      expect(dropOp!.start).toBe(dropOp!.end - 1);
      expect(dropOp!.shadowedSeqs.length).toBe(1);
      // The tool-result block keeps its identity; only the output is sentinelized.
      const blocks = dropOp!.replacement as Array<Record<string, unknown>>;
      expect(blocks[0]!.type).toBe("tool-result");
      expect(blocks[0]!.toolCallId).toBe("call-1");
      expect(JSON.stringify(blocks[0]!.content)).toContain(
        `[dropped \u00a7${toolTag.tagNumber}\u00a7]`,
      );
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("regression: old-style mc-op rows (source kind:plugin magic-context) pass through untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = Session.create(SessionId("sess-mcop"));
      const mcOpSeq = session.append(
        "user/message",
        magicUserMessage("§4§ already embedded", {
          kind: "plugin",
          plugin: "magic-context",
          messageId: "mc-op:legacy",
        }),
        { surfaceOp: "append" },
      ).seq;
      const userSeq = session.append(
        "user/message",
        createUserMessage({ content: [{ type: "text", text: "fresh" }], source: { kind: "user" } }),
        { surfaceOp: "append" },
      ).seq;
      const view = readDshTranscript({
        session: { events: sessionEventsOf(session), surface: session.surface, header: {} },
        canonicalSessionId: "dsh:a1b2c3d4:sess-mcop",
      });
      // The old-style row is knowledge-excluded (knowledge baseline marker).
      const mcOpRow = view.messages[0]!;
      expect(isKnowledgeBaselineMessage(mcOpRow)).toBe(true);
      expect(isDurableInjectedMessage(mcOpRow)).toBe(true);
      const plan = deriveMutationPlan(view, { db, protectedTags: 0 });
      // No op ever shadows the mc-op row; the fresh user row gets tagged.
      const ops = plan === null ? [] : plan.ops;
      expect(ops.some((op) => op.shadowedSeqs.includes(mcOpSeq))).toBe(false);
      expect(ops.some((op) => op.shadowedSeqs.includes(userSeq))).toBe(true);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("never mutates the input events or surface (read-only view)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const eventsBefore = JSON.stringify(sessionEventsOf(session));
      const nodesBefore = [...session.surface.nodes];
      const view = viewOf(session);
      deriveMutationPlan(view, { db, protectedTags: 0 });
      expect(JSON.stringify(sessionEventsOf(session))).toBe(eventsBefore);
      expect([...session.surface.nodes]).toEqual(nodesBefore);
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("returns null for an empty session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = Session.create(SessionId("sess-empty"));
      const view = viewOf(session);
      expect(deriveMutationPlan(view, { db, protectedTags: 0 })).toBeNull();
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("B2 same-type ops: assistant tool-call rows are never rewritten; tool rows get their own single-node op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = buildSession();
      const view = viewOf(session);
      const plan = deriveMutationPlan(view, { db, protectedTags: 0 });
      expect(plan).not.toBeNull();
      if (plan === null) return;
      const assistant1Seq = sessionEventsOf(session)[1]!.seq; // assistant1 (tool-call)
      const tool1Seq = sessionEventsOf(session)[2]!.seq; // tool/result call-1
      const assistantIndex = view.surfaceNodes.indexOf(assistant1Seq);
      const tool1Index = view.surfaceNodes.indexOf(tool1Seq);
      expect(assistantIndex).toBeGreaterThanOrEqual(0);
      expect(tool1Index).toBeGreaterThan(assistantIndex);
      // The tool/result row's op is SAME-TYPE and single-node: it replaces
      // exactly the tool node (startSeq === endSeq), never the assistant node
      // (which the host cannot rewrite — assertProvenance).
      const toolOp = plan.ops.find((op) => op.surfaceType === "tool/result" && op.shadowedSeqs.includes(tool1Seq));
      expect(toolOp).toBeDefined();
      expect(toolOp!.start).toBe(tool1Index);
      expect(toolOp!.end).toBe(tool1Index + 1);
      expect(toolOp!.shadowedSeqs).toEqual([tool1Seq]);
      expect(toolOp!.surfaceType).toBe("tool/result");
      // No op shadows the assistant tool-call node.
      expect(plan.ops.some((op) => op.shadowedSeqs.includes(assistant1Seq))).toBe(false);
      // The tool replacement is the ORIGINAL tool-result block with only the
      // output text mutated (callId/isError preserved).
      const blocks = toolOp!.replacement as Array<Record<string, unknown>>;
      expect(blocks[0]!.type).toBe("tool-result");
      expect(blocks[0]!.toolCallId).toBe("call-1");
      expect(JSON.stringify(blocks[0]!.content)).toContain("\u00a7");
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("B2 gate: current-turn pure tag-prefix dirt produces NO op; the same message embeds once its turn completes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-transcript-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = Session.create(SessionId("sess-gated"));
      // Turn 1 OPEN (no turn/end): the user message is the current incomplete turn.
      session.append("turn/start", { turn: 1 });
      const userSeq = session.append(
        "user/message",
        createUserMessage({ content: [{ type: "text", text: "gated task" }], source: { kind: "user" } }),
        { surfaceOp: "append" },
      ).seq;

      const view1 = readDshTranscript({
        session: { events: [...sessionEventsOf(session)], surface: session.surface, header: {} },
        canonicalSessionId: "dsh:a1b2c3d4:sess-gated",
      });
      expect(view1.currentTurn).toBe(0);
      const plan1 = deriveMutationPlan(view1, { db, protectedTags: 0 });
      // Pure tag-prefix dirt on the current incomplete turn → NO op.
      const landingOps1 = plan1 === null ? [] : plan1.ops;
      expect(landingOps1.find((op) => op.shadowedSeqs.includes(userSeq))).toBeUndefined();

      // The turn completes: turn/end 1 → currentTurn=1 → the message embeds.
      session.append("turn/end", { turn: 1, reason: "success" as never });
      const view2 = readDshTranscript({
        session: { events: [...sessionEventsOf(session)], surface: session.surface, header: {} },
        canonicalSessionId: "dsh:a1b2c3d4:sess-gated",
      });
      expect(view2.currentTurn).toBe(1);
      const plan2 = deriveMutationPlan(view2, { db, protectedTags: 0 });
      expect(plan2).not.toBeNull();
      const userOp = plan2!.ops.find((op) => op.shadowedSeqs.includes(userSeq));
      expect(userOp).toBeDefined();
      expect(userOp!.surfaceType).toBe("user/message");
      expect(userOp!.start).toBe(userOp!.end - 1); // single node
      expect(userOp!.replacement).toContain("\u00a7");
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });

  it("B2 renderBlocks: an assistant turn's tool-call blocks survive verbatim with only the first text block prefixed", () => {
    // Direct unit test of the block-preserving renderer. The plan never lands
    // assistant ops (host constraint), but renderBlocks is the shared renderer
    // the same-type tool write-backs run through — its block fidelity is the
    // B2 contract ("preserves every non-text block verbatim").
    const blocks = [
      { type: "text", text: "reading file" },
      { type: "tool-call", id: "call-9", name: "read_file", arguments: '{"path":"a.ts"}' },
    ] as unknown[];
    const message = new RecordingMessage(
      { id: "a9", role: "assistant" },
      null,
      "assistant/message",
      1,
      blocks,
    );
    const textPart = message.addPart({ type: "text", text: "reading file" });
    message.addPart({ type: "tool", tool: "read_file", callID: "call-9", state: { input: { path: "a.ts" } } });
    textPart.setText("\u00a712\u00a7 reading file");
    const rendered = message.renderBlocks();
    expect(rendered.length).toBe(2);
    expect((rendered[0] as { text: string }).text).toBe("\u00a712\u00a7 reading file");
    // The tool-call block is byte-identical to the original.
    expect(JSON.stringify(rendered[1])).toBe(JSON.stringify(blocks[1]));
  });

  it("keeps dsh skill-catalog messages out of the tag/drop pipeline (no ops, marked baseline)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-skillcat-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const session = Session.create(SessionId("sess-skillcat"));
      // dsh-tool-skill's durable catalog reminder: source.kind === 'skill-catalog'.
      const catalog = createUserMessage({
        content: [
          {
            type: "text",
            text: "<system-reminder>\nThe available skill catalog changed…\n</system-reminder>",
          },
        ],
        source: {
          kind: "skill-catalog",
          form: "catalog",
          update: true,
          entries: [{ name: "test-skill", description: "A test skill." }],
        } as never,
      });
      session.append("user/message", catalog, { surfaceOp: "append" });

      const view = viewOf(session);
      // The catalog message is marked as a protected baseline in the view…
      const marked = view.messages.find((m) => isSkillCatalogBaselineMessage(m));
      expect(marked).toBeDefined();
      // …and deriveMutationPlan produces NO ops for it (before the fix the
      // tagger would inject a §N§ prefix → a surface replace each round →
      // the visible catalog digest disappears → dsh-tool-skill re-injects
      // the reminder on every pre-step).
      const plan = deriveMutationPlan(view, { db, protectedTags: 0 });
      expect(plan).toBeNull();
      db.close();
    } finally {
      await cleanupDir(dir);
    }
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isToolPart(part: unknown, callId: string): boolean {
  return isRecord(part) && part.type === "tool" && part.callID === callId;
}

describe("temporal gap markers (Magic temporal-awareness parity)", () => {
  it("inserts a <!-- +Xm --> marker before a user message after a 5+ minute gap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-temporal-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const t0 = Date.now();
      // 手工构造事件：两条用户消息间隔 6 分钟（阈值 5 分钟）。
      const events = [
        { type: "user/message", seq: 1, time: t0, data: { content: [{ type: "text", text: "first message" }], source: { kind: "user" }, role: "user", id: "u1" } },
        { type: "assistant/message", seq: 2, time: t0 + 1000, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "ok" }], source: { kind: "model" }, role: "assistant", id: "a1" } } },
        { type: "user/message", seq: 3, time: t0 + 7 * 60 * 1000, data: { content: [{ type: "text", text: "second message after a gap" }], source: { kind: "user" }, role: "user", id: "u2" } },
      ];
      const view = readDshTranscript({
        session: { events, surface: { nodes: [1, 2, 3], replaceGeneration: 0 }, header: { cwd: "/tmp" } },
        canonicalSessionId: "dsh:a1b2c3d4:sess-temporal",
      });
      const plan = deriveMutationPlan(view, { db, protectedTags: 20 });
      expect(plan).not.toBeNull();
      const temporal = plan!.ops.filter((op) => op.kind === "temporal");
      expect(temporal.length).toBe(1);
      expect(temporal[0]!.replacement).toMatch(/<!-- \+6m -->/);
      db.close();
    } finally {
      await rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not insert a marker for sub-threshold gaps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-temporal-"));
    try {
      const db = await createTestDb(join(dir, "context.db"));
      const t0 = Date.now();
      const events = [
        { type: "user/message", seq: 1, time: t0, data: { content: [{ type: "text", text: "first" }], source: { kind: "user" }, role: "user", id: "u1" } },
        { type: "user/message", seq: 2, time: t0 + 60 * 1000, data: { content: [{ type: "text", text: "second" }], source: { kind: "user" }, role: "user", id: "u2" } },
      ];
      const view = readDshTranscript({
        session: { events, surface: { nodes: [1, 2], replaceGeneration: 0 }, header: { cwd: "/tmp" } },
        canonicalSessionId: "dsh:a1b2c3d4:sess-temporal2",
      });
      const plan = deriveMutationPlan(view, { db, protectedTags: 20 });
      const temporal = (plan?.ops ?? []).filter((op) => op.kind === "temporal");
      expect(temporal.length).toBe(0);
      db.close();
    } finally {
      await rmSync(dir, { recursive: true, force: true });
    }
  });
});

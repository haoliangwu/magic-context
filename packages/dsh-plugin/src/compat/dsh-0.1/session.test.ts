/**
 * compat/dsh-0.1/session — magicToolResultRewrite unit coverage.
 *
 * The B2 same-type tool/result write-back clones the CURRENT event's data
 * envelope and swaps only message.content, so dsh-session's
 * `assertToolResultRewrite` (lib/types/surface.js: "may change only content")
 * passes the fold. These assertions pin the clone contract: every envelope
 * field preserved, ONLY content changed, original event never mutated.
 */
import { describe, expect, it } from "bun:test";
import { Session, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";
import { sessionEventsOf } from "../../agent/session-events";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { magicToolResultRewrite } from "./session";

/** Build a real session holding one tool/result event (error + meta envelope). */
function buildToolResultEvent(): SessionEvent {
  const session = Session.create(SessionId("sess-compat"));
  session.append(
    "user/message",
    createUserMessage({ content: [{ type: "text", text: "hi" }], source: { kind: "user" } }),
    { surfaceOp: "append" },
  );
  session.append(
    "assistant/message",
    {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: "tool-call", id: "c1", name: "read_file", arguments: "{}" }],
        provider: "deepseek",
        model: "deepseek-chat",
        source: { kind: "model" },
      }),
    },
    { surfaceOp: "append" },
  );
  const appended = session.append(
    "tool/result",
    {
      turn: 1,
      step: 2,
      message: createToolResultMessage({
        callId: "c1",
        content: [{ type: "text", text: "boom" }],
        isError: true,
      }),
      error: { name: "EOUT", code: "OUT_CAUGHT" },
      meta: { kind: "fs", path: "a.ts" },
    },
    { surfaceOp: "append", sourceEventSeqs: [SessionSeq(1)] },
  );
  return sessionEventsOf(session)[appended.seq] as SessionEvent;
}

describe("magicToolResultRewrite (B2 same-type tool write-back)", () => {
  it("preserves the envelope verbatim and swaps only message.content", () => {
    const originalEvent = buildToolResultEvent();
    const originalData = JSON.parse(JSON.stringify(originalEvent.data)) as Record<string, unknown>;

    const rewritten = magicToolResultRewrite(originalEvent, [
      {
        type: "tool-result",
        toolCallId: "c1",
        content: [{ type: "text", text: "[dropped \u00a77\u00a7]" }],
        isError: true,
      },
    ]);

    const originalDataView = originalEvent.data as Record<string, unknown>;
    // Envelope: turn/step/error/meta preserved.
    expect(rewritten.turn).toBe(originalDataView.turn);
    expect(rewritten.step).toBe(originalDataView.step);
    expect(rewritten.error).toEqual(originalDataView.error);
    expect(rewritten.meta).toEqual(originalDataView.meta);

    // Message identity + correlation fields preserved.
    const originalMessage = originalDataView.message as Record<string, unknown>;
    const rewrittenMessage = rewritten.message as Record<string, unknown>;
    expect(rewrittenMessage.id).toBe(originalMessage.id);
    expect(rewrittenMessage.role).toBe(originalMessage.role);
    expect(rewrittenMessage.source).toEqual(originalMessage.source);
    const originalBlock = (originalMessage.content as Array<Record<string, unknown>>)[0]!;
    const rewrittenBlock = (rewrittenMessage.content as Array<Record<string, unknown>>)[0]!;
    expect(rewrittenBlock.type).toBe("tool-result");
    expect(rewrittenBlock.toolCallId).toBe(originalBlock.toolCallId);
    expect(rewrittenBlock.isError).toBe(originalBlock.isError);

    // ONLY the output text changed.
    expect(
      JSON.stringify((rewrittenBlock.content as Array<Record<string, unknown>>)[0]),
    ).toContain("[dropped \u00a77\u00a7]");
    expect(JSON.stringify(rewrittenBlock)).not.toBe(JSON.stringify(originalBlock));
    const { content: _rewrittenContent, ...rewrittenRest } = rewrittenMessage;
    const { content: _originalContent1, ...originalRest } = originalMessage;
    expect(rewrittenRest).toEqual(originalRest);
    const { message: _m, ...rewrittenDataRest } = rewritten;
    const { message: _m2, ...originalDataRest } = originalDataView;
    expect(rewrittenDataRest).toEqual(originalDataRest);

    // The original event object is NOT mutated by the rewrite.
    expect(JSON.stringify(originalEvent.data)).toBe(JSON.stringify(originalData));
  });
});
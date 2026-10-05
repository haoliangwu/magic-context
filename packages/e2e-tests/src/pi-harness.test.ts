import { describe, expect, it } from "bun:test";
import { PiTestHarness } from "./pi-harness";
import { PiRpcProtocol } from "./pi-runner/rpc-client";

describe("Pi prompt completion", () => {
  it("waits for the submitted user turn and its ceiling-nudge continuation to settle", async () => {
    const protocol = new PiRpcProtocol();
    const emit = (event: Record<string, unknown>) => protocol.dispatchLine(JSON.stringify(event));
    let settled = false;
    const rpc = {
      onEvent: protocol.onEvent.bind(protocol),
      waitForEvent: protocol.waitForEvent.bind(protocol),
      getExtensionErrors: () => [],
      getStderr: () => "",
      sendCommand: async (method: string) => {
        if (method === "get_state") {
          if (!settled) throw new Error("queried state before submitted turn settled");
          return { success: true, data: { sessionId: "s1", isStreaming: false } };
        }
        setTimeout(() => {
          emit({ type: "agent_start" });
          emit({ type: "agent_end", messages: [{ role: "custom", content: "previous nudge" }] });
          emit({ type: "agent_settled" });
          emit({ type: "agent_start" });
          emit({ type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: "submitted" }] }, { role: "assistant", stopReason: "stop" }] });
          emit({ type: "agent_start" });
          setTimeout(() => {
            emit({ type: "agent_end", messages: [{ role: "custom", customType: "magic-context:ceiling-nudge" }, { role: "assistant", stopReason: "stop" }] });
            settled = true;
            emit({ type: "agent_settled" });
          }, 20);
        }, 0);
        return { success: true };
      },
    };
    const h: PiTestHarness = Object.assign(Object.create(PiTestHarness.prototype), {
      rpc, expectMagicContext: false, turns: [],
    });
    const result = await h.sendPrompt("submitted", { timeoutMs: 200 });
    expect(result.sessionId).toBe("s1");
    expect(result.events.at(-1)?.type).toBe("agent_settled");
    expect(result.events.some((event) => JSON.stringify(event).includes("magic-context:ceiling-nudge"))).toBe(true);
  });

  it("waits for OMP's terminal agent_end after a ceiling-nudge continuation", async () => {
    const protocol = new PiRpcProtocol();
    const emit = (event: Record<string, unknown>) => protocol.dispatchLine(JSON.stringify(event));
    let terminal = false;
    let promptSubmitted = false;
    const rpc = {
      onEvent: protocol.onEvent.bind(protocol),
      waitForEvent: protocol.waitForEvent.bind(protocol),
      getExtensionErrors: () => [],
      getStderr: () => "",
      sendCommand: async (method: string) => {
        if (method === "get_state") {
          // Reading the idle flag before submitting is how the harness avoids
          // racing a steer run; reading it once the turn is in flight would mean
          // the harness had resolved on the non-terminal agent_end below.
          if (promptSubmitted && !terminal) throw new Error("queried state before terminal OMP agent_end");
          return { success: true, data: { sessionId: "s1", isStreaming: false } };
        }
        promptSubmitted = true;
        setTimeout(() => {
          emit({ type: "agent_start" });
          emit({
            type: "agent_end",
            isTerminal: false,
            messages: [
              { role: "user", content: [{ type: "text", text: "submitted" }] },
              { role: "assistant", stopReason: "stop" },
            ],
          });
          emit({ type: "agent_start" });
          setTimeout(() => {
            terminal = true;
            emit({
              type: "agent_end",
              messages: [
                { role: "custom", customType: "magic-context:ceiling-nudge" },
                { role: "assistant", stopReason: "stop" },
              ],
            });
          }, 20);
        }, 0);
        return { success: true };
      },
    };
    const h: PiTestHarness = Object.assign(Object.create(PiTestHarness.prototype), {
      host: "omp", rpc, expectMagicContext: false, turns: [],
    });

    const result = await h.sendPrompt("submitted", { timeoutMs: 200 });

    expect(terminal).toBe(true);
    expect(result.events.at(-1)?.type).toBe("agent_end");
    expect(result.events.at(-1)?.isTerminal).not.toBe(false);
  });

  it("waits for the OMP agent to go idle before submitting the next prompt", async () => {
    const protocol = new PiRpcProtocol();
    const emit = (event: Record<string, unknown>) => protocol.dispatchLine(JSON.stringify(event));
    // Magic Context delivers its Channel-2 ceiling nudge as a steer that starts a
    // fresh agent run once the previous turn's terminal agent_end has been emitted.
    // OMP refuses a prompt while that run owns the agent, so the harness has to
    // look at the host's own state before submitting.
    let nudgeRunning = true;
    const submittedWhileStreaming: string[] = [];
    const providerRequests: string[] = [];
    setTimeout(() => {
      nudgeRunning = false;
      emit({
        type: "agent_end",
        isTerminal: true,
        messages: [
          { role: "custom", customType: "magic-context:ceiling-nudge" },
          { role: "assistant", stopReason: "stop" },
        ],
      });
    }, 40);
    const rpc = {
      onEvent: protocol.onEvent.bind(protocol),
      waitForEvent: protocol.waitForEvent.bind(protocol),
      getExtensionErrors: () => [],
      getStderr: () => "",
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
        if (method === "get_state") {
          return { success: true, data: { sessionId: "s1", isStreaming: nudgeRunning } };
        }
        const message = String(params?.message ?? "");
        if (nudgeRunning) {
          submittedWhileStreaming.push(message);
          setTimeout(() => {
            emit({
              type: "response",
              command: "prompt",
              success: false,
              error:
                "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.",
            });
          }, 0);
          return { success: true };
        }
        providerRequests.push(message);
        setTimeout(() => {
          emit({ type: "agent_start" });
          emit({
            type: "agent_end",
            isTerminal: true,
            messages: [
              { role: "user", content: [{ type: "text", text: message }] },
              { role: "assistant", stopReason: "stop" },
            ],
          });
        }, 0);
        return { success: true };
      },
    };
    const h: PiTestHarness = Object.assign(Object.create(PiTestHarness.prototype), {
      host: "omp", rpc, expectMagicContext: false, turns: [],
    });

    const result = await h.sendPrompt("user turn 22: continue.", { timeoutMs: 2_000 });

    expect(submittedWhileStreaming).toEqual([]);
    expect(providerRequests).toEqual(["user turn 22: continue."]);
    expect(result.sessionId).toBe("s1");
  });

  it("retries a prompt OMP refused because the ceiling-nudge steer claimed the agent", async () => {
    const protocol = new PiRpcProtocol();
    const emit = (event: Record<string, unknown>) => protocol.dispatchLine(JSON.stringify(event));
    // Recorded from the OMP CI failure at turn 22: the harness reads an idle
    // state, the ceiling-nudge steer claims the agent before OMP handles the
    // prompt, and OMP acknowledges the command and then reports the refusal out
    // of band. The refusal and the steer run's terminal agent_end arrive in one
    // synchronous stdout burst, so the retry must not miss that agent_end.
    let nudgeRunning = false;
    const promptCommands: string[] = [];
    const providerRequests: string[] = [];
    const rpc = {
      onEvent: protocol.onEvent.bind(protocol),
      waitForEvent: protocol.waitForEvent.bind(protocol),
      getExtensionErrors: () => [],
      getStderr: () => "",
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
        if (method === "get_state") {
          return { success: true, data: { sessionId: "s1", isStreaming: nudgeRunning } };
        }
        const message = String(params?.message ?? "");
        promptCommands.push(message);
        if (promptCommands.length === 1) {
          nudgeRunning = true;
          setTimeout(() => {
            emit({
              type: "response",
              command: "prompt",
              success: false,
              error:
                "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.",
            });
            emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
            emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop" } });
            nudgeRunning = false;
            emit({
              type: "agent_end",
              isTerminal: true,
              messages: [
                { role: "custom", customType: "magic-context:ceiling-nudge" },
                { role: "assistant", stopReason: "stop" },
              ],
            });
          }, 0);
          return { success: true };
        }
        providerRequests.push(message);
        setTimeout(() => {
          emit({ type: "agent_start" });
          emit({
            type: "agent_end",
            isTerminal: true,
            messages: [
              { role: "user", content: [{ type: "text", text: message }] },
              { role: "assistant", stopReason: "stop" },
            ],
          });
        }, 0);
        return { success: true };
      },
    };
    const h: PiTestHarness = Object.assign(Object.create(PiTestHarness.prototype), {
      host: "omp", rpc, expectMagicContext: false, turns: [],
    });

    const result = await h.sendPrompt("user turn 22: continue.", { timeoutMs: 2_000 });

    // Exactly one retry: the refused submission plus the one that landed.
    expect(promptCommands).toEqual(["user turn 22: continue.", "user turn 22: continue."]);
    expect(providerRequests).toEqual(["user turn 22: continue."]);
    expect(result.sessionId).toBe("s1");
  });

  it("fails with the refusal text instead of looping when OMP refuses the retry too", async () => {
    const protocol = new PiRpcProtocol();
    const emit = (event: Record<string, unknown>) => protocol.dispatchLine(JSON.stringify(event));
    const promptCommands: string[] = [];
    const rpc = {
      onEvent: protocol.onEvent.bind(protocol),
      waitForEvent: protocol.waitForEvent.bind(protocol),
      getExtensionErrors: () => [],
      getStderr: () => "",
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
        if (method === "get_state") return { success: true, data: { sessionId: "s1", isStreaming: false } };
        promptCommands.push(String(params?.message ?? ""));
        setTimeout(() => {
          emit({
            type: "response",
            command: "prompt",
            success: false,
            error:
              "Agent is already processing. Use steer() or followUp() to queue messages, or wait for completion.",
          });
          emit({ type: "agent_end", isTerminal: true, messages: [{ role: "assistant", stopReason: "stop" }] });
        }, 0);
        return { success: true };
      },
    };
    const h: PiTestHarness = Object.assign(Object.create(PiTestHarness.prototype), {
      host: "omp", rpc, expectMagicContext: false, turns: [],
    });

    let failure = "";
    try {
      await h.sendPrompt("user turn 22: continue.", { timeoutMs: 2_000 });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    // Two submissions, never a third: the retry is one-shot, not a loop.
    expect(promptCommands).toHaveLength(2);
    expect(failure).toContain("OMP refused the resubmitted prompt");
    expect(failure).toContain("Agent is already processing");
    expect(failure).toContain("--- pi rpc event tail ---");
  });

  it("reports the event tail and last provider request when an RPC event times out", async () => {
    const protocol = new PiRpcProtocol();
    const rpc = {
      onEvent: protocol.onEvent.bind(protocol),
      waitForEvent: protocol.waitForEvent.bind(protocol),
      getExtensionErrors: () => [],
      getStderr: () => "",
      sendCommand: async (method: string) => {
        if (method === "get_state") return { success: true, data: { sessionId: "s1", isStreaming: false } };
        setTimeout(() => {
          protocol.dispatchLine(JSON.stringify({
            type: "agent_end",
            isTerminal: false,
            messages: [{ role: "custom", customType: "magic-context:ceiling-nudge" }],
          }));
        }, 0);
        return { success: true };
      },
    };
    const mock = {
      lastRequest: () => ({
        receivedAt: 1,
        method: "POST",
        path: "/v1/messages",
        headers: {},
        body: {
          model: "mock-model",
          messages: [{ role: "user", content: "previous submitted turn" }],
        },
      }),
    };
    const h: PiTestHarness = Object.assign(Object.create(PiTestHarness.prototype), {
      host: "omp", mock, rpc, expectMagicContext: false, turns: [],
    });

    let failure = "";
    try {
      await h.sendPrompt("missing turn", { timeoutMs: 10 });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    expect(failure).toContain("--- pi rpc event tail ---");
    expect(failure).toContain('"type":"agent_end","isTerminal":false');
    expect(failure).toContain('"customType":"magic-context:ceiling-nudge"');
    expect(failure).toContain("--- last mock provider request body summary ---");
    expect(failure).toContain('"lastUser":{"role":"user","content":{"characters":23,"preview":"previous submitted turn"}}');
  });
});

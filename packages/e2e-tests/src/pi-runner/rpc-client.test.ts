/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { createPiIsolatedEnv } from "./spawn";
import { cleanupE2ETempDir } from "../temp-dir";
import { PassThrough } from "node:stream";
import {
  attachStrictJsonlReader,
  PiRpcProtocol,
  PiRpcClient,
  serializeRpcMessage,
  type PiRpcEvent,
} from "./rpc-client";

describe("Pi RPC protocol", () => {
  it("frames strict JSONL records on LF only", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    attachStrictJsonlReader(stream, (line) => lines.push(line));

    stream.write('{"text":"has \\u2028 separator"}\n{"ok":true}\r\npartial');
    stream.end(" tail");

    await new Promise((resolve) => stream.once("close", resolve));
    expect(lines).toEqual([
      '{"text":"has \\u2028 separator"}',
      '{"ok":true}',
      "partial tail",
    ]);
  });

  it("serializes commands as one JSONL record", () => {
    expect(serializeRpcMessage({ type: "get_state", id: "req-1" })).toBe(
      '{"type":"get_state","id":"req-1"}\n',
    );
  });

  it("correlates responses by id without dispatching them as events", async () => {
    const protocol = new PiRpcProtocol();
    const events: PiRpcEvent[] = [];
    const writes: string[] = [];
    protocol.onEvent((event) => events.push(event));

    const pending = protocol.sendCommand((line) => writes.push(line), "get_state", {}, { timeoutMs: 1_000 });
    const sent = JSON.parse(writes[0]!) as { id: string; type: string };
    expect(sent.type).toBe("get_state");

    protocol.dispatchLine(JSON.stringify({ type: "agent_start" }));
    protocol.dispatchLine(
      JSON.stringify({ id: sent.id, type: "response", command: "get_state", success: true, data: { sessionId: "s1" } }),
    );

    await expect(pending).resolves.toMatchObject({ data: { sessionId: "s1" } });
    expect(events).toEqual([{ type: "agent_start" }]);
  });

  it("waits for matching async events", async () => {
    const protocol = new PiRpcProtocol();
    const wait = protocol.waitForEvent((event) => event.type === "agent_end", { timeoutMs: 1_000 });

    protocol.dispatchLine(JSON.stringify({ type: "message_end" }));
    protocol.dispatchLine(JSON.stringify({ type: "agent_end", messages: [] }));

    await expect(wait).resolves.toMatchObject({ type: "agent_end" });
  });
});


describe("Pi RPC fixture ownership", () => {
  it("removes an owned environment even when startup never reached spawn", async () => {
    const client = new PiRpcClient({ mockProviderURL: "http://127.0.0.1:1" });
    expect(existsSync(client.env.baseDir)).toBe(true);
    await client.shutdown();
    expect(existsSync(client.env.baseDir)).toBe(false);
  });

  it("preserves owned data for a restart but removes it on final shutdown", async () => {
    const client = new PiRpcClient({ mockProviderURL: "http://127.0.0.1:1" });
    try {
      await client.shutdown(2_000, true);
      expect(existsSync(client.env.baseDir)).toBe(true);
    } finally {
      await client.shutdown();
    }
    expect(existsSync(client.env.baseDir)).toBe(false);
  });

  it("does not remove a caller-owned environment on shutdown", async () => {
    const env = createPiIsolatedEnv();
    const client = new PiRpcClient({ mockProviderURL: "http://127.0.0.1:1", env });
    try {
      await client.shutdown();
      expect(existsSync(env.baseDir)).toBe(true);
    } finally {
      cleanupE2ETempDir(env.baseDir);
    }
  });
});

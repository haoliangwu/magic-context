import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { canonicalSessionKey } from "../shared/dsh-harness";
import { createTestDb, createTestStorageDir, type Database } from "../test-utils";
import { resolveKnowledgeProjectPath } from "./knowledge-gate";
import { registerSessionProjectTracking } from "./session-track";

const HOME_HASH = "a1b2c3d4";

interface CapturedHandler {
  (payload: { agent: unknown }): Promise<void>;
}

function fakeCtx(): { ctx: Context; handlers: CapturedHandler[] } {
  const handlers: CapturedHandler[] = [];
  const ctx = {
    on: (_event: string, handler: CapturedHandler) => {
      handlers.push(handler);
    },
  } as unknown as Context;
  return { ctx, handlers };
}

function makeHost(db: Database, directory: string) {
  return {
    ready: Promise.resolve({
      kind: "ok" as const,
      db,
      storageDir: directory,
      livenessPath: "",
    }),
    canonicalKey: (dshSessionId: string) => canonicalSessionKey(HOME_HASH, dshSessionId),
  };
}

function makeAgent(directory: string, headerExtra: Record<string, unknown> = {}) {
  return {
    id: "sess-1",
    session: { header: { cwd: directory, ...headerExtra } },
  };
}

function readProjectPath(db: Database, sessionId: string): string | undefined {
  const row = db
    .prepare("SELECT project_path FROM session_projects WHERE session_id = ? AND harness = 'dsh'")
    .get(sessionId) as { project_path: string } | undefined;
  return row?.project_path;
}

describe("registerSessionProjectTracking", () => {
  it("records the resolved project identity, never the raw cwd", async () => {
    const dir = createTestStorageDir();
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const { ctx, handlers } = fakeCtx();
      registerSessionProjectTracking(ctx, {
        host: makeHost(db, dir),
        directory: dir,
        log: () => {},
      });
      expect(handlers.length).toBe(1);

      await handlers[0]({ agent: makeAgent(dir) });

      const identity = resolveKnowledgeProjectPath(dir);
      expect(identity).toBeDefined();
      const recorded = readProjectPath(db, canonicalSessionKey(HOME_HASH, "sess-1"));
      // The row must carry the resolved git:/dir: identity — a raw cwd would
      // split one project across two dashboard identity groups.
      expect(recorded).toBe(identity);
      expect(recorded).not.toBe(dir);
    } finally {
      await db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips child sessions (parent owns the workspace row)", async () => {
    const dir = createTestStorageDir();
    let db: Database | undefined;
    try {
      db = await createTestDb(join(dir, "context.db"));
      const { ctx, handlers } = fakeCtx();
      registerSessionProjectTracking(ctx, {
        host: makeHost(db, dir),
        directory: dir,
        log: () => {},
      });

      await handlers[0]({ agent: makeAgent(dir, { origin: "subagent" }) });

      expect(readProjectPath(db, canonicalSessionKey(HOME_HASH, "sess-1"))).toBeUndefined();
    } finally {
      await db?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

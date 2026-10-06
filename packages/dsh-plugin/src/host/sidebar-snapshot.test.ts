/**
 * Sidebar-snapshot depth lanes: the `magicContext/sidebar-snapshot` payload
 * mirrors the OpenCode sidebar's DB-derivable count rows (compartments,
 * memories, notes, dreamer recency, transform-error latch) on top of the
 * token breakdown.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createTestDb } from "../test-utils";
import { MagicContextRemoteService } from "./remote";
import type { MagicContextHostService } from "../index";
import type { DshStorageBootstrap } from "./bootstrap";

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

function isolateUserConfigTier(): () => void {
  const home = mkdtempSync(join(tmpdir(), "dsh-magic-side-cfg-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  return () => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  };
}

afterEach(() => {
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
});

function fakeService(db: Database, directory: string): MagicContextRemoteService {
  const ready = Promise.resolve({ kind: "ok", db } satisfies DshStorageBootstrap);
  const host = {
    ready,
    directory,
    canonicalKey: (id: string) => `dsh:${id}`,
    parseKey: (key: string) => (key.startsWith("dsh:") ? { homeHash: "h", dshSessionId: key.slice(4) } : undefined),
    registerSummarizeHook: () => {},
    summarizeHook: () => undefined,
  } as unknown as MagicContextHostService;
  return new MagicContextRemoteService(
    { reflect: { provide: () => {} } } as unknown as Context,
    host,
  );
}

describe("sidebar-snapshot depth lanes", () => {
  it("returns zeroed depth fields for an unknown session (fail-open)", async () => {
    const restore = isolateUserConfigTier();
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-side-"));
    const db = await createTestDb(join(dir, "context.db"));
    try {
      const svc = fakeService(db, dir);
      const snap = await svc["sidebar-snapshot"]({ sessionId: "nope" });
      expect(snap.compartmentCount).toBe(0);
      expect(snap.memoryCount).toBe(0);
      expect(snap.lastTransformError).toBeNull();
      expect(snap.lastDreamerRunAt).toBeNull();
      expect(snap.projectIdentity).toBeNull();
      expect(snap.cacheTtl).toBe("5m");
    } finally {
      db.close();
      restore();
    }
  });

  it("fills count rows and dreamer recency from the shared store", async () => {
    const restore = isolateUserConfigTier();
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-side-"));
    const db = await createTestDb(join(dir, "context.db"));
    try {
      const identity = "dir:testproj";
      const sessionId = "dsh:s1";
      db.prepare(
        `INSERT INTO session_meta (session_id, harness, compartment_in_progress, cache_ttl,
           last_transform_error, memory_block_count, cached_m0_project_identity)
         VALUES (?, 'dsh', 1, '10m', '', 2, ?)`,
      ).run(sessionId, identity);
      db.prepare(
        "INSERT INTO compartments (session_id, sequence, start_message, end_message, title, content, created_at) VALUES (?, 1, 0, 1, 't', 'c', 1)",
      ).run(sessionId);
      db.prepare(
        "INSERT INTO memories (project_path, category, content, normalized_hash, scope, first_seen_at, created_at, updated_at, last_seen_at, status) VALUES (?, 'fact', 'm', 'h1', 'project', 1, 1, 1, 1, 'active')",
      ).run(identity);
      db.prepare(
        "INSERT INTO memories (project_path, category, content, normalized_hash, scope, first_seen_at, created_at, updated_at, last_seen_at, status) VALUES (?, 'fact', 'm', 'h2', 'project', 1, 1, 1, 1, 'archived')",
      ).run(identity);
      db.prepare(
        "INSERT INTO notes (type, status, content, session_id, project_path, created_at, updated_at) VALUES ('session', 'active', 'n', ?, ?, 1, 1)",
      ).run(sessionId, identity);
      db.prepare(
        "INSERT INTO notes (type, status, content, session_id, project_path, created_at, updated_at) VALUES ('smart', 'ready', 'n', ?, ?, 1, 1)",
      ).run(sessionId, identity);
      db.prepare(
        "INSERT INTO task_schedule_state (project_path, task, last_run_at) VALUES (?, 'check-archival', 12345)",
      ).run(identity);

      const svc = fakeService(db, dir);
      const snap = await svc["sidebar-snapshot"]({ sessionId: "s1" });
      expect(snap.projectIdentity).toBe(identity);
      expect(snap.compartmentCount).toBe(1);
      expect(snap.archivedCompartmentCount).toBe(1);
      expect(snap.memoryCount).toBe(1); // archived memory excluded
      expect(snap.memoryBlockCount).toBe(2);
      expect(snap.sessionNoteCount).toBe(1);
      expect(snap.readySmartNoteCount).toBe(1);
      expect(snap.compartmentInProgress).toBe(true);
      expect(snap.historianRunning).toBe(true);
      expect(snap.cacheTtl).toBe("10m");
      expect(snap.lastDreamerRunAt).toBe(12345);
    } finally {
      db.close();
      restore();
    }
  });

  it("surfaces the persisted transform failure", async () => {
    const restore = isolateUserConfigTier();
    const dir = mkdtempSync(join(tmpdir(), "dsh-magic-side-"));
    const db = await createTestDb(join(dir, "context.db"));
    try {
      db.prepare(
        `INSERT INTO session_meta (session_id, harness, last_transform_error)
         VALUES ('dsh:s2', 'dsh', 'boom')`,
      ).run();
      const svc = fakeService(db, dir);
      const snap = await svc["sidebar-snapshot"]({ sessionId: "s2" });
      expect(snap.lastTransformError).toBe("boom");
    } finally {
      db.close();
      restore();
    }
  });
});

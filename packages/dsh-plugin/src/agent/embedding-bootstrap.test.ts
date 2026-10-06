/**
 * embedding-bootstrap tests (DSH adapter).
 *
 * The opencode plugin's embedding-bootstrap suite covers the core
 * registration machinery in depth; these cases pin the DSH adapter's
 * contract: default-feature registration, config-change re-read, and the
 * dreamer maintenance sweep's git-indexing lane.
 *
 * Env isolation mirrors config-rpc.test.ts: the loader reads the user config
 * tier through XDG_CONFIG_HOME, so each test redirects it to a throwaway
 * dir — otherwise the developer's real user config (with {env:} API keys)
 * makes the load UNTRUSTED and registration degrades to observation mode.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, createTestStorageDir } from "../test-utils";
import {
  ensureProjectRegisteredFromDshDirectory,
  resetEmbeddingBootstrapCacheForTests,
} from "./embedding-bootstrap";
import {
  _resetProjectEmbeddingRegistryForTests,
  _setTestProviderFactoryForProject,
  getProjectEmbeddingSnapshot,
} from "@magic-context/core/features/magic-context/memory/embedding";
import { resolveProjectIdentityForSession } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { getCommitCount } from "@magic-context/core/features/magic-context/git-commits/storage-git-commits";
import { __test as dreamerTest } from "./dreamer";
import { AgentPresence } from "./dream-worker";

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;

/** Per-test user-config tier redirect (empty dir → defaults only). */
function isolateUserConfigTier(): () => void {
  const home = mkdtempSync(join(tmpdir(), "dsh-magic-boot-cfg-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;
  return () => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  };
}

afterEach(() => {
  _resetProjectEmbeddingRegistryForTests();
  resetEmbeddingBootstrapCacheForTests();
});

describe("embedding-bootstrap (DSH)", () => {
  it("registers the project embedding provider with default features", async () => {
    const restore = isolateUserConfigTier();
    const dir = await createTestStorageDir();
    const db = await createTestDb(join(dir, "context.db"));
    try {
      const identity = resolveProjectIdentityForSession(dir);
      expect(identity).toBeTruthy();
      await ensureProjectRegisteredFromDshDirectory(dir, db);
      const snapshot = getProjectEmbeddingSnapshot(identity as string);
      expect(snapshot).not.toBeNull();
      expect(snapshot!.provider).not.toBe("off");
      // Schema defaults: memory on, git-commit indexing opt-in off.
      expect(snapshot!.features.memoryEnabled).toBe(true);
      expect(snapshot!.features.gitCommitEnabled).toBe(false);
    } finally {
      db.close();
      restore();
    }
  });

  it("re-reads the config after it changes on disk (mtime-keyed cache)", async () => {
    const restore = isolateUserConfigTier();
    const dir = await createTestStorageDir();
    const db = await createTestDb(join(dir, "context.db"));
    try {
      const identity = resolveProjectIdentityForSession(dir) as string;
      await ensureProjectRegisteredFromDshDirectory(dir, db);
      expect(getProjectEmbeddingSnapshot(identity)!.features.gitCommitEnabled).toBe(false);

      mkdirSync(join(dir, ".cortexkit"), { recursive: true });
      writeFileSync(
        join(dir, ".cortexkit", "magic-context.json"),
        JSON.stringify({ memory: { git_commit_indexing: { enabled: true } } }),
      );
      await ensureProjectRegisteredFromDshDirectory(dir, db);
      expect(getProjectEmbeddingSnapshot(identity)!.features.gitCommitEnabled).toBe(true);
    } finally {
      db.close();
      restore();
    }
  });

  it("the dreamer maintenance sweep indexes git commits when enabled", async () => {
    // A real git repo with one empty commit: the sweep's `git log` lane runs
    // end-to-end through runDshPeriodicMaintenance (registration + git sweep
    // + smart-note lease cycle).
    const restore = isolateUserConfigTier();
    const dir = await createTestStorageDir();
    const db = await createTestDb(join(dir, "context.db"));
    try {
      const git = Bun.spawnSync({
        cmd: [
          "git",
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "init",
          "-q",
          "-b",
          "main",
        ],
        cwd: dir,
      });
      expect(git.exitCode).toBe(0);
      const commit = Bun.spawnSync({
        cmd: [
          "git",
          "-c",
          "user.email=t@t",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "initial",
        ],
        cwd: dir,
      });
      expect(commit.exitCode).toBe(0);

      mkdirSync(join(dir, ".cortexkit"), { recursive: true });
      writeFileSync(
        join(dir, ".cortexkit", "magic-context.json"),
        JSON.stringify({ memory: { git_commit_indexing: { enabled: true } } }),
      );
      // Test provider factory (same pattern as the core's embedding tests):
      // the indexer's embed step must not reach a network/local runtime.
      _setTestProviderFactoryForProject(() => ({
        modelId: "test-embedding",
        initialize: async () => true,
        embed: async () => new Float32Array([1, 0]),
        embedBatch: async (texts: string[]) =>
          texts.map(() => new Float32Array([1, 0])),
        dispose: () => Promise.resolve(),
        isLoaded: () => true,
      }));
      const identity = resolveProjectIdentityForSession(dir) as string;
      expect(identity.startsWith("git:")).toBe(true);
      // A memory row with no embedding: the proactive memory-embed lane (the
      // opencode runProjectMaintenance mirror) must backfill it during the
      // same maintenance pass.
      insertMemory(db, { projectPath: identity, category: "PROJECT_RULES", content: "mem-to-embed" });

      const presence = new AgentPresence();
      presence.observeDirectory(dir);
      const logs: string[] = [];
      await dreamerTest.runDshPeriodicMaintenance(db, identity, { presence } as never, (m) =>
        logs.push(m),
      );
      expect(getProjectEmbeddingSnapshot(identity)!.features.gitCommitEnabled).toBe(true);
      // The git sweep lane indexed the repo's single commit.
      expect(getCommitCount(db, identity)).toBe(1);
      expect(logs.some((m) => m.includes("sweep finished"))).toBe(true);
      // The proactive memory-embedding backfill lane ran (provider is active
      // for this project, so snapshot.enabled is true).
      expect(logs.some((m) => m.includes("proactively embedded 1 memory for"))).toBe(true);
    } finally {
      db.close();
      restore();
    }
  });

  it("skips maintenance entirely when no directory is observed for the identity", async () => {
    const restore = isolateUserConfigTier();
    const dir = await createTestStorageDir();
    const db = await createTestDb(join(dir, "context.db"));
    try {
      const presence = new AgentPresence();
      // No observeDirectory: the identity has no live workspace observation.
      const logs: string[] = [];
      await dreamerTest.runDshPeriodicMaintenance(db, "git:deadbeef", { presence } as never, (m) =>
        logs.push(m),
      );
      expect(logs).toEqual([]);
    } finally {
      db.close();
      restore();
    }
  });

  it("skips and forgets a vanished workspace directory (dead-directory guard)", async () => {
    const restore = isolateUserConfigTier();
    const dir = await createTestStorageDir();
    const db = await createTestDb(join(dir, "context.db"));
    try {
      const presence = new AgentPresence();
      const gone = join(dir, "gone-workspace");
      mkdirSync(gone, { recursive: true });
      presence.observeDirectory(gone);
      const identity = resolveProjectIdentityForSession(gone) as string;
      expect(presence.directoryOf(identity)).toBe(gone);
      rmSync(gone, { recursive: true, force: true });

      const logs: string[] = [];
      await dreamerTest.runDshPeriodicMaintenance(db, identity, { presence } as never, (m) =>
        logs.push(m),
      );
      // Guard fired: skip logged, and the stale observation is dropped.
      expect(logs.some((m) => m.includes("workspace directory vanished"))).toBe(true);
      expect(presence.directoryOf(identity)).toBeUndefined();
      // A second pass with no observation is a silent no-op.
      const logs2: string[] = [];
      await dreamerTest.runDshPeriodicMaintenance(db, identity, { presence } as never, (m) =>
        logs2.push(m),
      );
      expect(logs2).toEqual([]);
    } finally {
      db.close();
      restore();
    }
  });
});

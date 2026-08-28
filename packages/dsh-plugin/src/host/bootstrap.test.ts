import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { bootstrapDshStorage, contextDbPath } from "./bootstrap";
import { canonicalSessionKey } from "../shared/dsh-harness";
import { removeDshLivenessMarker } from "../compat/dsh-0.1/liveness";
import { createTestEnv } from "../test-utils";

describe("dsh storage bootstrap (Phase 1 boundary)", () => {
  it("opens the shared DB with the liveness marker present", async () => {
    const env = await createTestEnv("dsh-magic-boot-");
    // Keep env.db alive at env.dir/context.db; bootstrap uses a separate subdir so the core's path-cache doesn't collide with the helper DB.
    const bootDir = join(env.dir, "boot");
    let livenessPath: string | undefined;
    try {
      const dbPath = join(bootDir, "context.db");
      const outcome = await bootstrapDshStorage({
        directory: join(bootDir, "proj"),
        port: 0,
        dbPath,
        storageDirOverride: bootDir,
        homeHash: "a1b2c3d4",
      });
      expect(outcome.kind).toBe("ok");
      if (outcome.kind !== "ok") return;
      expect(outcome.db).toBeDefined();
      expect(outcome.storageDir).toBe(bootDir);
      // The marker file exists while the process is live.
      expect(outcome.livenessPath).toContain("port-");
      livenessPath = outcome.livenessPath;
      // The shared DB is created at the canonical location.
      expect(contextDbPath(bootDir)).toBe(join(bootDir, "context.db"));
      outcome.db.close();
    } finally {
      if (livenessPath) removeDshLivenessMarker(livenessPath);
      await env.cleanup();
    }
  });

  it("derives canonical session keys", () => {
    expect(canonicalSessionKey("a1b2c3d4", "session-x")).toBe(
      "dsh:a1b2c3d4:session-x",
    );
  });
});

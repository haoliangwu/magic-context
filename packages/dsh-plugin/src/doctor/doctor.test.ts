import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dump as yamlDump, load as yamlLoad } from "js-yaml";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { Database } from "@magic-context/core/shared/sqlite";
import {
  LATEST_SUPPORTED_VERSION,
  openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import { withTestDb } from "../test-utils";
import {
  classifyDatabaseOpen,
  listProfiles,
  profileBundleFacts,
  runDshDoctor,
  scanLivenessMarkers,
} from "./doctor";
import {
  patchShippedPresets,
  rewriteCompactionRowText,
} from "../host/preset-patch";
import {
  DSH_COMPAT_EXPECTED_VERSION,
  MAGIC_CONTEXT_PACKAGE,
  magicStandardDir,
} from "./env";

/** Minimal stand-in for a stock preset entry list (compaction group included). */
function stockLayout(): Record<string, unknown>[] {
  return [
    { id: "persona", name: "@deepseek-ai/dsh-persona", config: { text: "x" } },
    {
      id: "compaction",
      name: "cordis:group",
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
        { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
        { id: "tool-result-pruner", name: "@deepseek-ai/dsh-compaction-tool-result-pruner" },
      ],
    },
    { id: "tool-ask-user", name: "@deepseek-ai/dsh-tool-ask-user" },
  ];
}

/** Fake dsh install: package.json + the 0.1.5-era stock preset layout. */
function fakeInstall(installDir: string, version = DSH_COMPAT_EXPECTED_VERSION): string {
  mkdirSync(installDir, { recursive: true });
  writeFileSync(
    join(installDir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version }),
  );
  const stock = join(installDir, "..", "dsh-agent-presets", "presets", "standard", "agent.cordis.yml");
  mkdirSync(dirname(stock), { recursive: true });
  writeFileSync(stock, yamlDump(stockLayout(), { schema: entryListSchema }));
  return stock;
}

/** Fake `@deepseek-ai/dsh-agent-presets` package with shipped presets. */
function fakeAgentPresetsPackage(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-agent-presets", version: "0.1.5-rc.2" }),
  );
  const presetsDir = join(dir, "presets");
  mkdirSync(presetsDir, { recursive: true });
  for (const id of ["standard", "cordis"]) {
    mkdirSync(join(presetsDir, id), { recursive: true });
    writeFileSync(
      join(presetsDir, id, "agent.cordis.yml"),
      yamlDump(stockLayout(), { schema: entryListSchema }),
    );
  }
  return presetsDir;
}

function fakeProfile(dshHome: string, name: string, bundles: string[]): void {
  const dir = join(dshHome, "profiles", name);
  mkdirSync(join(dir, "node_modules", MAGIC_CONTEXT_PACKAGE), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, dsh: { profile: { bundles } } }),
  );
}

interface TestEnv {
  root: string;
  dshHome: string;
  installDir: string;
  configHome: string;
  work: string;
}

function makeEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "dsh-magic-doctor-"));
  return {
    root,
    dshHome: join(root, "dsh-home"),
    installDir: join(root, "install"),
    configHome: join(root, "config"),
    work: join(root, "work"),
  };
}

async function cleanup(root: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function byId(report: Awaited<ReturnType<typeof runDshDoctor>>): Map<string, Awaited<ReturnType<typeof runDshDoctor>>["checks"][number]> {
  return new Map(report.checks.map((check) => [check.id, check]));
}

describe("dsh-magic-context doctor (ADR 0001 model)", () => {
  it("classifies a healthy shared DB open as ok", async () => {
    await withTestDb(async ({ dir }) => {
      const dbPath = join(dir, "ok", "context.db");
      const outcome = await classifyDatabaseOpen(dbPath);
      expect(outcome.kind).toBe("ok");
      if (outcome.kind === "ok") {
        expect(outcome.schemaVersion).toBe(LATEST_SUPPORTED_VERSION);
        expect(outcome.latestSupported).toBe(LATEST_SUPPORTED_VERSION);
        outcome.db?.close();
      }
    }, "dsh-magic-doctor-");
  });

  it("classifies a newer persisted schema as a schema-fence refusal", async () => {
    const env = makeEnv();
    try {
      const dbPath = join(env.root, "fence", "context.db");
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.exec("CREATE TABLE schema_migrations (version INTEGER NOT NULL)");
      db.exec("INSERT INTO schema_migrations (version) VALUES (9999)");
      db.close();
      const outcome = await classifyDatabaseOpen(dbPath);
      expect(outcome.kind).toBe("schema-fence");
    } finally {
      await cleanup(env.root);
    }
  });

  it("scans liveness markers: own pid is live, an impossible pid is stale", async () => {
    const env = makeEnv();
    try {
      const storage = join(env.root, "storage");
      const dir = join(storage, "rpc", "a1b2c3d4");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `port-${process.pid}.json`),
        JSON.stringify({ port: 1, pid: process.pid, started_at: Date.now() }),
      );
      writeFileSync(
        join(dir, "port-99999999.json"),
        JSON.stringify({ port: 2, pid: 99999999, started_at: Date.now() }),
      );
      const scan = scanLivenessMarkers(storage);
      expect(scan.liveCount).toBe(1);
      expect(scan.markers.find((marker) => marker.pid === process.pid)?.live).toBe(true);
      expect(scan.markers.find((marker) => marker.pid === 99999999)?.live).toBe(false);
    } finally {
      await cleanup(env.root);
    }
  });

  it("reads profile bundle facts from a fake profile", async () => {
    const env = makeEnv();
    try {
      fakeProfile(env.dshHome, "web", ["@deepseek-ai/dsh-base", MAGIC_CONTEXT_PACKAGE]);
      fakeProfile(env.dshHome, "headless", ["@deepseek-ai/dsh-base"]);
      expect(listProfiles(env.dshHome).sort()).toEqual(["headless", "web"]);
      const web = profileBundleFacts(env.dshHome, "web");
      expect(web.bundleInstalled).toBe(true);
      expect(web.nodeModulesPackageExists).toBe(true);
      const headless = profileBundleFacts(env.dshHome, "headless");
      expect(headless.bundleInstalled).toBe(false);
    } finally {
      await cleanup(env.root);
    }
  });

  it("reports ok across the full checklist on a patched environment", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      fakeInstall(env.installDir);
      fakeProfile(env.dshHome, "web", [MAGIC_CONTEXT_PACKAGE]);
      const agentPresetsDir = join(env.root, "agent-presets-pkg");
      const presetsDir = fakeAgentPresetsPackage(agentPresetsDir);
      // Boot self-heal already patched the shipped files (applied state).
      patchShippedPresets({ agentPresetsDir, warn: () => {} });
      expect(existsSync(presetsDir)).toBe(true);
      // Doctor only reports config (setup no longer writes): a pre-existing
      // valid config keeps the config-load check ok.
      mkdirSync(join(env.configHome, "cortexkit"), { recursive: true });
      writeFileSync(
        join(env.configHome, "cortexkit", "magic-context.jsonc"),
        '{\n  "enabled": true\n}\n',
        "utf8",
      );

      // Pre-create the shared DB so the shared-db check classifies ok. The
      // core caches handles by path: keep this handle open (do NOT close it)
      // or the doctor's reopen would see a closed cached handle.
      const dbPath = join(env.root, "storage", "context.db");
      const pre = await openDatabaseAsync({ dbPath });
      expect(pre).not.toBeNull();

      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        agentPresetsDir,
        directory: env.work,
        storageDirOverride: join(env.root, "storage"),
        dbPathOverride: dbPath,
      });
      expect(report.exitCode).toBe(0);
      const checks = byId(report);
      expect(checks.get("dsh-version")?.status).toBe("ok");
      expect(checks.get("bundle-install.web")?.status).toBe("ok");
      expect(checks.get("preset-patch.standard")?.status).toBe("ok");
      expect(checks.get("preset-patch.cordis")?.status).toBe("ok");
      expect(checks.get("legacy-preset")?.status).toBe("ok");
      expect(checks.get("shared-db")?.status).toBe("ok");
      expect(checks.get("liveness-markers")?.status).toBe("ok");
      expect(checks.get("config-load")?.status).toBe("ok");
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("fails the version check on an exact-rc mismatch", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      fakeInstall(env.installDir, "0.1.0-rc.5");
      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        directory: env.work,
      });
      const version = byId(report).get("dsh-version");
      expect(version?.status).toBe("fail");
      expect(version?.detail).toContain("0.1.0-rc.5");
      expect(report.exitCode).toBe(1);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("fails the bundle check when the package is missing from a profile", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      fakeInstall(env.installDir);
      fakeProfile(env.dshHome, "web", ["@deepseek-ai/dsh-base"]);
      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        directory: env.work,
        profile: "web",
      });
      const bundle = byId(report).get("bundle-install.web");
      expect(bundle?.status).toBe("fail");
      expect(bundle?.fix).toContain("dsh plugin");
      expect(report.exitCode).toBe(1);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("reports stock shipped presets as ok (heal applies at next host boot)", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      fakeInstall(env.installDir);
      fakeProfile(env.dshHome, "web", [MAGIC_CONTEXT_PACKAGE]);
      const agentPresetsDir = join(env.root, "agent-presets-pkg");
      fakeAgentPresetsPackage(agentPresetsDir);
      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        agentPresetsDir,
        directory: env.work,
        profile: "web",
      });
      const standard = byId(report).get("preset-patch.standard");
      expect(standard?.status).toBe("ok");
      expect(standard?.detail).toContain("stock engine");
      expect(byId(report).get("legacy-preset")?.status).toBe("ok");
      expect(report.exitCode).toBe(0);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("fails the preset-patch check on a rotted MC entry URL", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      fakeInstall(env.installDir);
      fakeProfile(env.dshHome, "web", [MAGIC_CONTEXT_PACKAGE]);
      const agentPresetsDir = join(env.root, "agent-presets-pkg");
      const presetsDir = fakeAgentPresetsPackage(agentPresetsDir);
      // The file was patched against an OLD MC install; the entry path moved.
      const file = join(presetsDir, "standard", "agent.cordis.yml");
      const text = readFileSync(file, "utf8");
      const rewrite = rewriteCompactionRowText(text, "file:///rotten/entries/compaction.js");
      writeFileSync(file, rewrite.patched, "utf8");
      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        agentPresetsDir,
        directory: env.work,
        profile: "web",
      });
      const standard = byId(report).get("preset-patch.standard");
      expect(standard?.status).toBe("fail");
      expect(standard?.detail).toContain("stale entry path");
      expect(report.exitCode).toBe(1);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("warns (not fails) on a contract-mismatched shipped preset", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      fakeInstall(env.installDir);
      fakeProfile(env.dshHome, "web", [MAGIC_CONTEXT_PACKAGE]);
      const agentPresetsDir = join(env.root, "agent-presets-pkg");
      const presetsDir = fakeAgentPresetsPackage(agentPresetsDir);
      // dsh renamed the compaction group id.
      const file = join(presetsDir, "standard", "agent.cordis.yml");
      const entries = yamlLoad(readFileSync(file, "utf8"), {
        schema: entryListSchema,
      }) as Record<string, unknown>[];
      const group = entries.find((row) => row.id === "compaction");
      (group as { id: string }).id = "compaction-v2";
      writeFileSync(file, yamlDump(entries, { schema: entryListSchema }));

      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        agentPresetsDir,
        directory: env.work,
        profile: "web",
      });
      const standard = byId(report).get("preset-patch.standard");
      expect(standard?.status).toBe("warn");
      expect(standard?.detail).toContain("Stock compaction keeps running");
      expect(report.exitCode).toBe(0);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("warns about a legacy magic-standard preset (absent → ok)", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      fakeInstall(env.installDir);
      fakeProfile(env.dshHome, "web", [MAGIC_CONTEXT_PACKAGE]);
      // Legacy thin preset that IS verifiably MC-generated.
      const legacyDir = magicStandardDir(env.dshHome);
      mkdirSync(legacyDir, { recursive: true });
      writeFileSync(
        join(legacyDir, "agent.cordis.yml"),
        [
          `- id: magic-include-standard`,
          `  name: 'file:///mc/dist/entries/preset-include.js'`,
          `  config:`,
          `    path: 'file:///stock/agent.cordis.yml'`,
          `    patches: []`,
          ``,
        ].join("\n"),
      );
      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        directory: env.work,
        profile: "web",
      });
      const legacy = byId(report).get("legacy-preset");
      expect(legacy?.status).toBe("warn");
      expect(legacy?.detail).toContain("verifiably");
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("fails the shared-db check on a schema-fence DB", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      fakeInstall(env.installDir);
      fakeProfile(env.dshHome, "web", [MAGIC_CONTEXT_PACKAGE]);
      const dbPath = join(env.root, "storage", "context.db");
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.exec("CREATE TABLE schema_migrations (version INTEGER NOT NULL)");
      db.exec("INSERT INTO schema_migrations (version) VALUES (9999)");
      db.close();
      const report = await runDshDoctor([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        directory: env.work,
        storageDirOverride: join(env.root, "storage"),
        dbPathOverride: dbPath,
        profile: "web",
      });
      const sharedDb = byId(report).get("shared-db");
      expect(sharedDb?.status).toBe("fail");
      expect(sharedDb?.detail).toContain("schema fence");
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });
});
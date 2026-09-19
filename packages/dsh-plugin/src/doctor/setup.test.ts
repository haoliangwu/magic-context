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
import { load as yamlLoad, dump as yamlDump } from "js-yaml";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { runDshSetup } from "./setup";

/** Parse an `agent.cordis.yml` entry list (loader YAML dialect, test helper). */
function parseEntryListYaml(text: string): Record<string, unknown>[] {
  return yamlLoad(text, { schema: entryListSchema }) as Record<string, unknown>[];
}
import {
  patchShippedPresets,
  rewriteCompactionRowText,
} from "../host/preset-patch";
import { MAGIC_CONTEXT_PACKAGE, magicStandardDir } from "./env";

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

/** Fake dsh install (version-tagged package.json, 0.1.5-era preset layout). */
function fakeInstall(installDir: string): void {
  mkdirSync(installDir, { recursive: true });
  writeFileSync(
    join(installDir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.5-rc.2" }),
  );
  const stock = join(installDir, "..", "dsh-agent-presets", "presets", "standard", "agent.cordis.yml");
  mkdirSync(dirname(stock), { recursive: true });
  writeFileSync(stock, yamlDump(stockLayout(), { schema: entryListSchema }));
}

function fakeProfile(dshHome: string, name: string): void {
  const dir = join(dshHome, "profiles", name);
  mkdirSync(join(dir, "node_modules", MAGIC_CONTEXT_PACKAGE), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, dsh: { profile: { bundles: [MAGIC_CONTEXT_PACKAGE] } } }),
  );
}

function fakeAgentPresetsPackage(dir: string): { presetsDir: string; standard: string; cordis: string } {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-agent-presets", version: "0.1.5-rc.2" }),
  );
  const presetsDir = join(dir, "presets");
  const standard = join(presetsDir, "standard", "agent.cordis.yml");
  const cordis = join(presetsDir, "cordis", "agent.cordis.yml");
  for (const id of ["standard", "cordis", "ptc", "minimal"]) {
    mkdirSync(join(presetsDir, id), { recursive: true });
    writeFileSync(
      join(presetsDir, id, "agent.cordis.yml"),
      yamlDump(stockLayout(), { schema: entryListSchema }),
    );
  }
  return { presetsDir, standard, cordis };
}

interface TestEnv {
  root: string;
  dshHome: string;
  installDir: string;
  configHome: string;
  work: string;
}

function makeEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "dsh-magic-setup-"));
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

describe("dsh-magic-context setup (ADR 0001: diagnostics only)", () => {
  it("reports a clean environment without writing anything", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      fakeInstall(env.installDir);
      fakeProfile(env.dshHome, "web");
      const agentPresetsDir = join(env.root, "agent-presets-pkg");
      const { standard } = fakeAgentPresetsPackage(agentPresetsDir);
      patchShippedPresets({ agentPresetsDir, warn: () => {} });
      const before = readFileSync(standard, "utf8");

      const report = await runDshSetup([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        agentPresetsDir,
        directory: env.work,
        profile: "web",
      });

      expect(report.exitCode).toBe(0);
      // Pure report: nothing written, nothing generated.
      expect(report.generatedFiles).toEqual([]);
      expect(existsSync(magicStandardDir(env.dshHome))).toBe(false);
      expect(existsSync(join(env.configHome, "cortexkit", "magic-context.jsonc"))).toBe(false);
      expect(readFileSync(standard, "utf8")).toBe(before);
      // Steps cover the shipped-preset patch states + legacy detection.
      const byTitle = new Map(report.steps.map((step) => [step.title, step]));
      const patchStep = report.steps.find((step) => step.title.includes("standard"));
      expect(patchStep?.status).toBe("ok");
      expect(patchStep?.detail).toContain("patched");
      expect(byTitle.get("Legacy magic-standard preset")?.status).toBe("ok");
      expect(report.steps.some((step) => step.title.startsWith("User-root presets"))).toBe(true);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("reports contract-mismatch / rotted states with matching statuses", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      fakeInstall(env.installDir);
      fakeProfile(env.dshHome, "web");
      const agentPresetsDir = join(env.root, "agent-presets-pkg");
      const { presetsDir } = fakeAgentPresetsPackage(agentPresetsDir);
      // standard: rotted URL (old MC entry path).
      const standardFile = join(presetsDir, "standard", "agent.cordis.yml");
      const rewrite = rewriteCompactionRowText(
        readFileSync(standardFile, "utf8"),
        "file:///old-entries/compaction.js",
      );
      writeFileSync(standardFile, rewrite.patched, "utf8");
      // cordis: contract mismatch — compaction group id renamed.
      const cordisFile = join(presetsDir, "cordis", "agent.cordis.yml");
      const entries = parseEntryListYaml(readFileSync(cordisFile, "utf8"));
      const group = entries.find((row) => row.id === "compaction");
      (group as { id: string }).id = "compaction-v2";
      writeFileSync(cordisFile, yamlDump(entries, { schema: entryListSchema }));

      const report = await runDshSetup([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        agentPresetsDir,
        directory: env.work,
        profile: "web",
      });

      const standard = report.steps.find((step) =>
        step.title.includes("— standard"),
      );
      expect(standard?.status).toBe("fail");
      expect(standard?.detail).toContain("stale entry path");
      const cordis = report.steps.find((step) => step.title.includes("— cordis"));
      expect(cordis?.status).toBe("warn");
      expect(cordis?.detail).toContain("Stock compaction keeps running");
      expect(report.exitCode).toBe(1);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("lists user-root presets referencing dsh-compaction-basic (informational only)", async () => {
    const env = makeEnv();
    process.env.XDG_CONFIG_HOME = env.configHome;
    try {
      fakeInstall(env.installDir);
      fakeProfile(env.dshHome, "web");
      const agentPresetsDir = join(env.root, "agent-presets-pkg");
      fakeAgentPresetsPackage(agentPresetsDir);
      // User-authored preset that mounts the stock engine.
      const mine = join(env.dshHome, ".agent-presets", "mine");
      mkdirSync(mine, { recursive: true });
      writeFileSync(join(mine, "agent.cordis.yml"), yamlDump(stockLayout(), { schema: entryListSchema }));

      const report = await runDshSetup([], {
        dshHome: env.dshHome,
        dshInstallDir: env.installDir,
        agentPresetsDir,
        directory: env.work,
        profile: "web",
      });
      const notice = report.steps.find((step) => step.title.startsWith("User-root presets"));
      expect(notice?.status).toBe("ok");
      expect(notice?.detail).toContain("mine");
      // Informational only — the user-root preset was never touched.
      expect(existsSync(join(mine, "agent.cordis.yml"))).toBe(true);
    } finally {
      delete process.env.XDG_CONFIG_HOME;
      await cleanup(env.root);
    }
  });

  it("reports a diagnosis when the DSH install cannot be found", async () => {
    const env = makeEnv();
    try {
      const report = await runDshSetup([], {
        dshHome: env.dshHome,
        dshInstallDir: join(env.root, "missing-install"),
        env: { ...process.env, PATH: "/nonexistent-path" },
      });
      expect(report.exitCode).toBe(1);
      const installStep = report.steps.find((step) => step.title.includes("DSH version"));
      expect(installStep?.status).toBe("fail");
      expect(report.generatedFiles).toEqual([]);
    } finally {
      await cleanup(env.root);
    }
  });

  it("keeps the loader-dialect YAML helpers working (setup-yaml round-trip)", () => {
    const dumped = yamlDump(stockLayout(), { schema: entryListSchema });
    expect(parseEntryListYaml(dumped)).toEqual(stockLayout());
  });
});
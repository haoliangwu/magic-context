/**
 * host/preset-audit — READ-ONLY shipped-preset audit tests.
 *
 * Fixtures build isolated fake installs of both layouts:
 *  - 0.1: an `@deepseek-ai/dsh-agent-presets` package with
 *    `presets/<id>/agent.cordis.yml` files;
 *  - 0.2: an `@deepseek-ai/dsh-web-app` package with `presets/<id>.patch.yml`
 *    declarations (one `@deepseek-ai/dsh-agent-preset` row whose
 *    `config.plugins` holds the nested compaction group).
 *
 * The audit NEVER writes: every test asserts the audited files are
 * byte-identical after the call.
 */
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
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import {
  auditShippedPresets,
  currentCompactionEntryUrl,
  summarizePresetAudit,
} from "./preset-audit";

const CURRENT_URL = "file:///opt/mc/dist/entries/compaction.js";

/** 0.1-layout stock entry list (compaction group included). */
const STOCK_V1_YML = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    suffix: Your working directory is {{cwd}}.
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'
    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
`;

/** A trimmed but shape-accurate 0.2 preset declaration file. */
const STANDARD_PATCH_YML = `- insert:
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: tool-result-pruner
                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
                config:
                  thresholdChars: 8192
`;

/** minimal has no compaction group — never a target. */
const MINIMAL_PATCH_YML = `- insert:
    - id: preset-minimal
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: minimal
        order: 3
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
`;

interface Fixture {
  readonly root: string;
  readonly v1Dir: string;
  readonly v1PresetsDir: string;
  readonly webAppDir: string;
  readonly webAppPresetsDir: string;
  cleanup: () => void;
}

/** Both layouts under one temp root, with package.json identity files. */
function makeFixture(
  v1Files: Record<string, string>,
  v2Files: Record<string, string>,
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "mc-preset-audit-"));
  const v1Dir = join(root, "dsh-agent-presets");
  const v1PresetsDir = join(v1Dir, "presets");
  mkdirSync(v1PresetsDir, { recursive: true });
  writeFileSync(
    join(v1Dir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-agent-presets", version: "0.1.5-rc.2" }),
  );
  for (const [name, content] of Object.entries(v1Files)) {
    mkdirSync(join(v1PresetsDir, name), { recursive: true });
    writeFileSync(join(v1PresetsDir, name, "agent.cordis.yml"), content);
  }
  const webAppDir = join(root, "dsh-web-app");
  const webAppPresetsDir = join(webAppDir, "presets");
  mkdirSync(webAppPresetsDir, { recursive: true });
  writeFileSync(
    join(webAppDir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-web-app", version: "0.2.0-rc.2" }),
  );
  for (const [name, content] of Object.entries(v2Files)) {
    writeFileSync(join(webAppPresetsDir, name), content);
  }
  return {
    root,
    v1Dir,
    v1PresetsDir,
    webAppDir,
    webAppPresetsDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Retarget a 0.2 declaration's compaction-basic row (old-patcher output). */
function tamperV2(path: string, url: string, config = "{ auto: true }"): void {
  const text = readFileSync(path, "utf8");
  const patched = text.replace(
    "name: '@deepseek-ai/dsh-compaction-basic'",
    `name: '${url}'\n                config: ${config}`,
  );
  expect(patched).not.toBe(text);
  writeFileSync(path, patched);
}

describe("preset-audit (read-only, both layouts)", () => {
  it("classifies stock 0.1 and 0.2 files without touching them", () => {
    const fixture = makeFixture(
      { standard: STOCK_V1_YML },
      { "standard.patch.yml": STANDARD_PATCH_YML, "minimal.patch.yml": MINIMAL_PATCH_YML },
    );
    try {
      const beforeV1 = readFileSync(join(fixture.v1PresetsDir, "standard", "agent.cordis.yml"), "utf8");
      const beforeV2 = readFileSync(join(fixture.webAppPresetsDir, "standard.patch.yml"), "utf8");
      const audit = auditShippedPresets({
        agentPresetsDir: fixture.v1Dir,
        webAppDir: fixture.webAppDir,
        compactionEntryUrl: CURRENT_URL,
        warn: () => {},
      });
      // minimal is not a compaction target in either layout.
      expect(audit.files.map((f) => `${f.presetId}:${f.state}`).sort()).toEqual([
        "standard:stock",
        "standard:stock",
      ]);
      // Read-only: byte-identical after the audit.
      expect(readFileSync(join(fixture.v1PresetsDir, "standard", "agent.cordis.yml"), "utf8")).toBe(beforeV1);
      expect(readFileSync(join(fixture.webAppPresetsDir, "standard.patch.yml"), "utf8")).toBe(beforeV2);
    } finally {
      fixture.cleanup();
    }
  });

  it("detects a leftover current-URL patch and a rotted one in the 0.2 layout", () => {
    const fixture = makeFixture(
      {},
      { "standard.patch.yml": STANDARD_PATCH_YML, "ptc.patch.yml": STANDARD_PATCH_YML },
    );
    try {
      tamperV2(join(fixture.webAppPresetsDir, "standard.patch.yml"), CURRENT_URL);
      tamperV2(join(fixture.webAppPresetsDir, "ptc.patch.yml"), "file:///old/dist/entries/compaction.js");
      const audit = auditShippedPresets({
        webAppDir: fixture.webAppDir,
        compactionEntryUrl: CURRENT_URL,
        warn: () => {},
      });
      const byId = new Map(audit.files.map((f) => [f.presetId, f]));
      expect(byId.get("standard")?.state).toBe("mc-patched");
      expect(byId.get("ptc")?.state).toBe("mc-patched-rotted");
      expect(byId.get("ptc")?.issue).toContain("file:///old/dist/entries/compaction.js");
      expect(summarizePresetAudit(audit)).toEqual({ tampered: 2, total: 2 });
    } finally {
      fixture.cleanup();
    }
  });

  it("detects a leftover patch in the 0.1 layout and flags a foreign shape", () => {
    const foreign = STOCK_V1_YML.replace(
      "name: '@deepseek-ai/dsh-compaction-basic'",
      "name: '@example/other-compaction'",
    );
    const fixture = makeFixture(
      { standard: STOCK_V1_YML, cordis: foreign },
      {},
    );
    try {
      // Tamper the 0.1 file the way the old patcher did.
      const tampered = STOCK_V1_YML.replace(
        "name: '@deepseek-ai/dsh-compaction-basic'",
        `name: '${CURRENT_URL}'\n      config: { auto: true }`,
      );
      writeFileSync(join(fixture.v1PresetsDir, "standard", "agent.cordis.yml"), tampered);
      const audit = auditShippedPresets({
        agentPresetsDir: fixture.v1Dir,
        compactionEntryUrl: CURRENT_URL,
        warn: () => {},
      });
      const byId = new Map(audit.files.map((f) => [f.presetId, f]));
      expect(byId.get("standard")?.state).toBe("mc-patched");
      expect(byId.get("cordis")?.state).toBe("foreign");
      expect(audit.warnings.some((w) => w.includes("cordis"))).toBe(true);
      expect(summarizePresetAudit(audit)).toEqual({ tampered: 1, total: 2 });
    } finally {
      fixture.cleanup();
    }
  });

  it("summarizes per preset id without double-counting across layouts", () => {
    const fixture = makeFixture(
      { standard: STOCK_V1_YML },
      { "standard.patch.yml": STANDARD_PATCH_YML },
    );
    try {
      const tampered = STOCK_V1_YML.replace(
        "name: '@deepseek-ai/dsh-compaction-basic'",
        `name: '${CURRENT_URL}'\n      config: { auto: true }`,
      );
      writeFileSync(join(fixture.v1PresetsDir, "standard", "agent.cordis.yml"), tampered);
      const audit = auditShippedPresets({
        agentPresetsDir: fixture.v1Dir,
        webAppDir: fixture.webAppDir,
        compactionEntryUrl: CURRENT_URL,
        warn: () => {},
      });
      expect(audit.files.length).toBe(2);
      expect(summarizePresetAudit(audit, "magic-standard")).toEqual({
        tampered: 1,
        total: 1,
        legacy: "magic-standard",
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("never audits machine stores when both dirs are isolated pins", () => {
    const fixture = makeFixture({ standard: STOCK_V1_YML }, { "standard.patch.yml": STANDARD_PATCH_YML });
    try {
      // Explicit pins on both layouts: no anchor tier may run, so a poisoned
      // env var (which would otherwise reach the real install) is ignored.
      process.env.DSH_WEB_APP_DIR = "/definitely/not/a/real/dir";
      const audit = auditShippedPresets({
        agentPresetsDir: fixture.v1Dir,
        webAppDir: fixture.webAppDir,
        compactionEntryUrl: CURRENT_URL,
        warn: () => {},
      });
      expect(audit.agentPresetsDir).toBe(fixture.v1Dir);
      expect(audit.webAppDir).toBe(fixture.webAppDir);
      expect(audit.files.length).toBe(2);
    } finally {
      delete process.env.DSH_WEB_APP_DIR;
      fixture.cleanup();
    }
  });

  it("currentCompactionEntryUrl points at this package's compaction entry", () => {
    const url = currentCompactionEntryUrl();
    expect(url.startsWith("file://")).toBe(true);
    expect(url.endsWith("dist/entries/compaction.js")).toBe(true);
    expect(existsSync(new URL(url))).toBe(true);
  });
});

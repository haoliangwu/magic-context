/**
 * host/preset-patch — in-place shipped-preset patch contract tests (ADR 0001).
 *
 * Fixtures mirror the real shipped `standard`/`cordis`/`ptc` preset YAML
 * (trimmed from packages/preset/agent-presets/presets/* in the dsh harness
 * source): block-form rows, comments, the isolated compaction group, and
 * sibling rows that must survive byte-for-byte.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { load as yamlLoad } from "js-yaml";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import {
  patchShippedPresets,
  scanPresetPatchStates,
  detectLegacyMagicStandard,
  removeLegacyMagicStandard,
  listUserRootPresetsReferencingCompactionBasic,
  rewriteCompactionRowText,
  summarizePresetPatchStates,
  type PresetPatchFile,
  type PresetPatchResult,
} from "./preset-patch";

/** Stock compaction section, shipped-file style (comments + siblings preserved). */
const COMPACTION_SECTION = `# ── compaction ──────────────────────────────────────────────────────────────

# \`compaction-basic\` reads \`toolResultPrune\` through \`ctx.get\`, so the pruner must
# share this realm rather than sit outside it.
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'

    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'

    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
        headChars: 4096
        tailChars: 1024
`;

/** Full stock `standard`-style composition around the compaction section. */
const SIGNED_SECTION = `# ── delegation and workflows ────────────────────────────────────────────────
- id: delegation
  name: cordis:group
  group: true
  isolate:
    workflowEngine: true
  config:
    - id: tool-subagent
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: spawn
        toolName: subagent
`;

/** A shipped preset with the compaction-basic row (standard/cordis/ptc style). */
function stockPresetYaml(extra = SIGNED_SECTION): string {
  return [
    `# The standard agent preset.`,
    ``,
    `- id: persona`,
    `  name: '@deepseek-ai/dsh-persona'`,
    `  config:`,
    `    suffix: Your working directory is {{cwd}}.`,
    ``,
    COMPACTION_SECTION,
    ``,
    extra,
    ``,
    `- id: tool-ask-user`,
    `  name: '@deepseek-ai/dsh-tool-ask-user'`,
    ``,
  ].join("\n");
}

/** Preset WITH the compaction-basic row (today: standard, cordis, ptc). */
function writeTargetPreset(presetsDir: string, id: string, yaml = stockPresetYaml()): string {
  const dir = join(presetsDir, id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "agent.cordis.yml");
  writeFileSync(file, yaml, "utf8");
  return file;
}

/** Preset WITHOUT the compaction group at all (minimal-style → not a target). */
function writeMinimalPreset(presetsDir: string): string {
  const dir = join(presetsDir, "minimal");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "agent.cordis.yml");
  writeFileSync(
    file,
    [
      `- id: persona`,
      `  name: '@deepseek-ai/dsh-persona'`,
      ``,
      `- id: tool-ask-user`,
      `  name: '@deepseek-ai/dsh-tool-ask-user'`,
      ``,
    ].join("\n"),
    "utf8",
  );
  return file;
}

/** Fake `@deepseek-ai/dsh-agent-presets` package root with shipped presets. */
function fakeAgentPresetsPackage(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-agent-presets", version: "0.1.5-rc.2" }),
  );
  mkdirSync(join(dir, "presets"), { recursive: true });
}

interface TestEnv {
  root: string;
  agentPresetsDir: string;
  presetsDir: string;
  urlA: string;
  urlB: string;
}

const tempDirs: string[] = [];

function makeEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "preset-patch-"));
  tempDirs.push(root);
  const agentPresetsDir = join(root, "store", "node_modules", "@deepseek-ai", "dsh-agent-presets");
  fakeAgentPresetsPackage(agentPresetsDir);
  return {
    root,
    agentPresetsDir,
    presetsDir: join(agentPresetsDir, "presets"),
    urlA: pathToFileURL(join(root, "mc", "dist", "entries", "compaction.js")).href,
    urlB: pathToFileURL(join(root, "mc-v2", "dist", "entries", "compaction.js")).href,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function parseRows(text: string): Record<string, unknown>[] {
  return yamlLoad(text, { schema: entryListSchema }) as Record<string, unknown>[];
}

function compactionRow(entries: Record<string, unknown>[]): Record<string, unknown> {
  const group = entries.find((row) => row.id === "compaction") as
    | { config?: unknown }
    | undefined;
  return (group?.config as Record<string, unknown>[]).find(
    (row) => row.id === "compaction-basic",
  )!;
}

describe("shipped-preset patch (ADR 0001)", () => {
  it("fresh stock presets get name+config via atomic rename; minimal is untouched", () => {
    const env = makeEnv();
    const standard = writeTargetPreset(env.presetsDir, "standard");
    const cordis = writeTargetPreset(env.presetsDir, "cordis", stockPresetYaml(`# cordis-only\n- id: tool-cordis\n  name: '@deepseek-ai/dsh-tool-cordis'\n`));
    const minimal = writeMinimalPreset(env.presetsDir);

    const result = patchShippedPresets({
      agentPresetsDir: env.agentPresetsDir,
      compactionEntryUrl: env.urlA,
    });

    expect(result.patched.sort()).toEqual([cordis, standard]);
    expect(result.skipped).toEqual([]);
    expect(result.warnings).toEqual([]);
    // minimal is not a target: never listed, never touched.
    expect(result.files.map((file) => file.presetId)).not.toContain("minimal");
    expect(readFileSync(minimal, "utf8")).not.toContain("compaction-basic");

    for (const file of [standard, cordis]) {
      const row = compactionRow(parseRows(readFileSync(file, "utf8")));
      expect(row.name).toBe(env.urlA);
      expect((row.config as { auto?: boolean }).auto).toBe(true);
      // Row id preserved, stock siblings + isolate intact.
      expect(row.id).toBe("compaction-basic");
      const text = readFileSync(file, "utf8");
      expect(text).toContain(`name: '${env.urlA}'`);
      expect(text).toContain(`config: { auto: true }`);
      expect(text).toContain("tool-result-pruner");
      expect(text).toContain("toolResultPruner: true");
      // Atomic rename left no temp litter behind.
      const leftovers = readdirSync(dirname(standard))
        .filter((entry) => entry.endsWith(".tmp"));
      expect(leftovers).toEqual([]);
    }
  });

  it("is idempotent: already-current files are no-ops and nothing is rewritten", () => {
    const env = makeEnv();
    writeTargetPreset(env.presetsDir, "standard");
    patchShippedPresets({
      agentPresetsDir: env.agentPresetsDir,
      compactionEntryUrl: env.urlA,
    });
    const text = readFileSync(join(env.presetsDir, "standard", "agent.cordis.yml"), "utf8");

    const second = patchShippedPresets({
      agentPresetsDir: env.agentPresetsDir,
      compactionEntryUrl: env.urlA,
    });
    expect(second.patched).toEqual([]);
    expect(second.noOps).toHaveLength(1);
    expect(second.files[0]!.state).toBe("applied");
    // Byte-identical: no rewrite happened.
    expect(readFileSync(join(env.presetsDir, "standard", "agent.cordis.yml"), "utf8")).toBe(text);

    const scan = scanPresetPatchStates({
      agentPresetsDir: env.agentPresetsDir,
      compactionEntryUrl: env.urlA,
    });
    expect(scan.files[0]!.state).toBe("applied");
  });

  it("re-applies when pnpm rotation delivered fresh stock files", () => {
    const env = makeEnv();
    const standard = writeTargetPreset(env.presetsDir, "standard");
    patchShippedPresets({
      agentPresetsDir: env.agentPresetsDir,
      compactionEntryUrl: env.urlA,
    });
    // Simulate rotation: stock name restored, config dropped, comment added.
    writeFileSync(
      standard,
      stockPresetYaml().replace(
        "      name: '@deepseek-ai/dsh-compaction-basic'",
        "      name: '@deepseek-ai/dsh-compaction-basic'\n      # rotated fresh",
      ),
      "utf8",
    );

    const result = patchShippedPresets({
      agentPresetsDir: env.agentPresetsDir,
      compactionEntryUrl: env.urlA,
    });
    expect(result.patched).toEqual([standard]);
    const row = compactionRow(parseRows(readFileSync(standard, "utf8")));
    expect(row.name).toBe(env.urlA);
    expect((row.config as { auto?: boolean }).auto).toBe(true);
  });

  it("rewrites a rotted MC entry URL to the current entry", () => {
    const env = makeEnv();
    const standard = writeTargetPreset(env.presetsDir, "standard");
    // First patch with the OLD url, then the MC entry path moves (upgrade).
    patchShippedPresets({
      agentPresetsDir: env.agentPresetsDir,
      compactionEntryUrl: env.urlA,
    });
    const rotted = patchShippedPresets({
      agentPresetsDir: env.agentPresetsDir,
      compactionEntryUrl: env.urlB,
    });
    expect(rotted.patched).toEqual([standard]);
    const row = compactionRow(parseRows(readFileSync(standard, "utf8")));
    expect(row.name).toBe(env.urlB);
    expect((row.config as { auto?: boolean }).auto).toBe(true);
    // Family lines intact.
    const text = readFileSync(standard, "utf8");
    expect(text).not.toContain(env.urlA);
    expect(text).toContain("command-compact");
  });

  it("contract mismatch (row absent / group renamed) warns and never writes", () => {
    const env = makeEnv();
    // Group renamed but still carrying the row.
    const renamed = writeTargetPreset(
      env.presetsDir,
      "standard",
      stockPresetYaml().replace("- id: compaction\n", "- id: compaction-v2\n"),
    );
    // Compaction-shaped group whose row was removed/renamed by dsh.
    const missing = writeTargetPreset(
      env.presetsDir,
      "cordis",
      stockPresetYaml().replace(
        "    - id: compaction-basic\n      name: '@deepseek-ai/dsh-compaction-basic'\n\n",
        "",
      ),
    );
    const beforeRenamed = readFileSync(renamed, "utf8");
    const beforeMissing = readFileSync(missing, "utf8");

    const result = patchShippedPresets({
      agentPresetsDir: env.agentPresetsDir,
      compactionEntryUrl: env.urlA,
      warn: () => {},
    });

    expect(result.patched).toEqual([]);
    expect(result.skipped.sort()).toEqual([missing, renamed].sort());
    expect(result.warnings).toHaveLength(2);
    for (const warning of result.warnings) {
      expect(warning).toContain("preset patch skipped");
    }
    expect(result.warnings.some((warning) => warning.includes(renamed))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes(missing))).toBe(true);
    // No write happened: byte-identical.
    expect(readFileSync(renamed, "utf8")).toBe(beforeRenamed);
    expect(readFileSync(missing, "utf8")).toBe(beforeMissing);
    // Doctor-facing scan reports the same states.
    const scan = scanPresetPatchStates({
      agentPresetsDir: env.agentPresetsDir,
      compactionEntryUrl: env.urlA,
      warn: () => {},
    });
    expect(scan.files.every((file) => file.state === "contract-mismatch")).toBe(true);
  });

  it("refuses to operate outside the resolved agent-presets package dir", () => {
    const env = makeEnv();
    // A directory that is NOT the agent-presets package root: presets would
    // be user-root-like or foreign — the patcher must reject before writing.
    const foreign = join(env.root, "some-other-dir");
    mkdirSync(join(foreign, "presets", "standard"), { recursive: true });
    const file = join(foreign, "presets", "standard", "agent.cordis.yml");
    writeFileSync(file, stockPresetYaml(), "utf8");

    const result = patchShippedPresets({
      agentPresetsDir: foreign,
      compactionEntryUrl: env.urlA,
      warn: () => {},
    });

    expect(result.patched).toEqual([]);
    expect(result.files).toEqual([]);
    expect(existsSync(foreign)).toBe(true);
    // Not the agent-presets package: one warning, zero writes, file untouched.
    expect(readFileSync(file, "utf8")).toContain("@deepseek-ai/dsh-compaction-basic");
    expect(result.warnings[0]).toContain("refusing to patch");

    // Also: a missing resolved dir is a warning, not a throw.
    const missing = patchShippedPresets({
      agentPresetsDir: join(env.root, "does-not-exist"),
      compactionEntryUrl: env.urlA,
      warn: () => {},
    });
    expect(missing.patched).toEqual([]);
    expect(missing.warnings[0]).toContain("refusing to patch");
  });

  it("preserves every non-target line byte-for-byte except the swapped ones", () => {
    const env = makeEnv();
    const standard = writeTargetPreset(env.presetsDir, "standard");
    const original = readFileSync(standard, "utf8");

    const rewrite = rewriteCompactionRowText(original, env.urlA);
    expect(rewrite.changed).toBe(true);
    expect(rewrite.issue).toBeUndefined();

    const originalLines = original.split("\n");
    const patchedLines = rewrite.patched.split("\n");
    // Same line count (name line reused, config inserted = +1).
    expect(patchedLines.length).toBe(originalLines.length + 1);
    // Every line except the swapped name line, the inserted config line, and
    // the trailing empty entry survives byte-for-byte IN ORDER.
    const keep = (line: string): boolean =>
      !line.includes("dsh-compaction-basic") &&
      !line.includes("compaction.js") &&
      !line.includes("config: { auto: true }");
    expect(patchedLines.filter(keep)).toEqual(originalLines.filter(keep));
    // The swapped lines: day name line carries the new URL, config inserted.
    const patchedName = patchedLines.find((line) => line.includes("compaction.js"));
    expect(patchedName).toContain(env.urlA);
    expect(patchedLines.includes("      config: { auto: true }")).toBe(true);
    // Comments + siblings intact.
    expect(rewrite.patched).toContain("toolResultPruner: true");
    expect(rewrite.patched).toContain("# ── compaction ─");
    // The YAML round-trip still parses to the expected shape.
    const row = compactionRow(parseRows(rewrite.patched));
    expect(row.name).toBe(env.urlA);
  });

  it("rejects an unrecognizable row shape fail-open (no write, one warning)", () => {
    const env = makeEnv();
    // Row rendered with a block-scalar config — a shape we do not own.
    const file = writeTargetPreset(
      env.presetsDir,
      "standard",
      stockPresetYaml().replace(
        "      name: '@deepseek-ai/dsh-compaction-basic'\n",
        "      name: '@deepseek-ai/dsh-compaction-basic'\n      config:\n        auto: true\n",
      ),
    );
    const result = patchShippedPresets({
      agentPresetsDir: env.agentPresetsDir,
      compactionEntryUrl: env.urlA,
      warn: () => {},
    });
    expect(result.patched).toEqual([]);
    expect(result.warnings[0]).toContain("block scalar");
    expect(readFileSync(file, "utf8")).toContain("auto: true");
    // State check is included in result.files with the fail-open state.
    expect(result.files[0]!.state).toBe("contract-mismatch");
  });
});

describe("legacy magic-standard detection/cleanup", () => {
  it("removes a shape-verified MC-generated legacy preset", () => {
    const env = makeEnv();
    const dshHome = join(env.root, "dsh-home");
    const legacyDir = join(dshHome, ".agent-presets", "magic-standard");
    mkdirSync(legacyDir, { recursive: true });
    // Old thin-preset shape: include row names this package's preset-include
    // entry via dist/entries.
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
      "utf8",
    );

    expect(detectLegacyMagicStandard(dshHome).state).toBe("present");
    const outcome = removeLegacyMagicStandard(dshHome);
    expect(outcome.removed).toBe(true);
    expect(existsSync(legacyDir)).toBe(false);
  });

  it("leaves a non-MC directory alone with a reason", () => {
    const env = makeEnv();
    const dshHome = join(env.root, "dsh-home");
    const legacyDir = join(dshHome, ".agent-presets", "magic-standard");
    mkdirSync(legacyDir, { recursive: true });
    // A user's own preset that happens to use the magic-standard id.
    writeFileSync(
      join(legacyDir, "agent.cordis.yml"),
      `- id: persona\n  name: '@deepseek-ai/dsh-persona'\n`,
      "utf8",
    );

    const detected = detectLegacyMagicStandard(dshHome);
    expect(detected.state).toBe("present-not-mc");
    expect(detected.reason).toContain("no Magic Context rows");
    const outcome = removeLegacyMagicStandard(dshHome);
    expect(outcome.removed).toBe(false);
    expect(existsSync(legacyDir)).toBe(true);
  });

  it("lists user-root presets referencing the stock compaction engine", () => {
    const env = makeEnv();
    const dshHome = join(env.root, "dsh-home");
    const userRoot = join(dshHome, ".agent-presets");
    mkdirSync(join(userRoot, "mine"), { recursive: true });
    writeFileSync(
      join(userRoot, "mine", "agent.cordis.yml"),
      `- id: compaction\n  name: cordis:group\n  group: true\n  isolate:\n    compaction: true\n  config:\n    - id: compaction-basic\n      name: '@deepseek-ai/dsh-compaction-basic'\n`,
      "utf8",
    );
    mkdirSync(join(userRoot, "other"), { recursive: true });
    writeFileSync(join(userRoot, "other", "agent.cordis.yml"), `- id: persona\n  name: x\n`, "utf8");
    // magic-standard excluded even if present.
    mkdirSync(join(userRoot, "magic-standard"), { recursive: true });
    writeFileSync(
      join(userRoot, "magic-standard", "agent.cordis.yml"),
      `- id: magic-include-standard\n  name: x\n`,
      "utf8",
    );

    expect(listUserRootPresetsReferencingCompactionBasic(dshHome)).toEqual(["mine"]);
  });
});

describe("ADR 0001 anchor chain (roster / baseUrl / self)", () => {
  it("patches the live roster's system-root copy (trailing-slash SHIPPED_PRESET_ROOT shape)", () => {
    const env = makeEnv();
    const standard = writeTargetPreset(env.presetsDir, "standard");
    // The real roster's resolvedRoots: [shipped, configured…, user]; the shipped
    // entry is SHIPPED_PRESET_ROOT (`<package>/presets/`, trailing slash), the
    // user entry must be ignored entirely.
    const roster = {
      resolvedRoots: [
        { path: `${env.presetsDir}/`, trust: "system" },
        { path: join(env.root, "user-presets"), trust: "user" },
      ],
    };

    const result = patchShippedPresets({ roster, compactionEntryUrl: env.urlA });

    expect(result.patched).toHaveLength(1);
    // macOS tmpdir realpath (/var → /private/var): the chain verifies by realpath.
    expect(result.patched[0]).toBe(realpathSync(standard));
    const row = compactionRow(parseRows(readFileSync(standard, "utf8")));
    expect(row.name).toBe(env.urlA);
    expect((row.config as { auto?: boolean }).auto).toBe(true);
  });

  it("resolves from the composition base URL in flat layouts when no roster is given", () => {
    const env = makeEnv();
    const profile = join(env.root, "profile");
    // Flat layout: the profile's own node_modules holds the agent-presets copy.
    const flatPkg = join(profile, "node_modules", "@deepseek-ai", "dsh-agent-presets");
    fakeAgentPresetsPackage(flatPkg);
    const standard = writeTargetPreset(join(flatPkg, "presets"), "standard");

    const result = patchShippedPresets({
      baseUrl: pathToFileURL(profile + "/").href,
      compactionEntryUrl: env.urlA,
    });

    expect(result.patched).toHaveLength(1);
    expect(result.patched[0]).toBe(realpathSync(standard));
    const row = compactionRow(parseRows(readFileSync(standard, "utf8")));
    expect(row.name).toBe(env.urlA);

    const scan = scanPresetPatchStates({
      baseUrl: pathToFileURL(profile + "/").href,
      compactionEntryUrl: env.urlA,
    });
    expect(scan.files[0]!.state).toBe("applied");
  });

  it("a non-package roster root falls through to the base URL anchor", () => {
    const env = makeEnv();
    const profile = join(env.root, "profile");
    const flatPkg = join(profile, "node_modules", "@deepseek-ai", "dsh-agent-presets");
    fakeAgentPresetsPackage(flatPkg);
    const standard = writeTargetPreset(join(flatPkg, "presets"), "standard");
    // Roster reports a system root whose parent is NOT an agent-presets
    // package (harness restructured / configured foreign root): verification
    // fails and the chain must fall through, not skip.
    const roster = {
      resolvedRoots: [{ path: `${join(env.root, "foreign-presets")}/`, trust: "system" }],
    };

    const result = patchShippedPresets({
      roster,
      baseUrl: pathToFileURL(profile + "/").href,
      compactionEntryUrl: env.urlA,
    });

    expect(result.patched).toHaveLength(1);
    expect(result.patched[0]).toBe(realpathSync(standard));
    expect(result.agentPresetsDir).toBe(realpathSync(flatPkg));
  });

  it("a junk roster shape is ignored fail-open (falls through to base URL)", () => {
    const env = makeEnv();
    const profile = join(env.root, "profile");
    const flatPkg = join(profile, "node_modules", "@deepseek-ai", "dsh-agent-presets");
    fakeAgentPresetsPackage(flatPkg);
    const standard = writeTargetPreset(join(flatPkg, "presets"), "standard");
    // Harness renamed `resolvedRoots` — the guarded runtime read yields junk.
    const roster = { resolvedRoots: "garbage" };

    const result = patchShippedPresets({
      roster,
      baseUrl: pathToFileURL(profile + "/").href,
      compactionEntryUrl: env.urlA,
    });

    expect(result.patched).toHaveLength(1);
    expect(result.patched[0]).toBe(realpathSync(standard));
  });
});
describe("summarizePresetPatchStates (status panel aggregation)", () => {
  function file(path: string): PresetPatchFile {
    const presetId = path.split("/").at(-2)!;
    return { path, presetId, state: path.includes("applied") ? "applied" : "stock" };
  }
  function states(files: PresetPatchFile[]): PresetPatchResult {
    return { files, patched: [], skipped: [], noOps: [], warnings: [], agentPresetsDir: "/pkg" };
  }

  it("reports patched/total when every scanned preset is applied", () => {
    const result = summarizePresetPatchStates(
      states([
        file("/pkg/presets/standard/applied"),
        file("/pkg/presets/cordis/applied"),
      ]),
    );
    expect(result).toEqual({ patched: 2, total: 2 });
  });

  it("reports the unpatched remainder when some presets are stock", () => {
    const result = summarizePresetPatchStates(
      states([
        file("/pkg/presets/standard/applied"),
        file("/pkg/presets/cordis/stock"),
        file("/pkg/presets/ptc/stock"),
      ]),
    );
    expect(result).toEqual({ patched: 1, total: 3 });
  });

  it("dedupes by preset id across multiple scanned dirs; applied-in-any wins", () => {
    // Dir A (roster-anchored): standard applied + cordis stock.
    // Dir B (same id, fresh rotation): standard came back stock — must NOT
    // un-count the applied dir-A copy; ptc only exists in dir B.
    const result = summarizePresetPatchStates(
      states([
        file("/pkgA/presets/standard/applied"),
        file("/pkgA/presets/cordis/stock"),
        file("/pkgB/presets/standard/stock"),
        file("/pkgB/presets/ptc/stock"),
      ]),
    );
    expect(result).toEqual({ patched: 1, total: 3 });
    // Duplicate ids never inflate the total.
  });

  it("passes a legacy thin-preset name through when present", () => {
    const result = summarizePresetPatchStates(states([]), "magic-standard");
    expect(result).toEqual({ patched: 0, total: 0, legacy: "magic-standard" });
  });

  it("empty scan reports 0/0 without a legacy field", () => {
    const result = summarizePresetPatchStates(states([]));
    expect(result).toEqual({ patched: 0, total: 0 });
    expect(result.legacy).toBeUndefined();
  });

  it("dedupe counts a contract-mismatch file as unpatched, not double-counted", () => {
    const result = summarizePresetPatchStates({
      files: [
        file("/pkg/presets/standard/applied"),
        { path: "/pkg/presets/standard/agent.cordis.yml", presetId: "standard", state: "contract-mismatch", issue: "group id changed" },
      ],
      patched: [],
      skipped: [],
      noOps: [],
      warnings: [],
      agentPresetsDir: "/pkg",
    });
    expect(result).toEqual({ patched: 1, total: 1 });
  });
});

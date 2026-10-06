/**
 * host/preset-audit — READ-ONLY audit of the shipped agent-preset files.
 *
 * History: dsh-magic-context versions ≤ 0.45.0 (ADR 0001) patched the shipped
 * preset files IN PLACE so their `compaction-basic` row mounted the Magic
 * compaction engine. That approach modified files shared by EVERY profile on
 * the machine (standard / ptc / cordis / minimal — and any preset DSH ships
 * later), so it was REMOVED. The plugin never writes shipped presets anymore;
 * this module only DETECTS leftovers so doctor can tell the user how to
 * restore the stock rows.
 *
 * Audited layouts:
 *   - DSH 0.1.x: the `@deepseek-ai/dsh-agent-presets` package
 *     (`presets/<id>/agent.cordis.yml`);
 *   - DSH 0.2: the `@deepseek-ai/dsh-web-app` bundle preset declarations
 *     (`presets/<id>.patch.yml`, one `@deepseek-ai/dsh-agent-preset` row per
 *     file with the plugin list under `config.plugins`).
 *
 * Compaction policy without the patch (researched, see README "Compaction"):
 * the stock `compaction-basic` engine keeps owning the fold transaction and
 * runs untouched; Magic's planes (historian, tags/drops mutations, knowledge
 * baseline) survive folds through their own reconciliation. The Magic engine
 * (`dsh-magic-context/compaction`) remains mountable from a USER-OWNED preset
 * row for Magic-aware fold summaries — nothing under the shipped installs is
 * ever modified to get there.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { load as yamlLoad } from "js-yaml";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { locateDshInstall, magicEntryPath, magicStandardDir, resolveDshHome, agentPresetsRoot } from "../doctor/env";

/** Package holding the 0.1 shipped presets (sibling of `@deepseek-ai/dsh`). */
export const AGENT_PRESETS_PACKAGE = "@deepseek-ai/dsh-agent-presets";

/** Package holding the 0.2 preset declarations. */
export const WEB_APP_PACKAGE = "@deepseek-ai/dsh-web-app";

/** The stock engine the removed patcher used to swap out (scan constant). */
export const STOCK_COMPACTION_BASIC_NAME = "@deepseek-ai/dsh-compaction-basic";

/** The expected enclosing group shape in the 0.1 layout (scan constant). */
export const STOCK_COMPACTION_GROUP = {
  id: "compaction",
  name: "cordis:group",
  isolate: { compaction: true, toolResultPruner: true },
} as const;

/**
 * Audit state of one shipped preset file's `compaction-basic` row:
 *  - `stock`: the row still mounts the stock engine — the expected state;
 *  - `mc-patched`: the row mounts THIS build's compaction entry — a leftover
 *    of the removed in-place patcher (previous plugin version);
 *  - `mc-patched-rotted`: the row mounts an OLD `file://` entry URL — same
 *    leftover, older build;
 *  - `foreign`: recognizable file, but the row shape is not something the
 *    patcher ever wrote (informational; never a tamper signal).
 */
export type PresetAuditState = "stock" | "mc-patched" | "mc-patched-rotted" | "foreign";

export interface PresetAuditFile {
  /** Absolute path of the audited file. */
  readonly path: string;
  readonly presetId: string;
  readonly state: PresetAuditState;
  /** Diagnostics for mc-patched / mc-patched-rotted / foreign rows. */
  readonly issue?: string;
}

export interface PresetAuditResult {
  /** The resolved agent-presets package dir, when the 0.1 layout was found. */
  readonly agentPresetsDir?: string;
  /** The resolved dsh-web-app dir carrying the 0.2 preset declarations. */
  readonly webAppDir?: string;
  readonly files: readonly PresetAuditFile[];
  readonly warnings: readonly string[];
}

export interface PresetAuditOptions {
  /** Agent-presets package dir override (tests). Default: anchor chain. */
  readonly agentPresetsDir?: string;
  /** dsh-web-app package dir override (tests). Default: anchor chain. */
  readonly webAppDir?: string;
  /**
   * Live roster service instance (`ctx.get("agentPresets")`): its
   * `resolvedRoots` system entries hold the shipped preset root resolved from
   * the roster module's REAL location — the copy this composition loaded.
   */
  readonly roster?: unknown;
  /** Composition base URL (`ctx.baseUrl`) for Node-resolution anchoring. */
  readonly baseUrl?: string;
  /** This build's compaction entry URL (tests). Default: derived from dist. */
  readonly compactionEntryUrl?: string;
  /** Warning sink (tests capture lines). Default: console.warn. */
  readonly warn?: (message: string) => void;
}

/** Aggregate audit state across every scanned dir (status panel). */
export interface PresetAuditSummary {
  /** Distinct preset ids whose row mounts a Magic entry in ANY scanned dir. */
  readonly tampered: number;
  /** Distinct preset ids carrying a compaction-basic row in any scanned dir. */
  readonly total: number;
  /** Legacy thin-preset id still present under the user root (MC-generated). */
  readonly legacy?: string;
}

/**
 * Summarize an audit for the status panel: dedupe by preset id — a preset
 * counts as tampered when its state is `mc-patched`/`mc-patched-rotted` in
 * ANY scanned dir, never double-counted across the anchor chain.
 */
export function summarizePresetAudit(
  audit: PresetAuditResult,
  legacy?: string,
): PresetAuditSummary {
  const tamperedById = new Map<string, boolean>();
  for (const file of audit.files) {
    if (file.state === "mc-patched" || file.state === "mc-patched-rotted") {
      tamperedById.set(file.presetId, true);
    } else if (!tamperedById.has(file.presetId)) {
      tamperedById.set(file.presetId, false);
    }
  }
  let tampered = 0;
  for (const flag of tamperedById.values()) {
    if (flag) tampered += 1;
  }
  return legacy === undefined
    ? { tampered, total: tamperedById.size }
    : { tampered, total: tamperedById.size, legacy };
}

/** The current MC compaction entry as a file:// URL (dist/entries/compaction.js). */
export function currentCompactionEntryUrl(): string {
  return pathToFileURL(magicEntryPath("compaction")).href;
}

/**
 * Resolve the agent-presets package the CURRENT process actually uses, from
 * MC's own module context. Returns undefined when it cannot be resolved
 * (not installed / test context) — callers fail open.
 */
export function resolveAgentPresetsDir(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve(`${AGENT_PRESETS_PACKAGE}/package.json`);
    return dirname(manifest);
  } catch {
    return undefined;
  }
}

// ── shared row scanning ─────────────────────────────────────────────────────

/** Row shape of a parsed preset file (guarded reads only). */
interface Row {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly config?: unknown;
  readonly group?: unknown;
  readonly isolate?: unknown;
  readonly insert?: unknown;
}

type RowFind =
  | { kind: "target"; row: Row }
  | { kind: "skip"; issue: string }
  | { kind: "not-target" };

/** Verify a directory is actually the agent-presets package root. */
function isAgentPresetsPackage(dir: string): boolean {
  return isPackageNamed(dir, AGENT_PRESETS_PACKAGE);
}

/** Whether a directory is the dsh-web-app package root with preset files. */
function isWebAppPackage(dir: string): boolean {
  return isPackageNamed(dir, WEB_APP_PACKAGE) && existsSync(join(dir, "presets"));
}

function isPackageNamed(dir: string, expected: string): boolean {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
    return parsed.name === expected;
  } catch {
    return false;
  }
}

/** Classify a compaction-basic row name/config against this build's entry. */
function classifyRow(row: Row, currentUrl: string): { state: PresetAuditState; issue?: string } {
  const name = String(row.name);
  const config = row.config as Record<string, unknown> | undefined;
  if (name === currentUrl) {
    const configExact =
      typeof config === "object" &&
      config !== null &&
      Object.keys(config).length === 1 &&
      config.auto === true;
    return {
      state: "mc-patched",
      issue: configExact
        ? undefined
        : `row mounts the current entry but config is ${config === undefined ? "missing" : "not { auto: true }"}`,
    };
  }
  if (name.startsWith("file:")) {
    return {
      state: "mc-patched-rotted",
      issue: `row mounts ${name} (a Magic compaction entry from an older build)`,
    };
  }
  return { state: "stock" };
}

// ── 0.1 layout: agent-presets presets/<id>/agent.cordis.yml ────────────────

/** Runtime shape of the live roster's private `resolvedRoots` (guarded read). */
interface RosterLike {
  readonly resolvedRoots?: ReadonlyArray<{
    readonly path?: unknown;
    readonly trust?: unknown;
  }>;
}

/** Candidate package dirs from the LIVE roster service (anchor tier 1). */
function candidateDirsFromRoster(roster: unknown): string[] {
  const roots = (roster as RosterLike | undefined)?.resolvedRoots;
  if (!Array.isArray(roots)) return [];
  const dirs: string[] = [];
  for (const root of roots) {
    if (root?.trust !== "system" || typeof root.path !== "string") continue;
    dirs.push(dirname(root.path));
  }
  return dirs;
}

/** Node-resolution from a composition base URL (anchor tier 2). */
function candidateDirFromBaseUrl(baseUrl: string): string | undefined {
  try {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const require = createRequire(`${base}package.json`);
    return dirname(require.resolve(`${AGENT_PRESETS_PACKAGE}/package.json`));
  } catch {
    return undefined; // pnpm layouts: the walk from the profile dir finds nothing
  }
}

/** The exact isolate realms that identify the compaction group (0.1 shape). */
function isCompactionShapedV1(group: Row): boolean {
  return (
    group.name === "cordis:group" &&
    group.group === true &&
    JSON.stringify(group.isolate) === JSON.stringify(STOCK_COMPACTION_GROUP.isolate)
  );
}

/** Locate (and shape-verify) the compaction-basic row in a 0.1 preset list. */
function findRowV1(entries: Row[]): RowFind {
  const groups = entries.filter(
    (row) => row.name === "cordis:group" && row.group === true,
  );
  const matches = groups.flatMap((group) =>
    (Array.isArray(group.config) ? (group.config as Row[]) : []).flatMap((row) =>
      row.id === "compaction-basic" ? [{ group, row }] : [],
    ),
  );
  if (matches.length === 0) {
    const shaped = groups.filter(isCompactionShapedV1);
    if (shaped.length > 0) {
      return { kind: "skip", issue: "compaction group has no compaction-basic row" };
    }
    return { kind: "not-target" };
  }
  if (matches.length > 1) {
    return { kind: "skip", issue: "multiple compaction-basic rows found" };
  }
  const { group, row } = matches[0]!;
  if (!isCompactionShapedV1(group)) {
    return {
      kind: "skip",
      issue:
        "compaction-basic row sits outside a compaction-shaped group " +
        "(group name/isolate realms changed)",
    };
  }
  if (group.id !== STOCK_COMPACTION_GROUP.id) {
    return { kind: "skip", issue: "compaction group id changed" };
  }
  const name = row.name;
  const nameValid =
    typeof name === "string" &&
    (name === STOCK_COMPACTION_BASIC_NAME || name.startsWith("file:"));
  if (!nameValid) {
    return {
      kind: "skip",
      issue: `compaction-basic row names ${typeof name === "string" ? `"${name}"` : String(name)}`,
    };
  }
  return { kind: "target", row };
}

type Classified =
  | { kind: "not-target" }
  | { kind: "target"; state: PresetAuditState; issue?: string }
  | { kind: "mismatch"; issue: string };

function classifyV1File(path: string, currentUrl: string): Classified {
  let entries: Row[];
  try {
    entries = yamlLoad(readFileSync(path, "utf8"), {
      schema: entryListSchema,
    }) as Row[];
  } catch (error) {
    return { kind: "mismatch", issue: `unparseable YAML: ${(error as Error).message}` };
  }
  const found = findRowV1(entries);
  if (found.kind === "not-target") return { kind: "not-target" };
  if (found.kind === "skip") return { kind: "mismatch", issue: found.issue };
  return { kind: "target", ...classifyRow(found.row, currentUrl) };
}

function scanV1Files(
  agentPresetsDir: string,
  currentUrl: string,
): { files: PresetAuditFile[]; warnings: string[] } {
  const files: PresetAuditFile[] = [];
  const warnings: string[] = [];
  const presetsDir = join(agentPresetsDir, "presets");
  let presetDirs: string[] = [];
  try {
    presetDirs = readdirSync(presetsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { files, warnings };
  }
  for (const presetId of presetDirs) {
    const path = join(presetsDir, presetId, "agent.cordis.yml");
    if (!existsSync(path)) continue;
    const classified = classifyV1File(path, currentUrl);
    if (classified.kind === "not-target") continue;
    if (classified.kind === "mismatch") {
      files.push({ path, presetId, state: "foreign", issue: classified.issue });
      warnings.push(`[dsh-magic-context] preset audit — ${path}: ${classified.issue}`);
    } else {
      files.push({ path, presetId, state: classified.state, issue: classified.issue });
    }
  }
  return { files, warnings };
}

// ── 0.2 layout: dsh-web-app presets/<id>.patch.yml ─────────────────────────

/** The compaction group shape inside a 0.2 preset declaration. */
function isCompactionShapedV2(group: Row): boolean {
  return (
    group.name === "cordis:group" &&
    group.group === true &&
    group.isolate !== undefined &&
    (group.isolate as Record<string, unknown>).compaction === true
  );
}

/** Locate the compaction-basic row inside a 0.2 preset patch file. */
function findRowV2(patches: Row[]): RowFind {
  const matches: Row[] = [];
  for (const patch of patches) {
    if (!Array.isArray(patch.insert)) continue;
    for (const inserted of patch.insert as Row[]) {
      if (inserted?.name !== "@deepseek-ai/dsh-agent-preset") continue;
      const plugins = (inserted.config as { plugins?: unknown } | undefined)?.plugins;
      if (!Array.isArray(plugins)) continue;
      for (const group of plugins as Row[]) {
        if (!isCompactionShapedV2(group)) continue;
        for (const row of Array.isArray(group.config) ? (group.config as Row[]) : []) {
          if (row.id === "compaction-basic") matches.push(row);
        }
      }
    }
  }
  if (matches.length === 0) {
    return { kind: "not-target" };
  }
  if (matches.length > 1) {
    return { kind: "skip", issue: "multiple compaction-basic rows found" };
  }
  const row = matches[0]!;
  const name = row.name;
  const nameValid =
    typeof name === "string" &&
    (name === STOCK_COMPACTION_BASIC_NAME || name.startsWith("file:"));
  if (!nameValid) {
    return {
      kind: "skip",
      issue: `compaction-basic row names ${typeof name === "string" ? `"${name}"` : String(name)}`,
    };
  }
  return { kind: "target", row };
}

function classifyV2File(path: string, currentUrl: string): Classified {
  let patches: Row[];
  try {
    patches = yamlLoad(readFileSync(path, "utf8"), { schema: entryListSchema }) as Row[];
  } catch (error) {
    return { kind: "mismatch", issue: `unparseable YAML: ${(error as Error).message}` };
  }
  if (!Array.isArray(patches)) {
    return { kind: "mismatch", issue: "top level is not an entry patch list" };
  }
  const found = findRowV2(patches);
  if (found.kind === "not-target") return { kind: "not-target" };
  if (found.kind === "skip") return { kind: "mismatch", issue: found.issue };
  return { kind: "target", ...classifyRow(found.row, currentUrl) };
}

function scanV2Files(
  webAppDir: string,
  currentUrl: string,
): { files: PresetAuditFile[]; warnings: string[] } {
  const files: PresetAuditFile[] = [];
  const warnings: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(join(webAppDir, "presets"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".patch.yml"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { files, warnings };
  }
  for (const file of entries) {
    const presetId = file.slice(0, -".patch.yml".length);
    const path = join(webAppDir, "presets", file);
    const classified = classifyV2File(path, currentUrl);
    if (classified.kind === "not-target") continue;
    if (classified.kind === "mismatch") {
      files.push({ path, presetId, state: "foreign", issue: classified.issue });
      warnings.push(`[dsh-magic-context] preset audit — ${path}: ${classified.issue}`);
    } else {
      files.push({ path, presetId, state: classified.state, issue: classified.issue });
    }
  }
  return { files, warnings };
}

// ── dir anchor chains ──────────────────────────────────────────────────────

/**
 * Verified 0.1 candidate package dirs, first non-empty tier wins:
 * 1. the live roster's system roots — the copy THIS composition loaded;
 * 2. Node resolution from the composition base URL — flat/hoisted installs;
 * 3. Node resolution from this module's own context — published installs.
 */
function resolveCandidateDirs(options: PresetAuditOptions): string[] {
  const tiers: string[][] = [
    candidateDirsFromRoster(options.roster),
    typeof options.baseUrl === "string" && options.baseUrl !== ""
      ? [candidateDirFromBaseUrl(options.baseUrl)].filter((dir): dir is string => dir !== undefined)
      : [],
    [resolveAgentPresetsDir()].filter((dir): dir is string => dir !== undefined),
  ];
  for (const tier of tiers) {
    const verified: string[] = [];
    const seen = new Set<string>();
    for (const candidate of tier) {
      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        continue;
      }
      if (seen.has(real) || !isAgentPresetsPackage(real)) continue;
      seen.add(real);
      verified.push(real);
    }
    if (verified.length > 0) return verified;
  }
  return [];
}

/** Walk up from a file inside the dsh package to its package root. */
function dshRootFromFile(file: string): string | undefined {
  let dir = dirname(file);
  for (let depth = 0; depth < 10 && dir !== dirname(dir); depth += 1) {
    if (isPackageNamed(dir, "@deepseek-ai/dsh")) return dir;
    dir = dirname(dir);
  }
  return undefined;
}

/**
 * Verified web-app dirs (first non-empty tier wins):
 *   1. explicit override (`webAppDir` option, tests);
 *   2. `DSH_WEB_APP_DIR` env (escape hatch);
 *   3. the running process: walk up from `process.argv[1]` (the dsh host's
 *      own bin.js) to the `@deepseek-ai/dsh` package root, then the sibling
 *      `dsh-web-app` in the same node_modules tree;
 *   4. `locateDshInstall` (PATH probe, CLI doctor context) → sibling.
 * Node-resolution from this module's context is deliberately NOT an anchor:
 * the 0.2 runtime composes the web-app bundle from the DSH INSTALLATION, not
 * from the profile.
 */
export function resolveWebAppDirs(explicit?: string): string[] {
  const tiers: string[][] = [];
  if (explicit !== undefined && explicit !== "") tiers.push([explicit]);
  const envDir = process.env.DSH_WEB_APP_DIR;
  if (envDir !== undefined && envDir.trim() !== "") tiers.push([envDir.trim()]);
  if (process.argv[1] !== undefined) {
    try {
      const realArgv = realpathSync(process.argv[1]);
      const dshRoot = dshRootFromFile(realArgv);
      if (dshRoot !== undefined) tiers.push([join(dirname(dshRoot), "dsh-web-app")]);
    } catch {
      // argv[1] unreadable — later tiers still apply.
    }
  }
  const located = locateDshInstall({ dshHome: resolveDshHome() });
  if (located.dshInstallDir !== undefined) {
    tiers.push([join(dirname(located.dshInstallDir), "dsh-web-app")]);
  }

  const verified: string[] = [];
  const seen = new Set<string>();
  for (const tier of tiers) {
    let tierHit = false;
    for (const candidate of tier) {
      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        continue;
      }
      if (seen.has(real) || !isWebAppPackage(real)) continue;
      seen.add(real);
      verified.push(real);
      tierHit = true;
    }
    if (tierHit) break;
  }
  return verified;
}

// ── the audit entry point ──────────────────────────────────────────────────

/**
 * Read-only audit of every shipped preset file that carries a
 * `compaction-basic` row, covering BOTH layouts. Never writes. Skipping the
 * 0.1 scan when the caller pinned only the 0.2 dir (and vice versa) keeps
 * tests hermetic.
 */
export function auditShippedPresets(options: PresetAuditOptions = {}): PresetAuditResult {
  const currentUrl = options.compactionEntryUrl ?? currentCompactionEntryUrl();
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const files: PresetAuditFile[] = [];
  const warnings: string[] = [];
  let agentPresetsDir: string | undefined;

  const v1Dirs =
    options.agentPresetsDir !== undefined
      ? [options.agentPresetsDir]
      : options.webAppDir === undefined
        ? resolveCandidateDirs(options)
        : [];
  if (v1Dirs.length > 0) {
    agentPresetsDir = v1Dirs[0]!;
    for (const dir of v1Dirs) {
      const scan = scanV1Files(dir, currentUrl);
      files.push(...scan.files);
      warnings.push(...scan.warnings);
      for (const warning of scan.warnings) warn(warning);
    }
  } else if (options.agentPresetsDir === undefined && options.webAppDir === undefined) {
    // Only warn about the missing 0.1 anchor when auditing live: an explicit
    // webAppDir pin means the caller only cares about the 0.2 layout.
    const warning =
      `[dsh-magic-context] cannot resolve ${AGENT_PRESETS_PACKAGE} from this module context; ` +
      `0.1 preset layout not audited`;
    warnings.push(warning);
    warn(warning);
  }

  let webAppDir: string | undefined;
  const v2Dirs =
    options.webAppDir !== undefined
      ? [options.webAppDir]
      : options.agentPresetsDir === undefined
        ? resolveWebAppDirs()
        : [];
  if (v2Dirs.length > 0) {
    webAppDir = v2Dirs[0]!;
    const scan = scanV2Files(webAppDir, currentUrl);
    files.push(...scan.files);
    warnings.push(...scan.warnings);
    for (const warning of scan.warnings) warn(warning);
  }

  return {
    ...(agentPresetsDir !== undefined ? { agentPresetsDir } : {}),
    ...(webAppDir !== undefined ? { webAppDir } : {}),
    files,
    warnings,
  };
}

// ── legacy magic-standard cleanup (plugin-OWNED artifacts only) ─────────────

/**
 * Whether `$DSH_HOME/.agent-presets/magic-standard/` is verifiably MC-
 * generated (the thin preset): its agent.cordis.yml parses and carries either
 * the `magic-include-standard` include row or a row naming this package's
 * `dist/entries/*` files. Only such directories are ever touched; anything
 * else is left alone.
 */
export function detectLegacyMagicStandard(
  dshHome: string,
): { state: "absent" | "present" | "present-not-mc"; dir: string; reason?: string } {
  const dir = magicStandardDir(dshHome);
  if (!existsSync(dir)) return { state: "absent", dir };
  const agentCordis = join(dir, "agent.cordis.yml");
  if (!existsSync(agentCordis)) {
    return { state: "present-not-mc", dir, reason: "no agent.cordis.yml" };
  }
  try {
    const entries = yamlLoad(readFileSync(agentCordis, "utf8"), {
      schema: entryListSchema,
    }) as Row[];
    const mcGenerated = entries.some(
      (row) =>
        row.id === "magic-include-standard" ||
        (typeof row.name === "string" && row.name.includes("dist/entries/")) ||
        (typeof row.id === "string" && row.id.startsWith("dsh-magic-context")),
    );
    if (!mcGenerated) {
      return {
        state: "present-not-mc",
        dir,
        reason: "agent.cordis.yml carries no Magic Context rows",
      };
    }
    return { state: "present", dir };
  } catch (error) {
    return {
      state: "present-not-mc",
      dir,
      reason: `agent.cordis.yml unparseable: ${(error as Error).message}`,
    };
  }
}

/**
 * Remove the legacy magic-standard preset if (and only if) it verifiably is
 * MC-generated. This deletes a plugin-OWNED artifact from an old version —
 * it never touches shipped presets. Boot calls this; doctor reports it.
 */
export function removeLegacyMagicStandard(
  dshHome: string,
): { removed: boolean; reason?: string } {
  const detected = detectLegacyMagicStandard(dshHome);
  if (detected.state !== "present") return { removed: false, reason: detected.reason };
  rmSync(detected.dir, { recursive: true, force: true });
  return { removed: !existsSync(detected.dir) };
}

/** User-root presets (NOT magic-standard) whose agent.cordis.yml references the stock compaction engine. */
export function listUserRootPresetsReferencingCompactionBasic(dshHome: string): string[] {
  const root = agentPresetsRoot(dshHome);
  let presetDirs: string[] = [];
  try {
    presetDirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "magic-standard")
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const presetId of presetDirs) {
    const file = join(root, presetId, "agent.cordis.yml");
    if (!existsSync(file)) continue;
    try {
      if (readFileSync(file, "utf8").includes(STOCK_COMPACTION_BASIC_NAME)) {
        found.push(presetId);
      }
    } catch {
      // Unreadable user preset — informational scan, skip.
    }
  }
  return found;
}

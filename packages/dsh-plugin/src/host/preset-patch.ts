/**
 * host/preset-patch — in-place patch of the SHIPPED agent-preset files (ADR 0001).
 *
 * Compaction cannot be replaced from the host plane; it must be a row inside
 * each preset's isolated `compaction` realm, and shipped preset ids cannot be
 * shadowed from roster roots. So the `compaction-basic` row of every shipped
 * preset that carries it (today: standard, cordis, ptc — minimal does not) is
 * patched IN PLACE:
 *
 *   - `name:` swapped to a `file://` URL of THIS package's built compaction
 *     entry (`dist/entries/compaction.js`), so the row mounts the Magic engine
 *     instead of the stock one;
 *   - `config:` set to `{ auto: true }` (the Magic engine's auto mode).
 *
 * Writes are tmp-file + atomic rename in the target directory, NEVER in-place
 * content edits: pnpm node_modules files are hardlinks into the content-
 * addressed store, so an in-place write would pierce the store copy. Rename
 * replaces the directory entry, keeping the store copy intact for everyone
 * else.
 *
 * Fail-open contract: every shipped preset file whose compaction group holds a
 * `compaction-basic` row is scanned; a file whose shape is unrecognized (dsh
 * upgraded and changed the composition) logs ONE warning naming the file and
 * reason and is skipped — stock compaction then runs for that preset and the
 * rest of Magic Context keeps working. User-root presets (`~/.agent-presets/`)
 * are never touched: only files inside the resolved agent-presets package dir
 * are eligible, and the package identity is verified before any write.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { load as yamlLoad } from "js-yaml";
import { entryListSchema } from "@deepseek-ai/cordis-plugin-include";
import { agentPresetsRoot, magicEntryPath, magicStandardDir } from "../doctor/env";

/** Package holding the shipped presets (sibling of `@deepseek-ai/dsh`). */
export const AGENT_PRESETS_PACKAGE = "@deepseek-ai/dsh-agent-presets";

/** The stock engine the patch REPLACES (contract scan constant). */
export const STOCK_COMPACTION_BASIC_NAME = "@deepseek-ai/dsh-compaction-basic";

/** The expected enclosing group shape (contract scan constant). */
export const STOCK_COMPACTION_GROUP = {
  id: "compaction",
  name: "cordis:group",
  isolate: { compaction: true, toolResultPruner: true },
} as const;

export type PresetPatchState = "applied" | "stock" | "contract-mismatch" | "mc-path-rotted";

export interface PresetPatchFile {
  /** Absolute path of `<presets>/<id>/agent.cordis.yml`. */
  readonly path: string;
  readonly presetId: string;
  /** State BEFORE this run's write decision (doctor scans report this as-is). */
  readonly state: PresetPatchState;
  /** Reason for contract-mismatch / mc-path-rotted (diagnostics). */
  readonly issue?: string;
}

export interface PresetPatchResult {
  /** The resolved agent-presets package dir (undefined when it could not be resolved). */
  readonly agentPresetsDir?: string;
  readonly files: readonly PresetPatchFile[];
  /** Files actually rewritten this run (atomic rename). */
  readonly patched: readonly string[];
  /** Files skipped for a contract mismatch (one warning each). */
  readonly skipped: readonly string[];
  /** Files already exactly current (no write). */
  readonly noOps: readonly string[];
  /** Every warning line emitted by this run. */
  readonly warnings: readonly string[];
}

export interface PresetPatchOptions {
  /** Agent-presets package dir override (tests). Default: resolved live context. */
  readonly agentPresetsDir?: string;
  /**
   * Live roster service instance (`ctx.get("agentPresets")`, ADR 0001 anchor
   * chain): its `resolvedRoots` system entries hold the shipped preset root
   * resolved from the roster module's REAL location — the copy this
   * composition actually loaded, which can differ from our own
   * `require.resolve` anchor when this package is a dev symlink.
   */
  readonly roster?: unknown;
  /** Composition base URL (`ctx.baseUrl`) for Node-resolution anchoring. */
  readonly baseUrl?: string;
  /** Current Magic compaction entry as a `file://` URL (tests). Default: magicEntryPath("compaction"). */
  readonly compactionEntryUrl?: string;
  /** Warning sink (tests capture lines). Default: console.warn. */
  readonly warn?: (message: string) => void;
}

/** Aggregate patch state across every scanned package dir (status panel). */
export interface PresetPatchSummary {
  /** Distinct preset ids whose row mounts the current MC entry in ANY scanned dir. */
  readonly patched: number;
  /** Distinct preset ids carrying a compaction-basic row in any scanned dir. */
  readonly total: number;
  /** Legacy thin-preset id still present under the user root (MC-generated). */
  readonly legacy?: string;
}

/**
 * Summarize a patch scan for the status panel: dedupe by preset id — a preset
 * counts as patched when its state is "applied" in ANY scanned dir (the
 * runtime-relevant roster-anchored dir wins by construction of the anchor
 * chain), never double-counted across the multiple dirs the chain scanned.
 * `legacy` names a leftover MC-generated thin preset under the user root.
 */
export function summarizePresetPatchStates(
  states: PresetPatchResult,
  legacy?: string,
): PresetPatchSummary {
  const patchedById = new Map<string, boolean>();
  for (const file of states.files) {
    if (file.state === "applied") {
      patchedById.set(file.presetId, true);
    } else if (!patchedById.has(file.presetId)) {
      patchedById.set(file.presetId, false);
    }
  }
  let patched = 0;
  for (const applied of patchedById.values()) {
    if (applied) patched += 1;
  }
  return legacy === undefined
    ? { patched, total: patchedById.size }
    : { patched, total: patchedById.size, legacy };
}

/**
 * Resolve the agent-presets package the CURRENT process actually uses, from
 * MC's own module context: the package resolves through the same profile
 * node_modules that holds this package. Returns undefined when it cannot be
 * resolved (not installed / test context) — callers fail open.
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

/** Runtime shape of the live roster's private `resolvedRoots` (guarded read). */
interface RosterLike {
  readonly resolvedRoots?: ReadonlyArray<{
    readonly path?: unknown;
    readonly trust?: unknown;
  }>;
}

/**
 * Candidate package dirs from the LIVE roster service (ADR 0001 anchor chain):
 * its `resolvedRoots` system entries hold SHIPPED_PRESET_ROOT — resolved from
 * the roster module's REAL location, i.e. the copy this composition actually
 * loaded. TypeScript-private on the roster class, runtime-readable; every
 * candidate still passes {@link isAgentPresetsPackage} before any write, so a
 * harness rename degrades to the next anchor instead of patching garbage.
 */
function candidateDirsFromRoster(roster: unknown): string[] {
  const roots = (roster as RosterLike | undefined)?.resolvedRoots;
  if (!Array.isArray(roots)) return [];
  const dirs: string[] = [];
  for (const root of roots) {
    if (root?.trust !== "system" || typeof root.path !== "string") continue;
    // SHIPPED_PRESET_ROOT is `<package>/presets[/\\]` — the package root is its parent
    // (dirname strips a trailing separator component first, both spellings work).
    dirs.push(dirname(root.path));
  }
  return dirs;
}

/**
 * Resolve Node-style from a composition base URL (flat/hoisted installs where
 * the base directory's node_modules walk reaches the agent-presets package).
 */
function candidateDirFromBaseUrl(baseUrl: string): string | undefined {
  try {
    const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    const require = createRequire(`${base}package.json`);
    return dirname(require.resolve(`${AGENT_PRESETS_PACKAGE}/package.json`));
  } catch {
    return undefined; // pnpm layouts: the walk from the profile dir finds nothing
  }
}

/**
 * Verified candidate package dirs (ADR 0001 anchor chain), first non-empty
 * tier wins so tests never touch the real filesystem via the self anchor:
 * 1. the live roster's system roots — the copy THIS composition loaded;
 * 2. Node resolution from the composition base URL — flat/hoisted installs;
 * 3. Node resolution from this module's own context — normal published
 *    installs (peer context). Under a dev symlink this is the repo's
 *    node_modules copy, which is why it runs only when no earlier tier hit.
 */
function resolveCandidateDirs(options: PresetPatchOptions): string[] {
  const tiers: string[][] = [
    candidateDirsFromRoster(options.roster),
    typeof options.baseUrl === "string" && options.baseUrl !== ""
      ? [candidateDirFromBaseUrl(options.baseUrl)].filter((dir): dir is string => dir !== undefined)
      : [],
    [resolveAgentPresetsDir()].filter((dir): dir is string => dir !== undefined),
  ];
  // First tier with at least one VERIFIED dir wins: a tier whose candidates all
  // fail verification (harness restructured its roots) falls through to the
  // next anchor instead of skipping the patch entirely.
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

/** The row-id text marker used to locate the target row in raw YAML. */
const BASIC_ROW_MARKER = /^\s*- id: compaction-basic\s*$/;

interface Row {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly config?: unknown;
  readonly group?: unknown;
  readonly isolate?: unknown;
}

type TargetFind =
  | { kind: "target"; group: Row; row: Row; entries: Row[] }
  | { kind: "skip"; issue: string }
  | { kind: "not-target" };

/** The exact isolate realms that identify the compaction group. */
function isCompactionShaped(group: Row): boolean {
  return (
    group.name === "cordis:group" &&
    group.group === true &&
    JSON.stringify(group.isolate) === JSON.stringify(STOCK_COMPACTION_GROUP.isolate)
  );
}

/** Locate (and contract-verify) the patch target inside one parsed preset. */
function findTarget(entries: Row[]): TargetFind {
  const groups = entries.filter(
    (row) => row.name === "cordis:group" && row.group === true,
  );
  const matches = groups.flatMap((group) =>
    (Array.isArray(group.config) ? (group.config as Row[]) : []).flatMap((row) =>
      row.id === "compaction-basic" ? [{ group, row }] : [],
    ),
  );
  if (matches.length === 0) {
    // No compaction-basic row anywhere. A preset that still carries a
    // compaction-shaped group has an unknown row shape (dsh renamed/removed
    // the engine) — that is a contract mismatch worth reporting. A preset
    // with no compaction group at all (e.g. `minimal`) is simply not a target.
    const shaped = groups.filter(isCompactionShaped);
    if (shaped.length > 0) {
      return { kind: "skip", issue: "compaction group has no compaction-basic row" };
    }
    return { kind: "not-target" };
  }
  if (matches.length > 1) {
    return { kind: "skip", issue: "multiple compaction-basic rows found" };
  }
  const { group, row } = matches[0]!;
  if (!isCompactionShaped(group)) {
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
      issue:
        `compaction-basic row names ${typeof name === "string" ? `"${name}"` : String(name)} ` +
        `— neither the stock engine nor a file URL; not touching it`,
    };
  }
  return { kind: "target", group, row, entries };
}

/** One warning line per problem, or the file's state when it is a patch target. */
type Classified = { kind: "not-target" } | {
  kind: "target";
  state: PresetPatchState;
  issue?: string;
  entries: Row[];
  group: Row;
  row: Row;
} | { kind: "mismatch"; issue: string };

function classifyFile(path: string, currentUrl: string): Classified {
  let entries: Row[];
  try {
    entries = yamlLoad(readFileSync(path, "utf8"), {
      schema: entryListSchema,
    }) as Row[];
  } catch (error) {
    return { kind: "mismatch", issue: `unparseable YAML: ${(error as Error).message}` };
  }
  const found = findTarget(entries);
  if (found.kind === "not-target") {
    return { kind: "not-target" };
  }
  if (found.kind === "skip") {
    return { kind: "mismatch", issue: found.issue };
  }
  const { group, row } = found;
  const name = String(row.name);
  const config = row.config as Record<string, unknown> | undefined;
  const hasExactConfig = (): boolean =>
    typeof config === "object" &&
    config !== null &&
    Object.keys(config).length === 1 &&
    config.auto === true;
  if (name === currentUrl) {
    if (hasExactConfig()) {
      return { kind: "target", state: "applied", entries, group, row };
    }
    return {
      kind: "target",
      state: "mc-path-rotted",
      issue: `name is current but config is ${config === undefined ? "missing" : "not { auto: true }"}`,
      entries,
      group,
      row,
    };
  }
  if (name.startsWith("file:")) {
    return {
      kind: "target",
      state: "mc-path-rotted",
      issue: `points at ${name}; current entry is ${currentUrl}`,
      entries,
      group,
      row,
    };
  }
  return { kind: "target", state: "stock", entries, group, row };
}

interface ScanFilesResult {
  readonly targets: {
    path: string;
    presetId: string;
    state: PresetPatchState;
    issue?: string;
    entries: Row[];
    group: Row;
    row: Row;
  }[];
  readonly mismatches: { presetId: string; path: string; issue: string }[];
}

/**
 * Scan `<presets>/<id>/agent.cordis.yml` files. Files without a
 * `compaction-basic` row at all (e.g. the `minimal` preset) are not targets
 * and are silently excluded; files whose row exists but whose shape is
 * unrecognized come back as contract mismatches.
 */
function scanPresetFiles(agentPresetsDir: string, currentUrl: string): ScanFilesResult {
  const presetsDir = join(agentPresetsDir, "presets");
  const targets: ScanFilesResult["targets"] = [];
  const mismatches: ScanFilesResult["mismatches"] = [];
  let presetDirs: string[] = [];
  try {
    presetDirs = readdirSync(presetsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { targets, mismatches };
  }
  for (const presetId of presetDirs) {
    const path = join(presetsDir, presetId, "agent.cordis.yml");
    if (!existsSync(path)) continue;
    const classified = classifyFile(path, currentUrl);
    if (classified.kind === "not-target") continue;
    if (classified.kind === "mismatch") {
      mismatches.push({ presetId, path, issue: classified.issue });
    } else {
      targets.push({ path, presetId, ...classified });
    }
  }
  return { targets, mismatches };
}

/** The current MC compaction entry as a file:// URL (dist/entries/compaction.js). */
export function currentCompactionEntryUrl(): string {
  return pathToFileURL(magicEntryPath("compaction")).href;
}

function sanitizeUrl(url: string): string {
  return url.replaceAll("'", "''");
}

/**
 * Surgical row edit on raw YAML text: swaps the `name:` line's value to the
 * current entry URL and ensures a single-line `config: { auto: true }`. Every
 * other line — sibling rows, comments, the group's isolate realm — is
 * preserved byte-for-byte. Returns undefined when the row's text shape is not
 * the recognizable block form (fail open: caller skips with a warning).
 */
export function rewriteCompactionRowText(
  text: string,
  targetUrl: string,
): { patched: string; changed: boolean; issue?: string } {
  const lines = text.split("\n");
  const markerIndices = lines
    .map((line, index) => (BASIC_ROW_MARKER.test(line) ? index : -1))
    .filter((index) => index >= 0);
  if (markerIndices.length !== 1) {
    return { patched: text, changed: false, issue: `${markerIndices.length} compaction-basic row markers in text` };
  }
  const rowIndex = markerIndices[0]!;
  const rowIndent = lines[rowIndex]!.match(/^\s*/)![0].length;
  // Row extent: until the next list item at the same or shallower indent.
  let end = lines.length;
  for (let i = rowIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (/^\s*- /.test(line)) {
      const indent = line.match(/^\s*/)![0].length;
      if (indent <= rowIndent) {
        end = i;
        break;
      }
    }
  }

  let nameLine = -1;
  let configLine = -1;
  let configBlock = false;
  const rowLines = lines.slice(rowIndex, end);
  const keyIndent = rowIndent + 2;
  for (let j = 0; j < rowLines.length; j += 1) {
    const line = rowLines[j]!;
    if (line.trim() === "") continue;
    const nameMatch = /^(\s*)name:\s*(.*)$/.exec(line);
    if (nameMatch !== null && nameMatch[1]!.length === keyIndent) {
      nameLine = rowIndex + j;
    }
    const configMatch = /^(\s*)config:\s*(.*)$/.exec(line);
    if (configMatch !== null && configMatch[1]!.length === keyIndent) {
      configLine = rowIndex + j;
      const value = configMatch[2]!.trim();
      // Block scalars / folded / multiline arrays are not the single-line
      // shape we own; leaving a foreign config untouched is the safe move.
      if (value === "" || value.startsWith("|") || value.startsWith(">") || value.startsWith("-")) {
        configBlock = true;
      }
    }
  }

  const targetLine = (() => {
    // Name must precede the extent end; if the name line is not a plain
    // single-line scalar (or absent), we cannot safely recognize the row.
    if (nameLine < 0) return undefined;
    const raw = lines[nameLine]!;
    const match = /^(\s*)name:\s*([^#]*?)\s*$/.exec(raw);
    if (match === null) return undefined;
    return { nameLine, currentName: match[2]!.trim() };
  })();

  if (targetLine === undefined && nameLine >= 0) {
    return { patched: text, changed: false, issue: "compaction-basic name line is not a single-line scalar" };
  }
  if (targetLine === undefined) {
    return { patched: text, changed: false, issue: "compaction-basic row has no name line" };
  }

  const out = [...lines];
  let changed = false;

  const wantName = `'${sanitizeUrl(targetUrl)}'`;
  if (targetLine.currentName !== wantName) {
    out[targetLine.nameLine] = `${" ".repeat(keyIndent)}name: ${wantName}`;
    changed = true;
  }

  const expectedConfig = `${" ".repeat(keyIndent)}config: { auto: true }`;
  if (configLine >= 0) {
    if (configBlock) {
      return { patched: text, changed: false, issue: "config is a block scalar; leaving untouched" };
    }
    const normalizedValue = out[configLine]!.replace(/^(\s*)config:\s*/, "").replace(/\s+/g, "");
    if (normalizedValue !== "{auto:true}") {
      out[configLine] = expectedConfig;
      changed = true;
    }
  } else {
    // Insert the config line right after the name line.
    out.splice(targetLine.nameLine + 1, 0, expectedConfig);
    changed = true;
  }

  if (changed) {
    return { patched: out.join("\n"), changed: true };
  }
  return { patched: text, changed: false };
}

/** Verify a directory is actually the agent-presets package root. */
function isAgentPresetsPackage(dir: string): boolean {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) return false;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown };
    return parsed.name === AGENT_PRESETS_PACKAGE;
  } catch {
    return false;
  }
}

/** Atomic replace: tmp file + rename in the same directory (mode preserved). */
function replaceFileAtomic(target: string, content: string): void {
  const dir = dirname(target);
  const mode = statSync(target).mode & 0o777;
  const tmp = join(
    dir,
    `.${target.split(/[\\/]/).pop()}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  writeFileSync(tmp, content, { encoding: "utf8", mode });
  try {
    renameSync(tmp, target);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Read-only patch-state scan over every shipped preset file (doctor/setup
 * reporting). Never writes.
 */
export function scanPresetPatchStates(
  options: PresetPatchOptions = {},
): PresetPatchResult {
  const currentUrl = options.compactionEntryUrl ?? currentCompactionEntryUrl();
  const warn = options.warn ?? defaultWarn;

  const dirs =
    options.agentPresetsDir !== undefined
      ? [options.agentPresetsDir]
      : resolveCandidateDirs(options);
  if (dirs.length === 0) {
    const warning = `[dsh-magic-context] cannot resolve ${AGENT_PRESETS_PACKAGE} from this module context; shipped-preset patch state unknown`;
    warn(warning);
    return { files: [], patched: [], skipped: [], noOps: [], warnings: [warning] };
  }

  const files: PresetPatchFile[] = [];
  const noOps: string[] = [];
  const warnings: string[] = [];
  for (const agentPresetsDir of dirs) {
    const { targets, mismatches } = scanPresetFiles(agentPresetsDir, currentUrl);
    for (const target of targets) {
      files.push({
        path: target.path,
        presetId: target.presetId,
        state: target.state,
        issue: target.issue,
      });
      if (target.state === "applied") noOps.push(target.path);
    }
    for (const mismatch of mismatches) {
      files.push({ path: mismatch.path, presetId: mismatch.presetId, state: "contract-mismatch", issue: mismatch.issue });
      const warning = `[dsh-magic-context] preset patch skipped — ${mismatch.path}: ${mismatch.issue}`;
      warnings.push(warning);
      warn(warning);
    }
  }
  return {
    agentPresetsDir: dirs[0]!,
    files,
    patched: [],
    skipped: files.filter((file) => file.state === "contract-mismatch").map((file) => file.path),
    noOps,
    warnings,
  };
}

function defaultWarn(message: string): void {
  console.warn(message);
}

/**
 * Boot-time self-heal: patch every shipped preset whose compaction group holds
 * a `compaction-basic` row, synchronously (callers run it inside apply()).
 * Idempotent: already-current files are no-ops; a rotated-stock file is
 * re-applied; a rotted URL is rewritten to the current entry.
 */
export function patchShippedPresets(options: PresetPatchOptions = {}): PresetPatchResult {
  const currentUrl = options.compactionEntryUrl ?? currentCompactionEntryUrl();
  const warn = options.warn ?? defaultWarn;
  const warnings: string[] = [];

  const dirs =
    options.agentPresetsDir !== undefined
      ? [options.agentPresetsDir]
      : resolveCandidateDirs(options);
  if (dirs.length === 0) {
    const warning = `[dsh-magic-context] cannot resolve ${AGENT_PRESETS_PACKAGE} from this module context; shipped-preset patch skipped`;
    warnings.push(warning);
    warn(warning);
    return { files: [], patched: [], skipped: [], noOps: [], warnings };
  }

  const files: PresetPatchFile[] = [];
  const patched: string[] = [];
  const noOps: string[] = [];

  for (const agentPresetsDir of dirs) {
    if (!isAgentPresetsPackage(agentPresetsDir)) {
      const warning =
        `[dsh-magic-context] refusing to patch ${agentPresetsDir}: not the ` +
        `${AGENT_PRESETS_PACKAGE} package root (user-root presets are never touched)`;
      warnings.push(warning);
      warn(warning);
      continue;
    }

    const { targets, mismatches } = scanPresetFiles(agentPresetsDir, currentUrl);

    for (const mismatch of mismatches) {
      const warning = `[dsh-magic-context] preset patch skipped — ${mismatch.path}: ${mismatch.issue}`;
      warnings.push(warning);
      warn(warning);
      files.push({ path: mismatch.path, presetId: mismatch.presetId, state: "contract-mismatch", issue: mismatch.issue });
    }

    for (const target of targets) {
      const { path, presetId, state } = target;
      if (state === "applied") {
        files.push({ path, presetId, state: "applied" });
        noOps.push(path);
        continue;
      }
      const original = readFileSync(path, "utf8");
      const rewrite = rewriteCompactionRowText(original, currentUrl);
      if (rewrite.issue !== undefined) {
        // Shape is recognizable at YAML level but not safe to edit at text
        // level: warn and leave it — stock/foreign engine keeps running.
        const warning = `[dsh-magic-context] preset patch skipped — ${path}: ${rewrite.issue}`;
        warnings.push(warning);
        warn(warning);
        files.push({ path, presetId, state: "contract-mismatch", issue: rewrite.issue });
        continue;
      }
      try {
        replaceFileAtomic(path, rewrite.patched);
        files.push({ path, presetId, state: "applied" });
        patched.push(path);
      } catch (error) {
        const warning = `[dsh-magic-context] preset patch failed — ${path}: ${(error as Error).message}`;
        warnings.push(warning);
        warn(warning);
        files.push({ path, presetId, state, issue: (error as Error).message });
      }
    }
  }

  return {
    agentPresetsDir: dirs[0]!,
    files,
    patched,
    skipped: files.filter((file) => file.state === "contract-mismatch").map((file) => file.path),
    noOps,
    warnings,
  };
}

// ── legacy magic-standard cleanup ───────────────────────────────────────────

/**
 * Whether `$DSH_HOME/.agent-presets/magic-standard/` is verifiably MC-
 * generated (the thin preset): its agent.cordis.yml parses and carries either
 * the `magic-include-standard` include row or a row naming this package's
 * `dist/entries/*` files. Only such directories are deleted at boot; anything
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
 * MC-generated. Returns the outcome for doctor/telemetry; boot heal warns on
 * any unexpected error via its caller's catch.
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
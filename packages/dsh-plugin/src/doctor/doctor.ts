/**
 * doctor/doctor — `dsh-magic-context doctor` (ADR 0001 model).
 *
 * Strictly DIAGNOSTICS-ONLY: the boot-time self-heal in the host entry owns
 * every write; doctor never mutates a file. Checklist:
 *   1. DSH version vs the compatibility expectation (exact rc 0.1.5-rc.2);
 *   2. bundle install state (profile package.json `dsh.profile.bundles`);
 *   3. shipped-preset patch state per preset file (applied / stock /
 *      contract-mismatch / MC-path-rotted — read-only scan of the resolved
 *      `@deepseek-ai/dsh-agent-presets` package) + legacy magic-standard
 *      detection;
 *   4. shared DB: storage dir location + openDatabaseAsync result
 *      classification (schema fence / migration guard / fatal) + liveness
 *      marker scan;
 *   5. config loading (loadPluginConfigDetailed loadOutcome classification).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveCortexKitUserConfigPath } from "@magic-context/core/config/migrate-config-location";
import { readJsoncFile } from "@magic-context/core/shared/jsonc-parser";
import { loadPluginConfigDetailed } from "@magic-context/core/config";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";
import {
  LATEST_SUPPORTED_VERSION,
  getMigrationOnOpenRefusal,
  getPersistedSchemaVersion,
  getSchemaFenceRejection,
  openDatabaseAsync,
} from "@magic-context/core/features/magic-context/storage-db";
import type { Database } from "@magic-context/core/shared/sqlite";
import type { RpcPortFileRecord } from "../compat/dsh-0.1/liveness";
import { describeError } from "@magic-context/core/shared/error-message";
import {
  AGENT_PRESETS_PACKAGE,
  currentCompactionEntryUrl,
  detectLegacyMagicStandard,
  resolveAgentPresetsDir,
  scanPresetPatchStates,
} from "../host/preset-patch";
import {
  DSH_COMPAT_EXPECTED_VERSION,
  DSH_PACKAGE,
  formatDetail,
  LEGACY_MAGIC_CONTEXT_PACKAGE,
  MAGIC_CONTEXT_PACKAGE,
  locateDshInstall,
  parseFlags,
  resolveDshHome,
  stringFlag,
} from "./env";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** Human fix guidance for warn/fail items. */
  readonly fix?: string;
}

export interface DoctorReport {
  readonly exitCode: number;
  readonly checks: readonly DoctorCheck[];
}

export interface DshDoctorOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly dshHome?: string;
  readonly dshInstallDir?: string;
  readonly stockPresetPath?: string;
  /** Workspace directory (project config + liveness project scope). */
  readonly directory?: string;
  /** Restrict the bundle check to one profile name. */
  readonly profile?: string;
  /** Agent-presets package dir override (tests / `--agent-presets`). */
  readonly agentPresetsDir?: string;
  /** Storage dir override (tests). */
  readonly storageDirOverride?: string;
  /** Shared DB path override (tests). */
  readonly dbPathOverride?: string;
}

export interface DbOpenOutcome {
  readonly kind: "ok" | "schema-fence" | "migration-guard" | "fatal";
  readonly db?: Database;
  readonly schemaVersion?: number;
  readonly latestSupported?: number;
  readonly detail?: unknown;
}

/**
 * Classify the result of opening the shared DB the way the host bootstrap does
 * (openDatabaseAsync). `null` means the core refused: the recorded
 * schema-fence rejection wins, then the migration-on-open refusal, then a
 * generic guard refusal. A throw is a fatal open error.
 */
export async function classifyDatabaseOpen(
  dbPath: string,
): Promise<DbOpenOutcome> {
  try {
    const db = await openDatabaseAsync({ dbPath });
    if (db === null) {
      const fence = getSchemaFenceRejection();
      if (fence !== null) return { kind: "schema-fence", detail: fence };
      const guard = getMigrationOnOpenRefusal();
      if (guard !== null) return { kind: "migration-guard", detail: guard };
      return {
        kind: "migration-guard",
        detail: "open returned null without a recorded reason",
      };
    }
    return {
      kind: "ok",
      db,
      schemaVersion: getPersistedSchemaVersion(db),
      latestSupported: LATEST_SUPPORTED_VERSION,
    };
  } catch (error) {
    return { kind: "fatal", detail: describeError(error).brief };
  }
}

export interface LivenessMarkerEntry {
  readonly path: string;
  readonly pid: number;
  readonly live: boolean;
  readonly port: number;
}

export interface LivenessMarkerScan {
  readonly markers: readonly LivenessMarkerEntry[];
  readonly liveCount: number;
}

/** Scan `<storageDir>/rpc/<projectHash>/port-<pid>.json` markers. */
export function scanLivenessMarkers(storageDir: string): LivenessMarkerScan {
  const rpcRoot = join(storageDir, "rpc");
  if (!existsSync(rpcRoot)) return { markers: [], liveCount: 0 };
  const markers: LivenessMarkerEntry[] = [];
  let projectDirs: string[] = [];
  try {
    projectDirs = readdirSync(rpcRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return { markers: [], liveCount: 0 };
  }
  for (const projectDir of projectDirs) {
    const dirPath = join(rpcRoot, projectDir);
    let files: string[] = [];
    try {
      files = readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.startsWith("port-") || !file.endsWith(".json")) continue;
      const path = join(dirPath, file);
      try {
        const record = JSON.parse(readFileSync(path, "utf8")) as RpcPortFileRecord;
        markers.push({
          path,
          pid: record.pid,
          live: pidAlive(record.pid),
          port: record.port,
        });
      } catch {
        markers.push({ path, pid: NaN, live: false, port: 0 });
      }
    }
  }
  return { markers, liveCount: markers.filter((marker) => marker.live).length };
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Profile package.json facts used by the bundle-install check. */
export interface ProfileBundleFacts {
  readonly name: string;
  readonly packageJsonPath: string;
  readonly packageJsonExists: boolean;
  readonly bundles: readonly string[];
  readonly bundleInstalled: boolean;
  readonly nodeModulesPackageExists: boolean;
}

/** Read the bundle facts for one profile directory. */
export function profileBundleFacts(
  dshHome: string,
  profileName: string,
): ProfileBundleFacts {
  const packageJsonPath = join(dshHome, "profiles", profileName, "package.json");
  const packageJsonExists = existsSync(packageJsonPath);
  let bundles: string[] = [];
  if (packageJsonExists) {
    const parsed = readJsoncFile<{
      dsh?: { profile?: { bundles?: unknown } };
    }>(packageJsonPath);
    const raw = parsed?.dsh?.profile?.bundles;
    if (Array.isArray(raw)) bundles = raw.map(String);
  }
  const bundleInstalled =
    bundles.includes(MAGIC_CONTEXT_PACKAGE) ||
    bundles.includes(LEGACY_MAGIC_CONTEXT_PACKAGE);
  const nodeModulesPackageExists =
    existsSync(join(dshHome, "profiles", profileName, "node_modules", MAGIC_CONTEXT_PACKAGE)) ||
    existsSync(
      join(dshHome, "profiles", profileName, "node_modules", LEGACY_MAGIC_CONTEXT_PACKAGE),
    );
  return {
    name: profileName,
    packageJsonPath,
    packageJsonExists,
    bundles,
    bundleInstalled,
    nodeModulesPackageExists,
  };
}

/** List profile names under `$DSH_HOME/profiles`. */
export function listProfiles(dshHome: string): string[] {
  const profilesRoot = join(dshHome, "profiles");
  if (!existsSync(profilesRoot)) return [];
  try {
    return readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function runDshDoctor(
  argv: readonly string[],
  options: DshDoctorOptions = {},
): Promise<DoctorReport> {
  const { flags } = parseFlags(argv);
  const env = options.env ?? process.env;
  const dshHome = options.dshHome ?? stringFlag(flags, "dsh-home") ?? resolveDshHome(env);
  const dshInstallDir = options.dshInstallDir ?? stringFlag(flags, "dsh-install");
  const stockPresetPath = options.stockPresetPath ?? stringFlag(flags, "stock-preset");
  const directory = options.directory ?? stringFlag(flags, "directory") ?? process.cwd();
  const profileFilter = options.profile ?? stringFlag(flags, "profile");

  const checks: DoctorCheck[] = [];
  const located = locateDshInstall({ dshHome, dshInstallDir, stockPresetPath, env });

  // 1. DSH version vs the compatibility expectation.
  if (located.dshInstallDir === undefined) {
    checks.push({
      id: "dsh-version",
      title: "DSH version",
      status: "fail",
      detail:
        `Could not locate the DSH install (expected ${DSH_COMPAT_EXPECTED_VERSION}). Probed:\n` +
        located.tried.map((candidate) => `  - ${candidate}`).join("\n"),
      fix: `Install DSH ${DSH_COMPAT_EXPECTED_VERSION} or pass --dsh-install <dir>.`,
    });
  } else {
    const manifestPath = join(located.dshInstallDir, "package.json");
    let installedVersion: string | undefined;
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
      if (typeof parsed.version === "string") installedVersion = parsed.version;
    } catch (error) {
      checks.push({
        id: "dsh-version",
        title: "DSH version",
        status: "fail",
        detail: `${manifestPath}: ${describeError(error).brief}`,
        fix: `Reinstall DSH ${DSH_COMPAT_EXPECTED_VERSION}.`,
      });
      installedVersion = undefined;
    }
    if (installedVersion !== undefined) {
      if (installedVersion === DSH_COMPAT_EXPECTED_VERSION) {
        checks.push({
          id: "dsh-version",
          title: "DSH version",
          status: "ok",
          detail: `${located.dshInstallDir} → ${installedVersion} (matches the compat contract ${DSH_COMPAT_EXPECTED_VERSION}).`,
        });
      } else {
        checks.push({
          id: "dsh-version",
          title: "DSH version",
          status: "fail",
          detail:
            `installed ${installedVersion} at ${located.dshInstallDir}; the adapter pins ` +
            `exact-rc ${DSH_COMPAT_EXPECTED_VERSION} (compat/dsh-0.1).`,
          fix: `Install the exact release: ${DSH_PACKAGE}@${DSH_COMPAT_EXPECTED_VERSION}.`,
        });
      }
    }
  }

  // 2. Bundle install state (per profile).
  const profiles = profileFilter !== undefined
    ? [profileFilter]
    : listProfiles(dshHome);
  if (profiles.length === 0) {
    checks.push({
      id: "bundle-install",
      title: "Bundle install state",
      status: "warn",
      detail: `no profiles found under ${join(dshHome, "profiles")}.`,
      fix: `Create a profile first (e.g. dsh --profile web), then add ${MAGIC_CONTEXT_PACKAGE}.`,
    });
  } else {
    let installedCount = 0;
    for (const profileName of profiles) {
      const facts = profileBundleFacts(dshHome, profileName);
      if (facts.bundleInstalled) installedCount += 1;
      const status: CheckStatus = !facts.packageJsonExists
        ? "warn"
        : facts.bundleInstalled
          ? "ok"
          : "fail";
      checks.push({
        id: `bundle-install.${profileName}`,
        title: `Bundle install state — profile ${profileName}`,
        status,
        detail: facts.bundleInstalled
          ? `${MAGIC_CONTEXT_PACKAGE} is in dsh.profile.bundles` +
            (facts.nodeModulesPackageExists ? " and resolvable in node_modules." : " but NOT resolvable in node_modules.")
          : `${MAGIC_CONTEXT_PACKAGE} is missing from dsh.profile.bundles` +
            (facts.packageJsonExists
              ? ` (current bundles: ${facts.bundles.join(", ") || "none"}).`
              : ` (${facts.packageJsonPath} missing).`),
        fix: `dsh plugin --profile ${profileName} add ${MAGIC_CONTEXT_PACKAGE} (or edit the profile package.json dsh.profile.bundles manually).`,
      });
    }
    if (installedCount === 0 && profiles.length > 0) {
      checks.push({
        id: "bundle-install",
        title: "Bundle install state (summary)",
        status: "fail",
        detail: `${MAGIC_CONTEXT_PACKAGE} is not installed in any profile.`,
        fix: `dsh plugin --profile <name> add ${MAGIC_CONTEXT_PACKAGE}`,
      });
    }
  }

  // 3. Shipped-preset patch state (ADR 0001) + legacy magic-standard.
  const agentPresetsDir =
    options.agentPresetsDir ??
    stringFlag(flags, "agent-presets") ??
    resolveAgentPresetsDir();
  if (agentPresetsDir === undefined) {
    checks.push({
      id: "preset-patch",
      title: "Shipped-preset patch state",
      status: "warn",
      detail:
        `Could not resolve ${AGENT_PRESETS_PACKAGE} from this module's context ` +
        `(the profile node_modules that holds this package), so no shipped ` +
        `preset is patched yet.`,
      fix: "Verify the bundle is installed into the profile; the boot-time self-heal patches the shipped presets on the next host start.",
    });
  } else {
    // Read-only scan: doctor never writes — the boot self-heal does.
    const scan = scanPresetPatchStates({ agentPresetsDir, warn: () => {} });
    const currentUrl = currentCompactionEntryUrl();
    if (scan.files.length === 0) {
      checks.push({
        id: "preset-patch",
        title: "Shipped-preset patch state",
        status: "ok",
        detail:
          `${join(agentPresetsDir, "presets")}: no shipped preset carries a ` +
          `compaction-basic row (nothing to patch).`,
      });
    } else {
      for (const file of scan.files) {
        const status: CheckStatus =
          file.state === "applied" || file.state === "stock"
            ? "ok"
            : file.state === "contract-mismatch"
              ? "warn"
              : "fail";
        const detailByState: Record<string, string> = {
          applied: `patched: compaction-basic now mounts ${currentUrl} with config { auto: true }.`,
          stock: `stock engine; the boot-time self-heal patches it when the host mounts.`,
          "contract-mismatch": `${file.issue}. Stock compaction keeps running; the rest of Magic Context is unaffected.`,
          "mc-path-rotted": `${file.issue} — the preset mounts a stale entry path.`,
        };
        checks.push({
          id: `preset-patch.${file.presetId}`,
          title: `Shipped-preset patch state — ${file.presetId}`,
          status,
          detail: `${file.path}: ${detailByState[file.state] ?? file.state}.`,
          fix: status === "ok"
            ? undefined
            : status === "fail"
              ? "Restart the host so the boot self-heal rewrites the current entry URL (or reinstall the bundle)."
              : "Check the composition against the expected compaction-group shape.",
        });
      }
    }
  }

  // 3b. Legacy magic-standard cleanup state (diagnostics only).
  const legacy = detectLegacyMagicStandard(dshHome);
  if (legacy.state === "absent") {
    checks.push({
      id: "legacy-preset",
      title: "Legacy magic-standard preset",
      status: "ok",
      detail: `${legacy.dir}: absent.`,
    });
  } else if (legacy.state === "present") {
    checks.push({
      id: "legacy-preset",
      title: "Legacy magic-standard preset",
      status: "warn",
      detail:
        `${legacy.dir} is verifiably a Magic Context-generated thin preset; ` +
        `the boot-time self-heal deletes it on the next host start.`,
    });
  } else {
    checks.push({
      id: "legacy-preset",
      title: "Legacy magic-standard preset",
      status: "warn",
      detail:
        `${legacy.dir} exists but is NOT verifiably Magic Context-generated ` +
        `(${legacy.reason}); left alone.`,
    });
  }

  // 4. Shared DB.
  const storageDir = options.storageDirOverride ?? getMagicContextStorageDir();
  const dbPath = options.dbPathOverride ?? join(storageDir, "context.db");
  if (!existsSync(dbPath)) {
    checks.push({
      id: "shared-db",
      title: "Shared DB",
      status: "warn",
      detail: `${dbPath} does not exist yet (storage dir: ${storageDir}).`,
      fix: "Start a session or run `dsh-magic-context setup`, then re-run doctor.",
    });
  } else {
    const outcome = await classifyDatabaseOpen(dbPath);
    switch (outcome.kind) {
      case "ok": {
        outcome.db?.close();
        checks.push({
          id: "shared-db",
          title: "Shared DB",
          status: "ok",
          detail:
            `${dbPath}: opened; schema v${outcome.schemaVersion} (adapter supports ` +
            `up to v${outcome.latestSupported}).`,
        });
        break;
      }
      case "schema-fence":
        checks.push({
          id: "shared-db",
          title: "Shared DB",
          status: "fail",
          detail:
            `${dbPath}: schema fence refused the open — the persisted schema is ` +
            `newer than this adapter supports. ${formatDetail(outcome.detail)}`,
          fix: "Update Magic Context / the DSH adapter to a build that supports the newer schema.",
        });
        break;
      case "migration-guard":
        checks.push({
          id: "shared-db",
          title: "Shared DB",
          status: "fail",
          detail:
            `${dbPath}: the migration-on-open guard refused the open — another ` +
            `harness process may still be running against this database. ${formatDetail(outcome.detail)}`,
          fix: "Close every OpenCode / Pi / DSH process that may hold the DB, then re-run doctor.",
        });
        break;
      case "fatal":
        checks.push({
          id: "shared-db",
          title: "Shared DB",
          status: "fail",
          detail: `${dbPath}: ${String(outcome.detail ?? "unknown open error")}`,
          fix: "Repair or restore the database; see doctor repair guidance.",
        });
        break;
    }
  }

  // 5. Liveness markers (explains a migration-guard refusal).
  const markerScan = scanLivenessMarkers(storageDir);
  if (markerScan.liveCount === 0) {
    checks.push({
      id: "liveness-markers",
      title: "Liveness markers",
      status: "ok",
      detail:
        markerScan.markers.length === 0
          ? `${join(storageDir, "rpc")}: no DSH liveness markers.`
          : `${markerScan.markers.length} marker(s) found, all from dead processes (stale, harmless).`,
    });
  } else {
    checks.push({
      id: "liveness-markers",
      title: "Liveness markers",
      status: "warn",
      detail:
        `${markerScan.liveCount} live DSH liveness marker(s) under ${join(storageDir, "rpc")} — ` +
        `a running harness process may hold the migration guard.`,
      fix: "If no harness is actually running, remove the stale port-*.json marker files.",
    });
  }

  // 6. Config loading.
  const configPath = resolveCortexKitUserConfigPath();
  const loaded = loadPluginConfigDetailed(directory);
  const outcome = loaded.loadOutcome;
  const statusForOutcome: Record<string, CheckStatus> = {
    ok: "ok",
    "schema-recovery": "warn",
    "substitution-failure": "warn",
    "legacy-config-unmigrated": "warn",
    "project-file-parse-error": "fail",
    "project-file-io-error": "fail",
  };
  const configStatus: CheckStatus = !existsSync(configPath)
    ? "warn"
    : (statusForOutcome[outcome] ?? "warn");
  checks.push({
    id: "config-load",
    title: "Config loading",
    status: configStatus,
    detail:
      `${existsSync(configPath) ? configPath : "no user config (defaults apply)"} ` +
      `→ loadOutcome=${outcome} (user: ${loaded.sources.userConfig}, project: ${loaded.sources.projectConfig})` +
      (loaded.config.configWarnings?.length
        ? `; warnings: ${loaded.config.configWarnings.join(" | ")}`
        : ""),
    fix: configStatus === "ok"
      ? undefined
      : configStatus === "fail"
        ? "Fix the config file parse error, then re-run doctor."
        : "Review the config warnings; run `dsh-magic-context setup` to bootstrap a user config.",
  });

  return {
    exitCode: checks.some((check) => check.status === "fail") ? 1 : 0,
    checks,
  };
}

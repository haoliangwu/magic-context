/**
 * doctor/setup — `dsh-magic-context setup` (ADR 0001 model).
 *
 * Diagnostics alias of doctor — PURE REPORT, no writes: the boot-time
 * self-heal in the host entry owns every write (shipped-preset patch + legacy
 * magic-standard removal). Reports:
 *   1. every doctor check (DSH version, bundle install, shipped-preset patch
 *      state, legacy magic-standard, shared DB, config);
 *   2. a notice listing user-root presets (`~/.agent-presets/*`, excluding
 *      magic-standard) that reference the stock `dsh-compaction-basic` engine
 *      — informational only: user-root presets are NEVER touched by the patch.
 * Nothing here ever writes to disk.
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { resolveCortexKitUserConfigPath } from "@magic-context/core/config/migrate-config-location";
import { runDshDoctor, type DshDoctorOptions } from "./doctor";
import { listUserRootPresetsReferencingCompactionBasic } from "../host/preset-patch";
import { parseFlags, resolveDshHome, stringFlag } from "./env";

export type SetupStepStatus = "ok" | "warn" | "fail";

export interface SetupStep {
  readonly status: SetupStepStatus;
  readonly title: string;
  readonly detail: string;
}

export interface SetupReport {
  readonly exitCode: number;
  readonly steps: readonly SetupStep[];
  /** Pure-report mode: nothing is ever written. */
  readonly generatedFiles: readonly string[];
  readonly nextSteps: readonly string[];
}

export interface DshSetupOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** DSH home override (tests / `--dsh-home`). */
  readonly dshHome?: string;
  /** DSH install override (tests / `--dsh-install`). */
  readonly dshInstallDir?: string;
  /** Stock preset override (tests / `--stock-preset`). */
  readonly stockPresetPath?: string;
  /** Agent-presets package dir override (tests / `--agent-presets`). */
  readonly agentPresetsDir?: string;
  /** Profile name for the next-steps hint. */
  readonly profile?: string;
  /** Workspace directory (project config + liveness scope; forwarded to doctor). */
  readonly directory?: string;
  /** Accepted for backward CLI compatibility; reports never write regardless. */
  readonly dryRun?: boolean;
}

export async function runDshSetup(
  argv: readonly string[],
  options: DshSetupOptions = {},
): Promise<SetupReport> {
  const doctor = await runDshDoctor(
    argv,
    options as unknown as DshDoctorOptions,
  );

  const steps: SetupStep[] = doctor.checks.map((check) => ({
    status: check.status,
    title: check.title,
    detail: check.fix !== undefined
      ? `${check.detail}\nfix: ${check.fix}`
      : check.detail,
  }));

  // Informational notice: user-root presets that would keep using the stock
  // compaction engine even after the shipped-preset patch (never touched).
  const { flags } = parseFlags(argv);
  const env = options.env ?? process.env;
  const dshHome = options.dshHome ?? stringFlag(flags, "dsh-home") ?? resolveDshHome(env);
  const userRootPresets = listUserRootPresetsReferencingCompactionBasic(dshHome);
  steps.push({
    status: "ok",
    title: "User-root presets referencing dsh-compaction-basic (informational)",
    detail:
      userRootPresets.length === 0
        ? `${join(dshHome, ".agent-presets")}: no user-root presets reference the stock compaction engine.`
        : `These user-root presets still mount the stock engine and are NOT patched (user root is never touched):\n` +
          userRootPresets.map((id) => `  - ${id}`).join("\n"),
  });

  // Config bootstrap is gone (boot heal owns all writes): report only.
  const configPath = resolveCortexKitUserConfigPath();
  steps.push({
    status: existsSync(configPath) ? "ok" : "warn",
    title: "Magic Context user config",
    detail: existsSync(configPath)
      ? `${configPath} exists; defaults apply for missing keys.`
      : `${configPath} does not exist; defaults apply (setup no longer writes — boot heal owns all writes).`,
  });

  const nextSteps: string[] = [
    "No manual setup step: the host entry self-heals the shipped presets on every boot (ADR 0001).",
  ];
  if (doctor.exitCode !== 0) {
    nextSteps.push(
      "Fix the failing checks above, then restart the host so the boot-time self-heal runs.",
    );
  } else {
    nextSteps.push("Verify with: dsh-magic-context doctor");
  }

  return {
    exitCode: doctor.exitCode,
    steps,
    generatedFiles: [],
    nextSteps,
  };
}

// ── preserved YAML helpers (loader dialect, used by tests) ─────────────────

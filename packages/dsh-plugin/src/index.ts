/**
 * Host half of dsh-magic-context (Phase 1 boundary).
 *
 * The bundle patch (cordis.patch.yml) mounts this row on the HOST plane:
 *   - id: magic-host
 *     name: 'dsh-magic-context'
 *     inject: []
 *
 * It boots the shared Magic SQLite store (with the DSH liveness marker), then
 * provides `ctx.magicContextHost` — the single host service the agent plane
 * and the Typert Remote consume. Full tool/command/dreamer registration lands
 * in Phase 2; this entry pins the boot contract and the service identity.
 */
import type { Context } from "@deepseek-ai/cordis";
import {
  bootstrapDshStorage,
  type DshStorageBootstrap,
} from "./host/bootstrap";
import {
  patchShippedPresets,
  removeLegacyMagicStandard,
} from "./host/preset-patch";
import { resolveDshHome } from "./doctor/env";
import { canonicalSessionKey, parseDshSessionKey } from "./shared/dsh-harness";

/** Cordis plugin name (loader diagnostics). */
export const name = "magic-context-dsh";

/** Host plugin configuration. */
export interface MagicHostConfig {
  /** Workspace/directory identity for config migration + liveness marker. */
  directory?: string;
  /** Loopback port for the liveness marker (0 in headless runs). */
  port?: number;
  /** SHA-256 first-8-hex of the DSH home for canonical session keys. */
  homeHash?: string;
}

/** The host service the adapter's planes consume. */
export interface MagicContextHostService {
  /** Settles once the storage bootstrap finishes (ok or refused). */
  readonly ready: Promise<DshStorageBootstrap>;
  /**
   * Workspace/directory identity (config migration, liveness marker, and
   * host-plane config resolution — e.g. the sidebar execute threshold).
   */
  readonly directory: string;
  /** Canonical Magic session key for a DSH session. */
  canonicalKey(dshSessionId: string): string;
  /** Parse a canonical key back to the DSH-native session id. */
  parseKey(key: string): { homeHash: string; dshSessionId: string } | undefined;
  /**
   * Register the Magic compaction summarize hook. The agent plane registers it
   * at apply time; the compaction entry bundle reads it through the host
   * service (cross-bundle singleton — a module-level registry would be
   * duplicated per bundle).
   */
  registerSummarizeHook(hook: MagicSummarizeHook): void;
  /** The registered hook, if any (compaction engine bundle reads this). */
  summarizeHook(): MagicSummarizeHook | undefined;
}

/**
 * The compaction summarize hook contract (structural view — the pinned
 * SummarizationInput/SummaryResult types live in compat/dsh-0.1/compaction).
 */
export type MagicSummarizeHook = (
  input: unknown,
  agent: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Register the host service on `ctx` (idempotent per fiber). */
export function apply(ctx: Context, config: MagicHostConfig = {}): void {
  // Boot-time self-heal (ADR 0001): OWNER of all writes. Runs synchronously
  // before any session can mount an unpatched preset — compaction cannot be
  // replaced from the host plane, so the shipped presets are patched in place
  // (tmp+rename atomic). Fail-open: any unexpected error is one warning line
  // and never breaks boot.
  try {
    // Anchor enrichment: the live roster instance knows the agent-presets
    // copy THIS composition actually loaded (its `resolvedRoots` system entry
    // is the shipped preset root, resolved from the roster module's real
    // location). Our own `require.resolve` anchor is realpathed to this
    // package's install (the repo under a dev symlink), which can differ from
    // the composition's copy — pass both, the patcher verifies and dedups.
    let roster: unknown;
    try {
      roster = ctx.get("agentPresets");
    } catch {
      roster = undefined; // service not registered in this composition
    }
    const heal = patchShippedPresets({ roster, baseUrl: ctx.baseUrl });
    for (const file of heal.patched) {
      ctx.logger?.info?.(`[dsh-magic-context] shipped preset patched: ${file}`);
    }
    if (heal.files.length === 0) {
      ctx.logger?.info?.(
        "[dsh-magic-context] no shipped presets carry compaction-basic; patch skipped",
      );
    }
    const legacy = removeLegacyMagicStandard(resolveDshHome());
    if (legacy.removed) {
      ctx.logger?.info?.("[dsh-magic-context] legacy magic-standard preset removed");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.logger?.warn?.(
      `[dsh-magic-context] boot self-heal failed (continuing): ${message}`,
    );
  }
  const directory = config.directory ?? process.cwd();
  const homeHash = config.homeHash ?? defaultHomeHash();
  const ready = bootstrapDshStorage({
    directory,
    port: config.port ?? 0,
    homeHash,
    log: (message) => ctx.logger?.info?.(message),
  });
  let summarizeHook: MagicSummarizeHook | undefined;
  const host: MagicContextHostService = {
    ready,
    directory,
    canonicalKey(dshSessionId: string): string {
      return canonicalSessionKey(homeHash, dshSessionId);
    },
    parseKey(key: string) {
      return parseDshSessionKey(key);
    },
    registerSummarizeHook(hook: MagicSummarizeHook): void {
      summarizeHook = hook;
    },
    summarizeHook(): MagicSummarizeHook | undefined {
      return summarizeHook;
    },
  };
  ctx.provide("magicContextHost", host);
  // The `magicContext` Typert Remote is registered by the dedicated
  // `/remote` bundle row (`dsh-magic-context/remote`), NOT here —
  // the loader mounts both rows, so registering in both double-provides
  // `magicContextRemote` and fails the tree.
}

/** Deterministic home hash (first 8 hex of sha256 of the DSH home path). */
export function defaultHomeHash(): string {
  const home = process.env.DSH_HOME ?? requireHome();
  return hash8(home);
}

function requireHome(): string {
  // Fall back to the OS home; DSH always sets DSH_HOME in launched profiles.
  return process.env.HOME ?? process.env.USERPROFILE ?? "unknown-home";
}

function hash8(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

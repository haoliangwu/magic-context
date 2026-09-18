/**
 * entries/preset-include — no-write file-backed loader tree for SHIPPED
 * compositions (the stock `standard` preset the thin preset includes).
 *
 * WHY: the loader's dispose handler writes a tree back to its source file
 * whenever it decides the config changed — a plugin self-disposing is enough,
 * and tearing an agent down disposes its whole subtree. The raw
 * `@deepseek-ai/cordis-plugin-include` tree inherits that write, so including
 * the SHIPPED stock composition through it truncates the stock file to `[]`
 * the first time a session ends. `@deepseek-ai/dsh-agent-presets` documents
 * exactly this hazard and defends against it with `PresetTree.write() = no-op`
 * ("A preset is an input, never a persistence target"); this entry is the same
 * defense for the thin preset's include row. The shipped composition is
 * read-only input; user state lives elsewhere, so dropping the write also
 * drops nothing that a session could persist.
 *
 * The row's `name` must be this entry's absolute file path (the thin preset
 * emits it via `magicEntryPath("preset-include")`) so the loader resolves the
 * class from THIS package instead of the stock directory's module walk.
 *
 * Mount-time heal: `setup` bakes the stock preset's absolute install path
 * into the thin preset's `config.path`. pnpm global updates rotate that
 * hash-addressed install directory, rotting the baked path and failing the
 * mount ("magic-standard preset cannot mount"). When the baked target is
 * missing AND the path matches a stock preset layout, re-locate the live
 * install through the same anchors `setup` uses (profile closures,
 * per-profile node_modules, PATH walk-up) and include THAT copy — a stale
 * thin preset heals itself on every mount, so a global store update can no
 * longer break session creation.
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Include } from "@deepseek-ai/cordis-plugin-include";
import {
  locateDshInstall,
  resolveDshHome,
  STOCK_PRESET_REL,
  STOCK_PRESET_REL_V2,
} from "../doctor/env";

/** Path suffixes identifying a baked stock-preset include target. */
const STOCK_PRESET_SUFFIXES = [STOCK_PRESET_REL_V2, STOCK_PRESET_REL];

type IncludeConfig = ConstructorParameters<typeof Include>[1];
type IncludeContext = ConstructorParameters<typeof Include>[0];

export interface HealedIncludeConfig {
  readonly config: IncludeConfig;
  /** Previous path when the stock-preset target was re-located (diagnostics). */
  readonly healedFrom?: string;
}

/** Filesystem path of an absolute or file:// include target, else undefined. */
function includeTargetFsPath(raw: string): string | undefined {
  if (raw.startsWith("file://")) {
    try {
      return fileURLToPath(raw);
    } catch {
      return undefined;
    }
  }
  return raw.startsWith("/") ? raw : undefined;
}

/**
 * Re-locate a rotted stock-preset include target.
 *
 * Healthy targets pass through untouched (zero behavior change); relative
 * paths, non-stock paths, and unresolvable installs return unchanged so
 * `Include` surfaces its own diagnostics for genuine user errors.
 */
export function healStaleStockPresetPath(
  config: IncludeConfig,
  env: NodeJS.ProcessEnv = process.env,
): HealedIncludeConfig {
  if (typeof config.path !== "string") return { config };
  const target = includeTargetFsPath(config.path);
  if (target === undefined || existsSync(target)) return { config };
  if (!STOCK_PRESET_SUFFIXES.some((suffix) => target.endsWith(suffix))) {
    return { config };
  }
  const located = locateDshInstall({ dshHome: resolveDshHome(env), env });
  if (located.stockPresetPath === undefined) return { config };
  return {
    config: { ...config, path: pathToFileURL(located.stockPresetPath).href },
    healedFrom: config.path,
  };
}

export default class MagicPresetInclude extends Include {
  /** A shipped composition is an input, never a persistence target. */
  write(): void {
    // Intentionally empty: never rewrite the included stock file.
  }

  constructor(ctx: IncludeContext, config: IncludeConfig) {
    const healed = healStaleStockPresetPath(config);
    if (healed.healedFrom !== undefined) {
      // One line per mount: enough to attribute the heal in host logs.
      console.warn(
        `[dsh-magic-context] stock preset path no longer exists (${healed.healedFrom}); ` +
          `re-located to ${healed.config.path}`,
      );
    }
    super(ctx, healed.config);
  }
}

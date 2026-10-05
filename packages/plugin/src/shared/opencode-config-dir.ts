import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { OpenCodeConfigDirOptions, OpenCodeConfigPaths } from "./opencode-config-dir-types";

export type {
    OpenCodeBinaryType,
    OpenCodeConfigDirOptions,
    OpenCodeConfigPaths,
} from "./opencode-config-dir-types";

/**
 * The user's home directory, preferring `$HOME` over the cached value.
 *
 * `os.homedir()` reads `$HOME` once when the process starts and never again,
 * so a test (or a wrapper) that sets `HOME` afterwards would otherwise be
 * silently ignored and we would read the developer's real config. `$HOME` is
 * normally unset on Windows, where the cached value is the right answer.
 */
function resolveHomeDir(): string {
    return process.env.HOME?.trim() || homedir();
}

/**
 * OpenCode's GLOBAL config directory: `$XDG_CONFIG_HOME/opencode`, falling
 * back to `~/.config/opencode` (on every platform, Windows included — OpenCode
 * does not use %APPDATA%).
 *
 * This helper names the loader's XDG layer, not every OpenCode surface called
 * "config". In 1.18.30, `Global.Path.config` is the pure-XDG path
 * (`packages/core/src/global.ts:13`) and the loader merges it once at
 * `packages/opencode/src/config/config.ts:412-413`. Its later directories loop
 * accepts only `.opencode` paths or the exact `OPENCODE_CONFIG_DIR` value
 * (`config.ts:437-441`), so the XDG layer is skipped there and the env path is
 * merged last. The detector mirrors that loader order via
 * {@link getOpenCodeConfigDirs}.
 *
 * Service consumers see a different value: `Global.make()` injects
 * `Flag.OPENCODE_CONFIG_DIR ?? Path.config` as `config`
 * (`packages/core/src/global.ts:64`), so setting the env var replaces the
 * service's value even though the loader still merges the XDG layer.
 */
export function getOpenCodeGlobalConfigDir(): string {
    if (process.platform === "win32") {
        return join(resolveHomeDir(), ".config", "opencode");
    }

    return join(process.env.XDG_CONFIG_HOME || join(resolveHomeDir(), ".config"), "opencode");
}

function getEnvConfigDir(): string | undefined {
    const envConfigDir = process.env.OPENCODE_CONFIG_DIR?.trim();
    return envConfigDir ? resolve(envConfigDir) : undefined;
}

function getCliConfigDir(): string {
    return getEnvConfigDir() ?? getOpenCodeGlobalConfigDir();
}

/**
 * The single directory Magic Context WRITES its OpenCode-side config into.
 *
 * `OPENCODE_CONFIG_DIR` wins here on purpose: among the directories OpenCode
 * reads it has the highest precedence, so a setting written there is the one
 * that takes effect. Do NOT use this to decide what OpenCode RESOLVED — for
 * that you must read every directory in {@link getOpenCodeConfigDirs}, because
 * a value the user set in the global directory is still live when
 * `OPENCODE_CONFIG_DIR` points somewhere that does not override it.
 */
export function getOpenCodeConfigDir(_options: OpenCodeConfigDirOptions): string {
    return getCliConfigDir();
}

export function getOpenCodeConfigPaths(options: OpenCodeConfigDirOptions): OpenCodeConfigPaths {
    const configDir = getOpenCodeConfigDir(options);
    return {
        configDir,
        configJson: join(configDir, "opencode.json"),
        configJsonc: join(configDir, "opencode.jsonc"),
        packageJson: join(configDir, "package.json"),
        omoConfig: join(configDir, "magic-context.jsonc"),
    };
}

/**
 * Every user-tier directory OpenCode reads config from, ordered from LOWEST to
 * HIGHEST precedence — later entries override earlier ones, which is the order
 * OpenCode merges them in.
 *
 * Verified against the opencode 1.18.30 binary (`ConfigPaths.directories` plus
 * the global loader in `Config.loadInstanceState`) and confirmed on a live host
 * with `opencode debug config`:
 *
 *   1. `$XDG_CONFIG_HOME/opencode` — always read, whatever the environment says
 *   2. `~/.opencode`               — always scanned, even outside a project
 *   3. `$OPENCODE_CONFIG_DIR`      — appended last, so it wins ties
 *
 * The important part is that entry 3 is an ADDITION, not a replacement. A
 * launcher that exports `OPENCODE_CONFIG_DIR` to a directory holding only
 * plugin scaffolding does not stop OpenCode from reading the user's real
 * config in entry 1 — so neither may we.
 *
 * Project-level directories are deliberately not included: they depend on the
 * working directory and are resolved by the caller that knows it.
 */
export function getOpenCodeConfigDirs(): string[] {
    const dirs = [getOpenCodeGlobalConfigDir(), join(resolveHomeDir(), ".opencode")];
    const envDir = getEnvConfigDir();
    if (envDir) dirs.push(envDir);
    return [...new Set(dirs)];
}

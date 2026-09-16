import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getPiAgentConfigDir } from "./paths";

export const PI_MAGIC_CONTEXT_PACKAGE_NAME = "@cortexkit/pi-magic-context";

function stripNpmPrefix(value: string): string {
    return value.startsWith("npm:") ? value.slice("npm:".length) : value;
}

function packageNameFromSpecifier(value: string): string {
    const normalized = stripNpmPrefix(value.trim());
    if (!normalized) return normalized;
    if (normalized.startsWith("@")) {
        const slash = normalized.indexOf("/");
        if (slash < 0) return normalized;
        const versionAt = normalized.indexOf("@", slash + 1);
        return versionAt > 0 ? normalized.slice(0, versionAt) : normalized;
    }
    const versionAt = normalized.indexOf("@");
    return versionAt > 0 ? normalized.slice(0, versionAt) : normalized;
}

export function getPiPackageEntryName(entry: unknown): string | null {
    if (typeof entry === "string") return packageNameFromSpecifier(entry);
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const object = entry as Record<string, unknown>;
        for (const key of ["name", "source"] as const) {
            const name = getPiPackageEntryName(object[key]);
            if (name) return name;
        }
    }
    return null;
}

export function isPiMagicContextPackageEntry(entry: unknown): boolean {
    if (typeof entry === "string") {
        return packageNameFromSpecifier(entry) === PI_MAGIC_CONTEXT_PACKAGE_NAME;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const object = entry as Record<string, unknown>;
        return (
            isPiMagicContextPackageEntry(object.name) || isPiMagicContextPackageEntry(object.source)
        );
    }
    return false;
}

export function getPiMagicContextPackageSpecifier(entry: unknown): string | null {
    if (typeof entry === "string") {
        return isPiMagicContextPackageEntry(entry) ? entry.trim() : null;
    }
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const object = entry as Record<string, unknown>;
        return (
            getPiMagicContextPackageSpecifier(object.source) ??
            getPiMagicContextPackageSpecifier(object.name)
        );
    }
    return null;
}

/**
 * True when Pi will load the magic-context plugin from packages[] by any
 * identity: the npm specifier or a local checkout. Every registration check
 * and every writer that adds the npm entry must use this, or a dev-path
 * install is "repaired" into a second registration and then reported as a
 * duplicate load.
 */
export function hasPiMagicContextPackage(
    entries: unknown[],
    agentDir: string = getPiAgentConfigDir(),
): boolean {
    return entries.some((entry) => isConfiguredPiMagicContextEntry(entry, agentDir));
}

/** True when the directory's package.json declares the magic-context Pi plugin. */
export function isPiMagicContextPackageDir(dir: string): boolean {
    const packageJson = join(dir, "package.json");
    if (!existsSync(packageJson)) return false;
    try {
        const pkg = JSON.parse(readFileSync(packageJson, "utf-8")) as { name?: unknown };
        return typeof pkg.name === "string" && pkg.name === PI_MAGIC_CONTEXT_PACKAGE_NAME;
    } catch {
        return false;
    }
}

/**
 * Resolve a non-npm packages[] entry (string or `{ source }`, absolute or relative
 * to the Pi agent directory) to a directory when that directory is a checkout of
 * the magic-context Pi plugin. Pi loads a local path and the npm package as two
 * distinct identities, so a local checkout counts as a registered plugin.
 */
export function localPiMagicContextPackageDir(entry: unknown, agentDir: string): string | null {
    const source =
        typeof entry === "string"
            ? entry
            : entry && typeof entry === "object" && "source" in entry
              ? entry.source
              : null;
    const spec = typeof source === "string" ? source.trim() : "";
    if (!spec || spec.startsWith("npm:")) return null;
    const path = spec.startsWith("file:") ? spec.slice("file:".length) : spec;
    const dir = isAbsolute(path) ? path : join(agentDir, path);
    return isPiMagicContextPackageDir(dir) ? dir : null;
}

/** Registered by npm specifier or by a local checkout of the plugin. */
export function isConfiguredPiMagicContextEntry(entry: unknown, agentDir: string): boolean {
    return (
        isPiMagicContextPackageEntry(entry) ||
        localPiMagicContextPackageDir(entry, agentDir) !== null
    );
}

export function describePiPackageEntry(entry: unknown): string {
    if (typeof entry === "string") return entry;
    const name = getPiPackageEntryName(entry);
    if (name) return name;
    try {
        return JSON.stringify(entry);
    } catch {
        return String(entry);
    }
}

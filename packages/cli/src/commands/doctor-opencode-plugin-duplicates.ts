/**
 * Doctor check for Magic Context being registered more than once in the
 * OpenCode config.
 *
 * OpenCode 2 loads the legacy `plugin` array and its native `plugins` array
 * together. Two entries for the same npm package with different specifiers
 * (for example `@latest` under `plugin` and `@0.42.6` or a bare package name
 * under `plugins`) are two separate installs to the host: it loads the first,
 * and the second fails with "Duplicate plugin ID: opencode-magic-context" and
 * shows up as a second, failed row in OpenCode's plugin list. OpenCode's own
 * `opencode plugin add` appends a bare entry under `plugins` without looking
 * at `plugin`, so this state is reachable without our CLI ever writing twice.
 *
 * The check reports every Magic Context entry across both keys. Under
 * `doctor --fix` it keeps exactly one npm entry, and it refuses to guess in
 * the two cases where removing an entry could lose something the user chose:
 * a local development checkout next to an npm entry, and two npm entries
 * carrying different options.
 */
import { isDeepStrictEqual } from "node:util";
import { isDevPathPluginEntry, matchesPluginEntry, pluginEntryPackage } from "../adapters/opencode";
import {
    OPENCODE_PLUGIN_ENTRY_WITH_VERSION,
    OPENCODE_PLUGIN_NAME,
} from "../lib/opencode-plugin-cache";
import {
    type OpenCodePluginConfigKey,
    readPluginEntries,
} from "../lib/opencode-plugin-registration";

export interface MagicContextPluginEntry {
    key: OpenCodePluginConfigKey;
    index: number;
    entry: unknown;
    /** Package reference as written, e.g. `@cortexkit/opencode-magic-context@latest`. */
    specifier: string;
    kind: "npm" | "dev-path";
    /** Options carried by a tuple (`[pkg, options]`) or object (`{ package, options }`) entry. */
    options: unknown;
}

export type PluginDuplicatePlan =
    | { action: "none"; entries: MagicContextPluginEntry[] }
    | {
          action: "leave";
          reason: "dev-path" | "conflicting-options";
          entries: MagicContextPluginEntry[];
      }
    | {
          action: "dedupe";
          entries: MagicContextPluginEntry[];
          keep: MagicContextPluginEntry;
          remove: MagicContextPluginEntry[];
          /**
           * The entry written in place of `keep`, when the kept entry had no
           * options and a removed entry did: the options move onto the kept
           * specifier so deduping never drops user configuration.
           */
          replacement?: unknown;
      };

function entryOptions(entry: unknown): unknown {
    if (Array.isArray(entry)) return entry[1];
    if (entry !== null && typeof entry === "object") {
        return (entry as { options?: unknown }).options;
    }
    return undefined;
}

function hasOptions(options: unknown): boolean {
    if (options === undefined || options === null) return false;
    if (typeof options === "object" && !Array.isArray(options)) {
        return Object.keys(options as Record<string, unknown>).length > 0;
    }
    return true;
}

/** Bare package name or `@latest`: the entries that follow new releases. */
function followsLatest(specifier: string): boolean {
    return specifier === OPENCODE_PLUGIN_NAME || specifier === OPENCODE_PLUGIN_ENTRY_WITH_VERSION;
}

/** Every Magic Context entry (npm or verified local checkout) across both plugin keys, in host load order. */
export function listMagicContextPluginEntries(
    config: Record<string, unknown>,
    /** Directory of the config file, which relative checkout paths resolve against. */
    configDir: string,
): MagicContextPluginEntry[] {
    const out: MagicContextPluginEntry[] = [];
    for (const { key, index, entry } of readPluginEntries(config)) {
        const specifier = pluginEntryPackage(entry);
        if (specifier === null) continue;
        let kind: MagicContextPluginEntry["kind"] | null = null;
        if (matchesPluginEntry(entry, OPENCODE_PLUGIN_NAME)) kind = "npm";
        else if (isDevPathPluginEntry(entry, configDir)) kind = "dev-path";
        if (kind === null) continue;
        out.push({ key, index, entry, specifier, kind, options: entryOptions(entry) });
    }
    return out;
}

/** Decide what `doctor --fix` would do with the Magic Context entries in a parsed config. */
export function planPluginDuplicates(
    config: Record<string, unknown>,
    configDir: string,
): PluginDuplicatePlan {
    const entries = listMagicContextPluginEntries(config, configDir);
    if (entries.length <= 1) return { action: "none", entries };

    if (entries.some((entry) => entry.kind === "dev-path")) {
        return { action: "leave", reason: "dev-path", entries };
    }

    const optionSets: unknown[] = [];
    for (const entry of entries) {
        if (!hasOptions(entry.options)) continue;
        if (!optionSets.some((seen) => isDeepStrictEqual(seen, entry.options))) {
            optionSets.push(entry.options);
        }
    }
    if (optionSets.length > 1) {
        return { action: "leave", reason: "conflicting-options", entries };
    }

    // Keep an entry that follows new releases when one exists. Among equals,
    // prefer the one already carrying the options, then the one the host loads
    // first (it is the copy currently active; later copies fail as duplicates).
    const rank = (entry: MagicContextPluginEntry): number =>
        (followsLatest(entry.specifier) ? 2 : 0) + (hasOptions(entry.options) ? 1 : 0);
    let keep = entries[0] as MagicContextPluginEntry;
    for (const entry of entries) {
        if (rank(entry) > rank(keep)) keep = entry;
    }
    const remove = entries.filter((entry) => entry !== keep);

    let replacement: unknown;
    const carried = optionSets[0];
    if (!hasOptions(keep.options) && carried !== undefined) {
        const donor = entries.find((entry) => isDeepStrictEqual(entry.options, carried));
        if (Array.isArray(donor?.entry)) {
            const tuple = [...(donor.entry as unknown[])];
            tuple[0] = keep.specifier;
            replacement = tuple;
        } else {
            replacement = { ...(donor?.entry as Record<string, unknown>), package: keep.specifier };
        }
    }

    return { action: "dedupe", entries, keep, remove, replacement };
}

/**
 * Apply a dedupe plan to the parsed config in place. The arrays are the
 * comment-json arrays the config was parsed into, so splicing them keeps the
 * comments attached to every surviving entry and to the rest of the file.
 */
export function applyPluginDuplicatePlan(
    config: Record<string, unknown>,
    plan: Extract<PluginDuplicatePlan, { action: "dedupe" }>,
): void {
    if (plan.replacement !== undefined) {
        const list = config[plan.keep.key] as unknown[];
        list[plan.keep.index] = plan.replacement;
    }
    // Remove from the highest index down so earlier indices stay valid.
    const removals = [...plan.remove].sort((a, b) =>
        a.key === b.key ? b.index - a.index : a.key.localeCompare(b.key),
    );
    for (const entry of removals) {
        (config[entry.key] as unknown[]).splice(entry.index, 1);
    }
}

export function describePluginEntry(entry: MagicContextPluginEntry): string {
    const suffix = hasOptions(entry.options) ? " (with options)" : "";
    const kind = entry.kind === "dev-path" ? "dev path " : "";
    return `${entry.key}[${entry.index}]: ${kind}${entry.specifier}${suffix}`;
}

export interface PluginDuplicateCheckReporter {
    warn(message: string): void;
    pass(message: string): void;
    info(message: string): void;
}

/**
 * Doctor step: report duplicate Magic Context registrations and, when `fix`
 * is set, remove the redundant npm entries from `config` in place. Returns
 * true when the config was changed and must be written back.
 */
export function checkPluginDuplicates(
    config: Record<string, unknown>,
    configName: string,
    options: {
        fix?: boolean;
        /** Directory of the config file, which relative checkout paths resolve against. */
        configDir: string;
    },
    report: PluginDuplicateCheckReporter,
): boolean {
    const plan = planPluginDuplicates(config, options.configDir);
    if (plan.action === "none") return false;

    report.warn(
        `Magic Context is registered ${plan.entries.length} times in ${configName}; OpenCode loads the first and fails the rest as duplicates`,
    );
    for (const entry of plan.entries) report.info(`  ${describePluginEntry(entry)}`);

    if (plan.action === "leave") {
        report.warn(
            plan.reason === "dev-path"
                ? "A local development checkout is registered next to another Magic Context entry; leaving every entry in place — remove the one you do not want by hand"
                : "Two Magic Context entries carry different options; leaving every entry in place — merge the options into one entry by hand",
        );
        return false;
    }

    if (!options.fix) {
        report.info(
            `  Run 'doctor --fix' to keep ${plan.keep.key}[${plan.keep.index}] (${plan.keep.specifier}) and remove the others`,
        );
        return false;
    }

    applyPluginDuplicatePlan(config, plan);
    report.pass(
        `Removed ${plan.remove.length} duplicate Magic Context ${plan.remove.length === 1 ? "entry" : "entries"} from ${configName}; kept ${plan.keep.specifier} under "${plan.keep.key}"${plan.replacement !== undefined ? " with the removed entry's options" : ""}`,
    );
    return true;
}

/**
 * Detects OMP's "Hide Secrets" setting (`secrets.enabled`) in the settings
 * files OMP reads, without starting OMP and without touching the secrets list.
 *
 * With Hide Secrets on, OMP masks secrets in message text after Magic
 * Context's `context` pass, so the request no longer matches what Magic
 * Context prepared and the pre-send check refuses some turns. Doctor can only
 * warn about it; the fix needs an OMP extension hook.
 *
 * Files and precedence mirror OMP 18.11.3 (paths are relative to the oh-my-pi
 * repository at tag v18.11.3):
 * - Setting: `packages/coding-agent/src/secrets/settings.ts:13-22` registers
 *   `secrets.enabled` (boolean, default false, label "Hide Secrets"). Setting
 *   ids are dotted paths into nested maps, so YAML stores it as
 *   `secrets:\n  enabled: true`.
 * - User layer: `packages/coding-agent/src/config/settings.ts:2367-2380`
 *   (`#readExistingMainYaml`) reads the first existing file of
 *   `MAIN_CONFIG_FILENAMES` (`config.yml`, then `config.yaml`, defined in
 *   `packages/utils/src/dirs.ts:31`) in the agent dir.
 * - Project layer: `packages/coding-agent/src/discovery/builtin.ts:61-78`
 *   (`getConfigDirs`) uses `<cwd>/.omp` when it is a non-empty directory and
 *   cwd is not the home directory; `builtin.ts:898-928` (`loadSettings`) reads
 *   `settings.json` (strict JSON) and then `config.yml` there, and
 *   `config/settings.ts:2437-2438` merges them in that order, so `config.yml`
 *   wins.
 * - Overlays: `config/settings.ts:674-676` resolves `PI_CONFIG_FILES` against
 *   cwd; `config/settings.ts:1917-1935` (`#load`) merges global, then project,
 *   then overlays, with later layers winning.
 *
 * Not detectable from files: the `--config` CLI flag
 * (`packages/coding-agent/src/main.ts:1886`), runtime overrides, and live
 * `/settings` toggles (`packages/coding-agent/src/sdk.ts:4829-4835` reacts to
 * a mid-session switch). Other providers' project settings files
 * (for example `.claude/settings.json`) are not read; OMP merges them too, but
 * they are not where OMP itself writes this key.
 *
 * The secrets themselves live in separate `secrets.yml` files, which this
 * module never opens; it reads only the boolean flag and reports no values.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { envFirstHomeDir, getOmpAgentDir, getOmpConfigOverlayPaths } from "./paths";

/** Docs entry that explains the refusals and the workaround. */
export const OMP_HIDE_SECRETS_DOCS_URL =
    "https://docs.cortexkit.io/magic-context/help/compatibility/#omp-hide-secrets";

/** Value of `secrets.enabled` found in one settings file. */
export type HideSecretsValue =
    | { kind: "on" }
    | { kind: "off" }
    | { kind: "absent" }
    | { kind: "unreadable"; reason: string };

export type HideSecretsLayer = "user" | "project" | "overlay";

export interface HideSecretsSource {
    layer: HideSecretsLayer;
    path: string;
    value: HideSecretsValue;
}

export interface HideSecretsCheck {
    status: "pass" | "warn";
    /** Shown in the terminal; may contain a local path. */
    message: string;
    /** Same check for the issue report: fixed text only, no paths or values. */
    issueMessage: string;
}

const LAYER_LABEL: Record<HideSecretsLayer, string> = {
    user: "OMP user settings",
    project: "OMP project settings",
    overlay: "an OMP config overlay (PI_CONFIG_FILES)",
};

const UNDETECTABLE = "CLI flags and live settings toggles can't be detected";
const SETTING = "OMP Hide Secrets (secrets.enabled)";

const UNRECOGNIZED: HideSecretsValue = {
    kind: "unreadable",
    reason: "secrets.enabled could not be interpreted",
};

/** Remove a YAML comment: `#` at line start or after whitespace, outside quotes. */
function stripYamlComment(line: string): string {
    let quote: string | null = null;
    for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quote) {
            if (char === quote) quote = null;
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === "#" && (index === 0 || /\s/.test(line[index - 1] ?? ""))) {
            return line.slice(0, index).trimEnd();
        }
    }
    return line.trimEnd();
}

function indentOf(line: string): number {
    return line.length - line.trimStart().length;
}

/** Plain YAML 1.2 scalar for `enabled`; quoted or other values are not booleans. */
function yamlBoolean(raw: string): HideSecretsValue {
    const value = raw.trim();
    if (value === "true" || value === "True" || value === "TRUE") return { kind: "on" };
    if (value === "false" || value === "False" || value === "FALSE") return { kind: "off" };
    if (value === "" || value === "~" || value === "null" || value === "Null" || value === "NULL")
        return { kind: "absent" };
    return UNRECOGNIZED;
}

function keyPattern(key: string): RegExp {
    return new RegExp(`^(?:${key}|"${key}"|'${key}')\\s*:(?:\\s+(.*))?$`);
}

const SECRETS_KEY = keyPattern("secrets");
const ENABLED_KEY = keyPattern("enabled");

/** `{ enabled: true, ... }` on one line, with no nested collections. */
function flowMapEnabled(flow: string): HideSecretsValue {
    if (!flow.endsWith("}")) return UNRECOGNIZED;
    const body = flow.slice(1, -1);
    if (/[{}[\]&*!]/.test(body)) return UNRECOGNIZED;
    const matches = body
        .split(",")
        .map((entry) => entry.trim().match(/^(?:enabled|"enabled"|'enabled')\s*:\s*(.*)$/))
        .filter((match): match is RegExpMatchArray => match !== null);
    if (matches.length > 1) return UNRECOGNIZED;
    return matches.length === 0 ? { kind: "absent" } : yamlBoolean(matches[0]?.[1] ?? "");
}

/**
 * Read `secrets.enabled` from OMP settings YAML.
 *
 * A targeted reader, not a YAML parser: it understands the block and
 * one-line flow mappings OMP and people write for this key. Anything it cannot
 * be sure about (duplicate keys, anchors, tags, tabs, multi-line flow, a root
 * flow mapping) is reported as unreadable rather than guessed.
 */
export function readHideSecretsFromYaml(text: string): HideSecretsValue {
    const lines = text
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .map(stripYamlComment);
    const content = lines.filter((line) => line.trim() !== "");
    const first = content[0]?.trim();
    if (first?.startsWith("{") || first?.startsWith("[")) return UNRECOGNIZED;
    if (content.some((line) => /^\s*\t/.test(line))) return UNRECOGNIZED;

    const starts = lines.flatMap((line, index) =>
        indentOf(line) === 0 && SECRETS_KEY.test(line) ? [index] : [],
    );
    if (starts.length === 0) return { kind: "absent" };
    if (starts.length > 1) return UNRECOGNIZED;
    const start = starts[0] as number;
    const inline = (lines[start]?.match(SECRETS_KEY)?.[1] ?? "").trim();
    if (inline.startsWith("{")) return flowMapEnabled(inline);
    if (inline === "~" || inline === "null" || inline === "Null" || inline === "NULL")
        return { kind: "absent" };
    if (inline !== "") return UNRECOGNIZED;

    const children: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (line.trim() === "") continue;
        if (indentOf(line) === 0) break;
        children.push(line);
    }
    if (children.length === 0) return { kind: "absent" };
    const childIndent = indentOf(children[0] as string);
    if (children[0]?.trimStart().startsWith("-")) return UNRECOGNIZED;
    let found: HideSecretsValue | null = null;
    for (let index = 0; index < children.length; index += 1) {
        const line = children[index] as string;
        const indent = indentOf(line);
        if (indent < childIndent) return UNRECOGNIZED;
        if (indent > childIndent) continue;
        const match = line.trim().match(ENABLED_KEY);
        if (!match) continue;
        if (found) return UNRECOGNIZED;
        const nextIndent = children[index + 1] ? indentOf(children[index + 1] as string) : 0;
        // `enabled:` followed by a deeper block is a map, not a boolean.
        if ((match[1] ?? "").trim() === "" && nextIndent > childIndent) return UNRECOGNIZED;
        found = yamlBoolean(match[1] ?? "");
    }
    return found ?? { kind: "absent" };
}

/** Read `secrets.enabled` from a strict-JSON `settings.json`, as OMP's `tryParseJson` does. */
export function readHideSecretsFromJson(text: string): HideSecretsValue {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { kind: "unreadable", reason: "file is not valid JSON" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "absent" };
    const secrets = (parsed as Record<string, unknown>).secrets;
    if (secrets === undefined || secrets === null) return { kind: "absent" };
    if (typeof secrets !== "object" || Array.isArray(secrets)) return UNRECOGNIZED;
    const enabled = (secrets as Record<string, unknown>).enabled;
    if (enabled === true) return { kind: "on" };
    if (enabled === false) return { kind: "off" };
    if (enabled === undefined || enabled === null) return { kind: "absent" };
    return UNRECOGNIZED;
}

function readSource(
    layer: HideSecretsLayer,
    path: string,
    format: "yaml" | "json",
): HideSecretsSource {
    let text: string;
    try {
        text = readFileSync(path, "utf-8");
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return {
            layer,
            path,
            value: {
                kind: "unreadable",
                reason: `file could not be read${code ? ` (${code})` : ""}`,
            },
        };
    }
    return {
        layer,
        path,
        value: format === "json" ? readHideSecretsFromJson(text) : readHideSecretsFromYaml(text),
    };
}

function isNonEmptyDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory() && readdirSync(path).length > 0;
    } catch {
        return false;
    }
}

/**
 * Settings files that can carry `secrets.enabled`, lowest precedence first.
 * Only files that exist are returned; overlays that are missing are skipped
 * here (OMP itself refuses to start with one).
 */
export function collectHideSecretsSources(
    cwd: string,
    home = envFirstHomeDir(),
): HideSecretsSource[] {
    const sources: HideSecretsSource[] = [];
    const agentDir = getOmpAgentDir();
    const mainConfig = ["config.yml", "config.yaml"]
        .map((name) => join(agentDir, name))
        .find((path) => existsSync(path));
    if (mainConfig) sources.push(readSource("user", mainConfig, "yaml"));

    const projectDir = join(cwd, ".omp");
    if (resolve(cwd) !== resolve(home) && isNonEmptyDirectory(projectDir)) {
        for (const [name, format] of [
            ["settings.json", "json"],
            ["config.yml", "yaml"],
        ] as const) {
            const path = join(projectDir, name);
            if (existsSync(path)) sources.push(readSource("project", path, format));
        }
    }

    for (const path of getOmpConfigOverlayPaths(cwd)) {
        if (existsSync(path)) sources.push(readSource("overlay", path, "yaml"));
    }
    return sources;
}

/**
 * Doctor checks for Hide Secrets: one warning when the effective file value is
 * on, one warning per file that could not be checked and could still change
 * the effective value, otherwise one pass.
 */
export function checkOmpHideSecrets(sources: readonly HideSecretsSource[]): HideSecretsCheck[] {
    let effective: HideSecretsSource | null = null;
    let effectiveIndex = -1;
    for (const [index, source] of sources.entries()) {
        if (source.value.kind === "on" || source.value.kind === "off") {
            effective = source;
            effectiveIndex = index;
        }
    }
    if (effective?.value.kind === "on") {
        const explain = `OMP masks secrets after Magic Context prepares a turn, so some turns are refused; turn it off for Magic Context sessions, see ${OMP_HIDE_SECRETS_DOCS_URL} (${UNDETECTABLE})`;
        const label = LAYER_LABEL[effective.layer];
        return [
            {
                status: "warn",
                message: `${SETTING} is on in ${label} (${effective.path}): ${explain}`,
                issueMessage: `${SETTING} is on in ${label}: ${explain}`,
            },
        ];
    }
    // A file below the layer that decides the value cannot change it, so only
    // unreadable files above that layer leave the answer open.
    const unreadable = sources.flatMap((source, index) =>
        index > effectiveIndex && source.value.kind === "unreadable"
            ? [{ source, reason: source.value.reason }]
            : [],
    );
    if (unreadable.length > 0) {
        return unreadable.map(({ source, reason }) => {
            const tail = `${reason}; if Hide Secrets is on, see ${OMP_HIDE_SECRETS_DOCS_URL} (${UNDETECTABLE})`;
            const label = LAYER_LABEL[source.layer];
            return {
                status: "warn" as const,
                message: `Could not check ${SETTING} in ${label} (${source.path}): ${tail}`,
                issueMessage: `Could not check ${SETTING} in ${label}: ${tail}`,
            };
        });
    }
    const message =
        effective?.value.kind === "off"
            ? `${SETTING} is off in OMP settings files (${UNDETECTABLE})`
            : `${SETTING} is not set in OMP settings files; OMP's default is off (${UNDETECTABLE})`;
    return [{ status: "pass", message, issueMessage: message }];
}

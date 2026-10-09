import {
    closeSync,
    existsSync,
    linkSync,
    openSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { removeJsoncValue, setJsoncValue } from "../shared/jsonc-edit";
import { parseJsonc } from "../shared/jsonc-parser";

export type ConfigTier = "user" | "project";

export interface FlatConfigDiagnostic {
    path: string;
    message: string;
}

export interface FlatConfigMigration {
    bytes: Buffer;
    hasFlatKeys: boolean;
    diagnostics: FlatConfigDiagnostic[];
}

export interface RawConfigLoadOptions {
    configPath: string;
    tier: ConfigTier;
    /** Test-only seam for making a competing loader replace the target before this loader re-checks it. */
    afterTemporaryWrite?: () => void;
}

export interface RawConfigLoadResult {
    configPath: string;
    bytes: Buffer;
    text: string;
    warnings: string[];
    migrated: boolean;
}

const MODEL_FIELDS = ["model", "fallback_models"] as const;
const QUALIFIER_FIELDS = ["variant", "thinking_level"] as const;
const TASK_MODEL_FIELDS = [...MODEL_FIELDS, ...QUALIFIER_FIELDS, "timeout_minutes"] as const;
const PRE_PER_HARNESS_BACKUP_SUFFIX = ".pre-per-harness.bak";
let temporaryFileSequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asDocument(text: string): Record<string, unknown> | null {
    try {
        // JSON.parse rejects a UTF-8 BOM, while JSONC files commonly retain one.
        // Remove it only for inspection; every byte-writing path adds it back.
        const document = parseJsonc<unknown>(text.startsWith("\uFEFF") ? text.slice(1) : text);
        return isRecord(document) ? document : null;
    } catch {
        return null;
    }
}

function getAtPath(document: Record<string, unknown>, path: readonly string[]): unknown {
    let current: unknown = document;
    for (const part of path) {
        if (!isRecord(current) || !Object.hasOwn(current, part)) return undefined;
        current = current[part];
    }
    return current;
}

function stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (!isRecord(value)) return JSON.stringify(value);
    return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
        .join(",")}}`;
}

function valuesMatch(left: unknown, right: unknown): boolean {
    return stableJson(left) === stableJson(right);
}

function valueForDiagnostic(value: unknown): string {
    return stableJson(value);
}

function migrateEntryForHarness(value: unknown, harness: "opencode" | "pi"): unknown {
    if (Array.isArray(value)) return value.map((entry) => migrateEntryForHarness(entry, harness));
    if (!isRecord(value) || !Object.hasOwn(value, "model")) return value;

    const entry: Record<string, unknown> = { model: value.model };
    if (harness === "opencode" && Object.hasOwn(value, "variant")) {
        entry.variant = value.variant;
    }
    if (harness === "pi" && Object.hasOwn(value, "thinking_level")) {
        entry.thinking_level = value.thinking_level;
    }
    return entry;
}

function migrateFallbackForHarness(value: unknown, harness: "opencode" | "pi"): unknown {
    if (typeof value === "string") return [value];
    return migrateEntryForHarness(value, harness);
}

function canCreateAtPath(document: Record<string, unknown>, path: readonly string[]): boolean {
    let current: unknown = document;
    for (const part of path) {
        if (current === undefined) return true;
        if (!isRecord(current)) return false;
        current = current[part];
    }
    return current === undefined || isRecord(current);
}

function flatFieldPath(parts: readonly string[]): string {
    return parts.join(".");
}

function updateDocumentForFlatFields(text: string): {
    text: string;
    hasFlatKeys: boolean;
    diagnostics: FlatConfigDiagnostic[];
    flatPaths: string[];
} {
    const hasBom = text.startsWith("\uFEFF");
    const editableText = hasBom ? text.slice(1) : text;
    const document = asDocument(text);
    if (!document) {
        return { text, hasFlatKeys: false, diagnostics: [], flatPaths: [] };
    }

    let nextText = editableText;
    let hasFlatKeys = false;
    const diagnostics: FlatConfigDiagnostic[] = [];
    const flatPaths: string[] = [];
    const sourcePathsToRemove: string[][] = [];

    const addDestination = (
        sourcePath: string[],
        destinationPath: string[],
        destinationValue: unknown,
    ): void => {
        const sourceLabel = flatFieldPath(sourcePath);
        const destinationLabel = flatFieldPath(destinationPath);
        if (!canCreateAtPath(document, destinationPath.slice(0, -1))) {
            diagnostics.push({
                path: sourceLabel,
                message: `Flat config field "${sourceLabel}" (${valueForDiagnostic(destinationValue)}) conflicts with non-object destination "${destinationLabel}" (${valueForDiagnostic(getAtPath(document, destinationPath.slice(0, -1)))}); kept the destination and ignored the flat field.`,
            });
            return;
        }

        const existing = getAtPath(document, destinationPath);
        if (existing !== undefined) {
            if (!valuesMatch(existing, destinationValue)) {
                diagnostics.push({
                    path: sourceLabel,
                    message: `Flat config field "${sourceLabel}" (${valueForDiagnostic(destinationValue)}) conflicts with "${destinationLabel}" (${valueForDiagnostic(existing)}); kept "${destinationLabel}" and ignored the flat field.`,
                });
            }
            return;
        }

        nextText = setJsoncValue(nextText, destinationPath, destinationValue);
    };

    const migrateAgentFields = (agentName: "historian" | "dreamer"): void => {
        const agent = document[agentName];
        if (!isRecord(agent)) return;

        for (const field of MODEL_FIELDS) {
            if (!Object.hasOwn(agent, field)) continue;
            const sourcePath = [agentName, field];
            hasFlatKeys = true;
            flatPaths.push(flatFieldPath(sourcePath));
            sourcePathsToRemove.push(sourcePath);
            const migrateValue =
                field === "fallback_models" ? migrateFallbackForHarness : migrateEntryForHarness;
            addDestination(
                sourcePath,
                [agentName, "opencode", field],
                migrateValue(agent[field], "opencode"),
            );
            addDestination(sourcePath, [agentName, "pi", field], migrateValue(agent[field], "pi"));
        }

        if (Object.hasOwn(agent, "variant")) {
            const sourcePath = [agentName, "variant"];
            hasFlatKeys = true;
            flatPaths.push(flatFieldPath(sourcePath));
            sourcePathsToRemove.push(sourcePath);
            addDestination(sourcePath, [agentName, "opencode", "variant"], agent.variant);
        }

        if (Object.hasOwn(agent, "thinking_level")) {
            const sourcePath = [agentName, "thinking_level"];
            hasFlatKeys = true;
            flatPaths.push(flatFieldPath(sourcePath));
            sourcePathsToRemove.push(sourcePath);
            addDestination(sourcePath, [agentName, "pi", "thinking_level"], agent.thinking_level);
        }
    };

    migrateAgentFields("historian");
    migrateAgentFields("dreamer");

    const dreamer = document.dreamer;
    const tasks = isRecord(dreamer) ? dreamer.tasks : undefined;
    if (isRecord(tasks)) {
        for (const taskName of Object.keys(tasks).sort()) {
            const task = tasks[taskName];
            if (!isRecord(task)) continue;

            for (const field of TASK_MODEL_FIELDS) {
                if (!Object.hasOwn(task, field)) continue;
                const sourcePath = ["dreamer", "tasks", taskName, field];
                hasFlatKeys = true;
                flatPaths.push(flatFieldPath(sourcePath));
                sourcePathsToRemove.push(sourcePath);

                if (field === "model" || field === "fallback_models") {
                    addDestination(
                        sourcePath,
                        ["dreamer", "opencode", "tasks", taskName, field],
                        field === "fallback_models"
                            ? migrateFallbackForHarness(task[field], "opencode")
                            : migrateEntryForHarness(task[field], "opencode"),
                    );
                    addDestination(
                        sourcePath,
                        ["dreamer", "pi", "tasks", taskName, field],
                        field === "fallback_models"
                            ? migrateFallbackForHarness(task[field], "pi")
                            : migrateEntryForHarness(task[field], "pi"),
                    );
                } else if (field === "variant") {
                    addDestination(
                        sourcePath,
                        ["dreamer", "opencode", "tasks", taskName, field],
                        task[field],
                    );
                } else if (field === "thinking_level") {
                    addDestination(
                        sourcePath,
                        ["dreamer", "pi", "tasks", taskName, field],
                        task[field],
                    );
                } else {
                    addDestination(
                        sourcePath,
                        ["dreamer", "opencode", "tasks", taskName, field],
                        task[field],
                    );
                    addDestination(
                        sourcePath,
                        ["dreamer", "pi", "tasks", taskName, field],
                        task[field],
                    );
                }
            }
        }
    }

    for (const sourcePath of sourcePathsToRemove) {
        nextText = removeJsoncValue(nextText, sourcePath);
    }

    return {
        text: hasBom ? `\uFEFF${nextText}` : nextText,
        hasFlatKeys,
        diagnostics,
        flatPaths,
    };
}

/** True when historian, dreamer, or dreamer-task fields still use the flat shape. */
export function hasFlatKeys(input: Buffer | string): boolean {
    const text = typeof input === "string" ? input : input.toString("utf-8");
    return updateDocumentForFlatFields(text).hasFlatKeys;
}

/**
 * Deterministically maps flat model fields into per-harness blocks while leaving
 * unrelated JSONC regions untouched. The return type matches the caller's input
 * representation so callers that operate on file bytes retain BOM and line-ending
 * details exactly outside the surgical edits.
 */
export function migrateFlat(input: string): string;
export function migrateFlat(input: Buffer): Buffer;
export function migrateFlat(input: Buffer | string): Buffer | string {
    const text = typeof input === "string" ? input : input.toString("utf-8");
    const migrated = updateDocumentForFlatFields(text).text;
    return typeof input === "string" ? migrated : Buffer.from(migrated, "utf-8");
}

export function migrateFlatDetailed(input: Buffer | string): FlatConfigMigration {
    const bytes = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
    const result = updateDocumentForFlatFields(bytes.toString("utf-8"));
    return {
        bytes: Buffer.from(result.text, "utf-8"),
        hasFlatKeys: result.hasFlatKeys,
        diagnostics: result.diagnostics,
    };
}

function writeExclusiveBackup(backupPath: string, bytes: Buffer, mode: number): void {
    const temporaryPath = writeTemporaryCandidate(backupPath, bytes, mode);
    try {
        try {
            // A hard link publishes the fully written candidate without replacing a concurrent backup.
            linkSync(temporaryPath, backupPath);
            return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }

        const existingBytes = readFileSync(backupPath);
        if (existingBytes.equals(bytes)) return;

        // A prefix may be a partial file left when the former direct-write approach crashed.
        // Preserve any other content because it may be a complete backup from an earlier run.
        if (bytes.subarray(0, existingBytes.length).equals(existingBytes)) {
            renameSync(temporaryPath, backupPath);
            return;
        }
    } finally {
        try {
            unlinkSync(temporaryPath);
        } catch {
            // The candidate may already be linked or renamed into place; cleanup failure must
            // not obscure the result of creating or validating the permanent backup.
        }
    }
}

function writeTemporaryCandidate(configPath: string, bytes: Buffer, mode: number): string {
    const directory = dirname(configPath);
    const stem = basename(configPath);
    for (let attempt = 0; attempt < 32; attempt++) {
        temporaryFileSequence += 1;
        const path = join(
            directory,
            `.${stem}.per-harness-${process.pid}-${temporaryFileSequence}.tmp`,
        );
        let descriptor: number | undefined;
        try {
            descriptor = openSync(path, "wx", mode);
            writeFileSync(descriptor, bytes);
            closeSync(descriptor);
            return path;
        } catch (error) {
            if (descriptor !== undefined) {
                try {
                    closeSync(descriptor);
                } catch {
                    // The write error below remains the actionable error.
                }
            }
            try {
                unlinkSync(path);
            } catch {
                // A failed cleanup must not hide the original write error.
            }
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
    }
    throw new Error(`Could not allocate a temporary config file beside ${configPath}`);
}

function migrationWarning(diagnostic: FlatConfigDiagnostic): string {
    return diagnostic.message;
}

/**
 * Reads the raw tier before substitution and schema validation. User files are
 * rewritten through an exact-byte backup and same-directory atomic replacement;
 * project files are adapted only in memory. This is the common seam used by both
 * harness loaders and their doctor paths.
 */
export function loadRawConfigFile(options: RawConfigLoadOptions): RawConfigLoadResult | null {
    if (!existsSync(options.configPath)) return null;

    let observedBytes: Buffer;
    try {
        observedBytes = readFileSync(options.configPath);
    } catch (error) {
        throw new Error(
            `failed to read config: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    const initialMigration = migrateFlatDetailed(observedBytes);
    if (!initialMigration.hasFlatKeys) {
        return {
            configPath: options.configPath,
            bytes: observedBytes,
            text: observedBytes.toString("utf-8"),
            warnings: [],
            migrated: false,
        };
    }

    if (options.tier === "project") {
        return {
            configPath: options.configPath,
            bytes: initialMigration.bytes,
            text: initialMigration.bytes.toString("utf-8"),
            warnings: [
                "Adapted flat model config in memory; use historian.opencode/historian.pi and dreamer.opencode/dreamer.pi instead. Project config files are never rewritten.",
                ...initialMigration.diagnostics.map(migrationWarning),
            ],
            migrated: false,
        };
    }

    const backupPath = `${options.configPath}${PRE_PER_HARNESS_BACKUP_SUFFIX}`;
    for (;;) {
        const migration = migrateFlatDetailed(observedBytes);
        if (!migration.hasFlatKeys) {
            return {
                configPath: options.configPath,
                bytes: observedBytes,
                text: observedBytes.toString("utf-8"),
                warnings: [],
                migrated: false,
            };
        }

        let temporaryPath: string | undefined;
        try {
            // Write through a symlinked config (stow, chezmoi, home-manager keep
            // it in a dotfiles repo): the temporary file is created next to the
            // real file and renamed onto it, so the link itself stays a link.
            const writePath = realpathSync(options.configPath);
            const mode = options.tier === "user" ? 0o600 : statSync(writePath).mode & 0o777;
            writeExclusiveBackup(backupPath, observedBytes, mode);
            temporaryPath = writeTemporaryCandidate(writePath, migration.bytes, mode);
            options.afterTemporaryWrite?.();

            const currentBytes = readFileSync(options.configPath);
            if (!hasFlatKeys(currentBytes)) {
                unlinkSync(temporaryPath);
                return {
                    configPath: options.configPath,
                    bytes: currentBytes,
                    text: currentBytes.toString("utf-8"),
                    warnings: [],
                    migrated: false,
                };
            }
            if (!currentBytes.equals(observedBytes)) {
                unlinkSync(temporaryPath);
                observedBytes = currentBytes;
                continue;
            }

            renameSync(temporaryPath, writePath);
            return {
                configPath: options.configPath,
                bytes: migration.bytes,
                text: migration.bytes.toString("utf-8"),
                warnings: [
                    "Migrated flat historian/dreamer model config to per-harness blocks.",
                    ...migration.diagnostics.map(migrationWarning),
                ],
                migrated: true,
            };
        } catch (error) {
            if (temporaryPath) {
                try {
                    unlinkSync(temporaryPath);
                } catch {
                    // The migration error is more useful than a failed temp cleanup.
                }
            }
            return {
                configPath: options.configPath,
                bytes: observedBytes,
                text: observedBytes.toString("utf-8"),
                warnings: [
                    `Could not migrate flat model config: ${error instanceof Error ? error.message : String(error)}. Flat fields were not applied.`,
                    ...migration.diagnostics.map(migrationWarning),
                ],
                migrated: false,
            };
        }
    }
}

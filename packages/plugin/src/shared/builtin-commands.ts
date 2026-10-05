import type { Config } from "@opencode-ai/sdk";

// Keep command metadata independent of server features: config validation and
// the separately shipped TUI need the same reserved command names.
type BuiltinCommandConfig = NonNullable<Config["command"]>;

const COMPACTION_ENABLED_PATH = `compaction${".enabled"}`;

export function getMagicContextBuiltinCommands(compactionEnabled = true) {
    const unavailableInCompactionOff = (command: string) =>
        `Unavailable when ${COMPACTION_ENABLED_PATH} is false: /${command} manages compacted history.`;

    return {
        "ctx-status": {
            template: "ctx-status",
            description: "Show magic context status, pending queue, cache TTL, and debug info",
        },
        "ctx-recomp": {
            template: "ctx-recomp",
            description: compactionEnabled
                ? "Rebuild compressed history from raw history (full or <start>-<end> range); memories are not changed"
                : unavailableInCompactionOff("ctx-recomp"),
        },
        "ctx-wrapup": {
            template: "ctx-wrapup",
            description: compactionEnabled
                ? "Compact older live history while keeping the newest messages raw"
                : unavailableInCompactionOff("ctx-wrapup"),
        },
        "ctx-flush": {
            template: "ctx-flush",
            description: compactionEnabled
                ? "Force-process all pending magic context operations immediately"
                : unavailableInCompactionOff("ctx-flush"),
        },
        "ctx-dream": {
            template: "ctx-dream",
            description: "Run the hidden dreamer maintenance pass for this project now",
        },
        "ctx-embed": {
            template: "ctx-embed",
            description:
                "Embedding status, or start/pause history compartment embedding (start | pause)",
        },
    } satisfies BuiltinCommandConfig;
}

export type MagicContextBuiltinCommandName = keyof ReturnType<
    typeof getMagicContextBuiltinCommands
>;

import type { MagicContextPluginConfig } from "../../config";
import { dreamerRunConfig, historianRunConfig } from "../../config/live-run-config";
import type { LiveConfigReader } from "../../config/live-snapshot";
import { getProtectedTokensTierOverrides } from "../../config/project-security";
import { DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE } from "../../config/schema/magic-context";
import { createCompactionHandler } from "../../features/magic-context/compaction";
import { createScheduler } from "../../features/magic-context/scheduler";
import type { DatabaseBootTimings } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import { createMagicContextHook, createMagicContextHookAsync } from "../../hooks/magic-context";
import type { LiveSessionState } from "../../hooks/magic-context/live-session-state";
import type { RustModeModuleClient } from "../../hooks/magic-context/rust-mode-transform";
import type { PromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import type { PluginContext } from "../types";
/**
 * Map the full plugin config down to the per-session hook config. Pure and
 * exported so it can be unit-tested directly — without a module-level
 * `mock.module` of the hooks barrel, which in Bun leaks process-globally across
 * test files (mock.restore() does not undo it) and corrupts sibling suites that
 * import the real hook shape.
 */
export function buildMagicContextHookConfig(pluginConfig: MagicContextPluginConfig) {
    // Pass the WHOLE plugin config through and only override the fields that
    // need defaulting. This was a hand-maintained field-by-field mapping, which
    // silently dropped every hook-config field added after the mapping was
    // written: `smart_drops`, `language`, `embedding`, and `transform_mode`
    // all read as undefined inside the hook even when set by
    // the user, turning opted-in features off with no warning. The hook only
    // consumes the fields its config type declares, so the extra top-level keys
    // carried by the spread are inert.
    const hookConfig = {
        ...pluginConfig,
        protected_tokens: pluginConfig.protected_tokens,
        protectedTokenTierOverrides: getProtectedTokensTierOverrides(pluginConfig),
        execute_threshold_percentage:
            pluginConfig.execute_threshold_percentage ?? DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
    };
    // The parser retains the deprecated count only to issue one migration warning.
    // Do not carry that inert key into live per-session plumbing.
    delete hookConfig.protected_tags;
    return hookConfig;
}

export function createSessionHooks(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
    liveConfigReader?: LiveConfigReader<MagicContextPluginConfig>;
    liveSessionState: LiveSessionState;
    rustModeModuleClient?: RustModeModuleClient;
    promptSurfaceRuntime?: PromptSurfaceRuntime;
}) {
    const { ctx, pluginConfig, liveSessionState } = args;
    const liveConfigReader = args.liveConfigReader;

    if (pluginConfig.enabled !== true) {
        return { magicContext: null, rustToolBackends: undefined };
    }

    const tagger = createTagger();
    const scheduler = createScheduler({
        executeThresholdPercentage:
            pluginConfig.execute_threshold_percentage ?? DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
        executeThresholdTokens: pluginConfig.execute_threshold_tokens,
    });
    const compactionHandler = createCompactionHandler();
    const hookResult = createMagicContextHook({
        client: ctx.client,
        directory: ctx.directory,
        tagger,
        scheduler,
        compactionHandler,
        liveSessionState,
        rustModeModuleClient: args.rustModeModuleClient,
        promptSurfaceRuntime: args.promptSurfaceRuntime,
        config: buildMagicContextHookConfig(pluginConfig),
        sampleHistorianConfig: liveConfigReader
            ? () =>
                  buildMagicContextHookConfig(
                      historianRunConfig(pluginConfig, liveConfigReader.poll().effective),
                  )
            : undefined,
        sampleDreamConfig: liveConfigReader
            ? () =>
                  buildMagicContextHookConfig(
                      dreamerRunConfig(pluginConfig, liveConfigReader.poll().effective),
                  )
            : undefined,
    });

    return {
        magicContext: hookResult,
        rustToolBackends: hookResult?.rustToolBackends,
    };
}

export async function createSessionHooksAsync(args: {
    ctx: PluginContext;
    pluginConfig: MagicContextPluginConfig;
    liveConfigReader?: LiveConfigReader<MagicContextPluginConfig>;
    liveSessionState: LiveSessionState;
    rustModeModuleClient?: RustModeModuleClient;
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    onStorageBootTimings?: (timings: DatabaseBootTimings) => void;
}) {
    const { ctx, pluginConfig, liveSessionState } = args;
    const liveConfigReader = args.liveConfigReader;

    if (pluginConfig.enabled !== true) {
        return { magicContext: null, rustToolBackends: undefined };
    }

    const tagger = createTagger();
    const scheduler = createScheduler({
        executeThresholdPercentage:
            pluginConfig.execute_threshold_percentage ?? DEFAULT_EXECUTE_THRESHOLD_PERCENTAGE,
        executeThresholdTokens: pluginConfig.execute_threshold_tokens,
    });
    const compactionHandler = createCompactionHandler();
    const hookResult = await createMagicContextHookAsync({
        client: ctx.client,
        directory: ctx.directory,
        tagger,
        scheduler,
        compactionHandler,
        liveSessionState,
        rustModeModuleClient: args.rustModeModuleClient,
        promptSurfaceRuntime: args.promptSurfaceRuntime,
        onStorageBootTimings: args.onStorageBootTimings,
        config: buildMagicContextHookConfig(pluginConfig),
        sampleHistorianConfig: liveConfigReader
            ? () =>
                  buildMagicContextHookConfig(
                      historianRunConfig(pluginConfig, liveConfigReader.poll().effective),
                  )
            : undefined,
        sampleDreamConfig: liveConfigReader
            ? () =>
                  buildMagicContextHookConfig(
                      dreamerRunConfig(pluginConfig, liveConfigReader.poll().effective),
                  )
            : undefined,
    });

    return {
        magicContext: hookResult,
        rustToolBackends: hookResult?.rustToolBackends,
    };
}

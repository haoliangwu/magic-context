/**
 * Size a historian prompt to the producer model's window before anything is
 * spawned.
 *
 * A historian prompt has fixed parts (system prompt, seed examples, recent
 * compartments, the project-memory block, instructions) plus the chunk of raw
 * history being summarized. The chunk budget alone used to be a share of the
 * window, so on a small window or with a large memory block the whole prompt
 * could exceed the window; admission then refused it on every trigger and the
 * session was never summarized again.
 *
 * `fitHistorianPrompt` reserves the fixed parts and the output first, then gives
 * the chunk what remains. When the full requested chunk does not fit, it trims
 * the fixed context in this order until it does: diverse older compartments,
 * recent compartments (oldest first), project-memory lines (lowest priority
 * first), then seed examples. Recent examples preserve continuity without scores
 * to prevent anchoring in one-compartment runs; diverse examples carry scores.
 * When everything is trimmed, the chunk shrinks to whatever room is left. Only
 * when not even a minimal chunk fits is the prompt refused, with a reason that
 * stays identical until the model, its window, or the instructions change, so a
 * caller can back off on it.
 */

import { withContentLanguageDirective } from "../../agents/language-directive";
import type { Memory } from "../../features/magic-context/memory/types";
import type { ModelInput } from "../../shared/model-resolution";
import { getSdkOutputLimit } from "../../shared/models-dev-cache";
import { toModelEntry } from "../../shared/resolve-fallbacks";
import { buildCompartmentAgentPrompt, COMPARTMENT_AGENT_SYSTEM_PROMPT } from "./compartment-prompt";
import { calibrationForModelKey, providerMass } from "./decision-calibration";
import { resolveHistorianProducerLimits } from "./derive-budgets";
import { orderHistorianMemories, renderHistorianMemoryBlock } from "./inject-compartments";
import { historianProducerReserve, producerInputTokenLimit } from "./producer-window-guard";
import { estimateFixedPromptTokens } from "./read-session-formatting";
import {
    type ReferenceCompartment,
    renderSeedExamplesBlock,
    renderSessionReferencesBlock,
    selectSeeds,
    selectSessionReferences,
} from "./reference-retrieval";

/**
 * Smallest chunk worth a historian run. Below this the fixed parts take the
 * whole window and a run could not summarize even one ordinary message.
 */
export const HISTORIAN_MIN_FIT_CHUNK_TOKENS = 1_000;

/**
 * Local tokens held back from the chunk budget. The fixed parts and the chunk
 * are counted separately, and counting their concatenation can differ by a few
 * tokens at the joins.
 */
const FIT_SLACK_TOKENS = 64;

/**
 * Prompt failures caused by the producer window. They repeat until the model,
 * its window or the instructions change, so callers treat them as counted
 * failures and do not retry them on the next trigger.
 */
export const PRODUCER_PROMPT_FIT_FAILURE_PATTERN =
    /producer_prompt_(?:exceeds_window|fit_unavailable|unfit)/;

export interface HistorianProducerWindow {
    /** Producer model id in `provider/model` form; selects the tokenizer calibration. */
    modelKey?: string;
    contextLimitTokens?: number;
    inputLimitTokens?: number;
    /** Output tokens reserved inside a shared context window. */
    maxOutputTokens: number;
}

/**
 * The window that the OpenCode historian checks a prompt against before sending
 * it to `modelKey` (see `historianPromptAdmissionFailure`), so a fitted prompt
 * passes that check. `fallbackContextLimit` stands in when the model catalog
 * knows no window for the model.
 */
export function resolveHistorianProducerWindow(
    modelKey: string | undefined,
    configuredMaxOutputTokens: number | undefined,
    fallbackContextLimit?: number,
): HistorianProducerWindow {
    const limits = resolveHistorianProducerLimits(modelKey);
    const context =
        limits.context ?? (limits.input === undefined ? fallbackContextLimit : undefined);
    const slash = modelKey?.indexOf("/") ?? -1;
    const catalogOutput =
        modelKey && slash > 0
            ? getSdkOutputLimit(modelKey.slice(0, slash), modelKey.slice(slash + 1))
            : undefined;
    return {
        modelKey,
        contextLimitTokens: context,
        inputLimitTokens: limits.input,
        maxOutputTokens: historianProducerReserve(
            context,
            configuredMaxOutputTokens,
            catalogOutput,
        ),
    };
}

export interface HistorianPromptFitArgs {
    window: HistorianProducerWindow;
    systemPrompt: string;
    /** Chunk budget the caller would use without a window, in local tokens. */
    requestedChunkTokens: number;
    sessionId: string;
    /** First ordinal of the chunk; selects the seed examples. */
    chunkStart: number;
    /** Highest ordinal the chunk can end at; sizes the `Messages X-Y:` header. */
    lastOrdinal: number;
    sessionCompartments: ReferenceCompartment[];
    /** Memories for the `<project-memory>` block; empty when there is none. */
    memories: Memory[];
    memoryEnabled: boolean;
    extractionFree?: boolean;
}

export interface HistorianPromptFitKept {
    sessionReferences: number;
    memories: number;
    memoriesTotal: number;
    seeds: number;
    seedsTotal: number;
}

export type HistorianPromptFit =
    | {
          ok: true;
          /** False when the window is unknown and the prompt goes out unguarded. */
          guarded: boolean;
          /** Chunk budget in local tokens. */
          chunkTokens: number;
          /**
           * Most source tokens the window holds next to the chosen fixed parts, at
           * least `chunkTokens`. An atomic unit the chunk reader cannot split may
           * use up to this much. Undefined when the window is unknown.
           */
          roomTokens?: number;
          seedExamples: string;
          sessionReferences: string;
          projectMemory: string;
          /** True when any fixed context was dropped to make room. */
          trimmed: boolean;
          kept: HistorianPromptFitKept;
      }
    | { ok: false; reason: string };

/**
 * Fit a recomp prompt (rebuilds compartments only: no memory block, no fact
 * extraction) to the window of the model the recomp's first attempt runs on.
 * It is measured against the main historian system prompt, which is what the
 * pre-send window check counts for recomp prompts too.
 */
export function fitRecompHistorianPrompt(args: {
    model?: ModelInput;
    fallbackModelId?: string;
    language?: string;
    requestedChunkTokens: number;
    sessionId: string;
    chunkStart: number;
    lastOrdinal: number;
    sessionCompartments: ReferenceCompartment[];
}): HistorianPromptFit {
    const modelKey = toModelEntry(args.model)?.model ?? args.fallbackModelId;
    return fitHistorianPrompt({
        window: resolveHistorianProducerWindow(modelKey, undefined),
        systemPrompt: withContentLanguageDirective(COMPARTMENT_AGENT_SYSTEM_PROMPT, args.language),
        requestedChunkTokens: args.requestedChunkTokens,
        sessionId: args.sessionId,
        chunkStart: Math.max(1, args.chunkStart),
        lastOrdinal: args.lastOrdinal,
        sessionCompartments: args.sessionCompartments,
        memories: [],
        memoryEnabled: false,
        extractionFree: true,
    });
}

/** Describe what a fit dropped, for the session log. */
export function describeHistorianPromptTrim(
    fit: Extract<HistorianPromptFit, { ok: true }>,
): string {
    const { kept } = fit;
    return `chunkTokens=${fit.chunkTokens} sessionReferences=${kept.sessionReferences} memories=${kept.memories}/${kept.memoriesTotal} seeds=${kept.seeds}/${kept.seedsTotal}`;
}

export function fitHistorianPrompt(args: HistorianPromptFitArgs): HistorianPromptFit {
    const requested = Math.max(0, Math.floor(args.requestedChunkTokens));
    const seeds = selectSeeds(args.sessionId, args.chunkStart);
    const references = selectSessionReferences(
        args.sessionCompartments,
        seeds,
        args.sessionId,
        args.chunkStart,
    );
    const memories = orderHistorianMemories(args.memories);
    const render = (refs: number, memoryCount: number, seedCount: number) => ({
        seedExamples: renderSeedExamplesBlock(seeds.slice(0, seedCount)),
        sessionReferences: renderSessionReferencesBlock(references, refs),
        projectMemory: renderHistorianMemoryBlock(memories.slice(0, memoryCount)) ?? "",
    });
    const kept = (refs: number, memoryCount: number, seedCount: number) => ({
        sessionReferences: refs,
        memories: memoryCount,
        memoriesTotal: memories.length,
        seeds: seedCount,
        seedsTotal: seeds.length,
    });

    const limit = producerInputTokenLimit(
        args.window.contextLimitTokens,
        args.window.maxOutputTokens,
        args.window.inputLimitTokens,
    );
    if (limit === undefined) {
        return {
            ok: true,
            guarded: false,
            chunkTokens: requested,
            ...render(references.length, memories.length, seeds.length),
            trimmed: false,
            kept: kept(references.length, memories.length, seeds.length),
        };
    }

    const calibration = calibrationForModelKey(args.window.modelKey);
    const systemLocal = estimateFixedPromptTokens(args.systemPrompt);
    const mass = (proseLocal: number) =>
        providerMass({ prose: proseLocal, system: systemLocal }, calibration, true);
    if (!Number.isFinite(mass(0)) || mass(0) <= 0) {
        return {
            ok: false,
            reason: `producer_prompt_fit_unavailable model=${args.window.modelKey ?? "unknown"}`,
        };
    }

    const chunkHeader = `Messages ${args.chunkStart}-${args.lastOrdinal}:\n\n`;
    // Trimming levels often render the same text (fewer compartments than the
    // reference window, say), so count each distinct prompt once.
    const counted = new Map<string, number>();
    const fixedLocal = (blocks: ReturnType<typeof render>, header = chunkHeader) => {
        const text = buildCompartmentAgentPrompt({
            ...blocks,
            inputSource: header,
            memoryEnabled: args.memoryEnabled,
            extractionFree: args.extractionFree,
        });
        let tokens = counted.get(text);
        if (tokens === undefined) {
            tokens = estimateFixedPromptTokens(text);
            counted.set(text, tokens);
        }
        return tokens;
    };
    // Largest chunk (local tokens) that keeps the calibrated prompt within the
    // limit, or -1 when the fixed parts alone do not fit.
    const roomFor = (blocks: ReturnType<typeof render>): number => {
        const fixed = fixedLocal(blocks);
        if (mass(fixed) > limit) return -1;
        let lo = 0;
        let hi = 1;
        while (mass(fixed + hi) <= limit) {
            lo = hi;
            hi *= 2;
        }
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (mass(fixed + mid) <= limit) lo = mid;
            else hi = mid;
        }
        return Math.max(0, lo - FIT_SLACK_TOKENS);
    };
    const accept = (refs: number, memoryCount: number, seedCount: number, chunkTokens: number) => ({
        ok: true as const,
        guarded: true,
        chunkTokens,
        roomTokens: Math.max(chunkTokens, roomFor(render(refs, memoryCount, seedCount))),
        ...render(refs, memoryCount, seedCount),
        trimmed:
            refs < references.length || memoryCount < memories.length || seedCount < seeds.length,
        kept: kept(refs, memoryCount, seedCount),
    });

    // 1. Diverse compartments first, then recent compartments oldest first.
    for (let refs = references.length; refs >= 0; refs -= 1) {
        if (roomFor(render(refs, memories.length, seeds.length)) >= requested) {
            return accept(refs, memories.length, seeds.length, requested);
        }
    }
    // 2. Project-memory lines, lowest priority dropped first. Fewer lines never
    //    need more room, so binary-search the longest prefix that fits.
    if (memories.length > 0 && roomFor(render(0, 0, seeds.length)) >= requested) {
        let lo = 0;
        let hi = memories.length;
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (roomFor(render(0, mid, seeds.length)) >= requested) lo = mid;
            else hi = mid;
        }
        return accept(0, lo, seeds.length, requested);
    }
    // 3. Seed examples.
    for (let seedCount = seeds.length; seedCount >= 0; seedCount -= 1) {
        if (roomFor(render(0, 0, seedCount)) >= requested) {
            return accept(0, 0, seedCount, requested);
        }
    }
    // 4. Everything trimmed: the chunk takes whatever room is left.
    const floor = Math.min(requested, HISTORIAN_MIN_FIT_CHUNK_TOKENS);
    const room = roomFor(render(0, 0, 0));
    if (room >= floor && room > 0) return accept(0, 0, 0, Math.min(requested, room));

    // The refusal reason is what callers back off on, so it must not move as the
    // session grows: count the fixed parts with a constant header, not the
    // chunk's ordinals.
    const fixedTokens = mass(fixedLocal(render(0, 0, 0), "Messages 1-1:\n\n"));
    return {
        ok: false,
        reason: `producer_prompt_unfit model=${args.window.modelKey ?? "unknown"} limit=${limit} fixed_tokens=${fixedTokens} min_chunk_tokens=${floor}`,
    };
}

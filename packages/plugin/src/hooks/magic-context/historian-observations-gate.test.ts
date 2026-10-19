import { expect, test } from "bun:test";
import { parsePluginConfig } from "../../config";
import { isDreamerRunnable } from "../../config/agent-disable";
import {
    userMemoryCollectionEnabled,
    userObservationCollectionEnabled,
    userObservationsRequested,
} from "../../features/magic-context/dreamer/task-config";
import { buildCompartmentAgentPrompt } from "./compartment-prompt";

// The historian is told to skip <user_observations> only when the dreamer is not
// runnable, because review-user-memories (a dreamer task) is the only reader.
// With a runnable dreamer the prompt must stay byte-identical to the one built
// without the flag at all, which is the code path that existed before it.

const DIRECTIVE =
    "<user_observation_extraction>disabled</user_observation_extraction>\nUser-memory review is not running (the dreamer is disabled): do NOT emit a <user_observations> block.";

function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const DREAMERS = [
    undefined,
    {},
    { disable: false },
    { disable: true },
    { tasks: { "review-user-memories": { schedule: "" } } },
    { disable: true, tasks: { "review-user-memories": { schedule: "" } } },
    { tasks: { "review-user-memories": { schedule: "0 4 * * *" } } },
];

test("historian prompt is unchanged with a runnable dreamer and gains only the skip directive without one", () => {
    const next = prng(4715);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T;
    let runnable = 0;
    let gated = 0;
    for (let index = 0; index < 240; index++) {
        const dreamer = pick(DREAMERS);
        const memory = pick([undefined, { enabled: true }, { enabled: false }]);
        const config = parsePluginConfig({
            ...(dreamer ? { dreamer: structuredClone(dreamer) } : {}),
            ...(memory ? { memory } : {}),
        });
        const inputs = {
            seedExamples: pick([
                "",
                "<compartment_examples_from_other_projects>\nx\n</compartment_examples_from_other_projects>",
            ]),
            sessionReferences: pick(["", "<session_references>\ny\n</session_references>"]),
            projectMemory: pick(["", "<project-memory>\nz\n</project-memory>"]),
            inputSource: `Messages ${index}-${index + 3}:\n\n[${index}] U: case ${index}`,
            memoryEnabled: config.memory.enabled,
            extractionFree: next() < 0.2,
        };
        const before = buildCompartmentAgentPrompt(inputs);
        const after = buildCompartmentAgentPrompt({
            ...inputs,
            userObservationsRequested: userObservationsRequested(config.dreamer),
        });
        if (isDreamerRunnable(config) || inputs.extractionFree) {
            if (isDreamerRunnable(config)) runnable++;
            expect(after).toBe(before);
            continue;
        }
        gated++;
        expect(after).toBe(before.replace("<new_messages>", `${DIRECTIVE}\n\n<new_messages>`));
        expect(after.split(DIRECTIVE)).toHaveLength(2);
    }
    expect(runnable).toBeGreaterThanOrEqual(80);
    expect(gated).toBeGreaterThanOrEqual(40);
});

test("historian observation collection needs both the review schedule and a runnable dreamer", () => {
    for (const dreamer of DREAMERS) {
        const config = parsePluginConfig(dreamer ? { dreamer: structuredClone(dreamer) } : {});
        const scheduled = userMemoryCollectionEnabled(config.dreamer);
        expect(userObservationCollectionEnabled(config.dreamer)).toBe(
            scheduled && isDreamerRunnable(config),
        );
        expect(userObservationsRequested(config.dreamer)).toBe(isDreamerRunnable(config));
    }
    // The default review schedule is non-empty, so a disabled dreamer alone is
    // what used to leave collection on.
    const disabled = parsePluginConfig({ dreamer: { disable: true } });
    expect(userMemoryCollectionEnabled(disabled.dreamer)).toBe(true);
    expect(userObservationCollectionEnabled(disabled.dreamer)).toBe(false);
});

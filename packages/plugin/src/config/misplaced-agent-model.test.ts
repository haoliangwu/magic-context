/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { resolveHistorianModel } from "../shared/model-resolution";
import { misplacedAgentModelWarnings, parsePluginConfig } from "./index";

/**
 * A bare `historian.model` is schema-valid, reads naturally, and resolves to
 * nothing. These tests pin both halves: that the resolver really does ignore it,
 * and that the loader now says so instead of leaving the user with a subsystem
 * that looks configured and never runs.
 */
describe("misplaced agent model warning", () => {
    it("is what a top-level historian.model actually resolves to", () => {
        // The premise, asserted rather than assumed: if this ever starts
        // resolving, the warning below becomes wrong and should be deleted.
        expect(resolveHistorianModel({ historian: { model: "openai/gpt-5" } }, "opencode")).toEqual(
            {
                primary: undefined,
                fallbacks: [],
            },
        );
    });

    it("warns when the model sits outside every harness block", () => {
        const warnings = misplacedAgentModelWarnings({ historian: { model: "openai/gpt-5" } });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("historian.model is not read");
        expect(warnings[0]).toContain("historian.opencode.model");
    });

    it("stays quiet when a harness block carries the model", () => {
        expect(
            misplacedAgentModelWarnings({
                historian: { model: "openai/gpt-5", opencode: { model: "openai/gpt-5" } },
            }),
        ).toEqual([]);
        expect(
            misplacedAgentModelWarnings({ historian: { opencode: { model: "openai/gpt-5" } } }),
        ).toEqual([]);
        expect(misplacedAgentModelWarnings({})).toEqual([]);
        expect(misplacedAgentModelWarnings({ historian: { disable: true } })).toEqual([]);
    });

    it("covers the dreamer on the same rule", () => {
        const warnings = misplacedAgentModelWarnings({ dreamer: { model: "openai/gpt-5" } });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("dreamer.model is not read");
    });

    it("reaches the pinned config-warning channel", () => {
        // configWarnings is what /ctx-status, the Pi session-start notice and
        // doctor read, so landing here is what makes the warning visible.
        const parsed = parsePluginConfig({ historian: { model: "openai/gpt-5" } });
        expect(
            (parsed.configWarnings ?? []).some((warning) =>
                warning.includes("historian.model is not read"),
            ),
        ).toBe(true);
    });
});

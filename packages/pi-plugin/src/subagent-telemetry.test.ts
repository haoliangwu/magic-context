import { describe, expect, it } from "bun:test";
import { buildHiddenAgentRegistrations } from "@magic-context/core/agents/hidden-agent-registrations";
import {
	promptFingerprint,
	SubagentTelemetry,
	subagentStepCap,
} from "./subagent-telemetry";

describe("subagent telemetry", () => {
	it("uses the OpenCode cap for every historian and dreamer task", () => {
		for (const registration of buildHiddenAgentRegistrations({
			dreamerPrompt: undefined,
			historianPrompt: undefined,
			historianEditorPrompt: undefined,
			historianDisallowed: [],
		})) {
			expect(subagentStepCap(registration.id)).toBe(registration.maxSteps);
		}
		expect(subagentStepCap("magic-context-historian")).toBe(
			subagentStepCap("historian"),
		);
		expect(subagentStepCap("magic-context-dreamer")).toBe(
			subagentStepCap("dreamer"),
		);
		expect(subagentStepCap("unknown")).toBeUndefined();
	});

	it("reports extension provenance without retaining prompt contents", () => {
		const lines: string[] = [];
		const telemetry = new SubagentTelemetry("private system", (line) =>
			lines.push(line),
		);
		telemetry.observe({
			type: "mc_system_prompt",
			...promptFingerprint("private system plus hints"),
			containsIntended: true,
		});
		telemetry.finish("historian", "completed", 40);
		expect(lines[0]).toStartWith("subagent_system_prompt_extended ");
		expect(lines.join("")).not.toContain("private system");
	});

	it("counts agent-end-only steps once and keeps missing usage unknown", () => {
		const telemetry = new SubagentTelemetry("system", () => {});
		const event = {
			type: "agent_end",
			messages: [
				{ role: "user" },
				{ role: "assistant", content: [] },
				{ role: "assistant", content: [] },
			],
		};
		telemetry.observe(event);
		telemetry.observe(event);
		expect(telemetry.steps).toBe(2);
		expect(telemetry.promptTokens).toEqual({
			first: null,
			last: null,
			max: null,
		});
	});
});

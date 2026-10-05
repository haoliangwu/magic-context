import { expect, test } from "bun:test";
import { classifyContentionTurn } from "./contention-turn-outcome";

test("HTTP acceptance without a provider call cannot count as a successful contention turn", () => {
	expect(classifyContentionTurn("", 0, "succeeded").result).not.toBe(
		"provider-succeeded",
	);
	expect(classifyContentionTurn("", 1, "failed").result).not.toBe(
		"provider-succeeded",
	);
	expect(classifyContentionTurn("", 1, "succeeded").result).toBe(
		"provider-succeeded",
	);
});
test("contention classification recognizes current and legacy refusal wording and validated replay", () => {
	for (const line of [
		"storage-busy refusal stage=messages-transform",
		"v2 refusal: interrupting the turn before the provider request arm=storage-busy",
		"refusing this turn before the model call",
	])
		expect(classifyContentionTurn(line, 0, "failed").refused).toBe(true);
	expect(classifyContentionTurn("lkg_replay_served", 1, "succeeded")).toEqual({
		refused: false,
		replay: true,
		result: "provider-succeeded",
	});
});

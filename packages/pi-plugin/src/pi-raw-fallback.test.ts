import { expect, it } from "bun:test";
import { assertPiRawFallbackFits } from "./pi-raw-fallback";

it("Pi refuses incomplete fallback even when the byte proxy fits", () => {
	expect(() =>
		assertPiRawFallbackFits(
			[{ role: "user", content: "hello" }],
			20000,
			() => {},
			null,
		),
	).toThrow();
});
it("Pi admits a complete calibrated fallback and refuses the locally fitting over-wall request", () => {
	const messages = [{ role: "user", content: "hello" }];
	const observed = {
		modelKey: "anthropic/claude-fable-5-1",
		systemTokens: 10000,
		toolDefinitionTokens: 0,
	};
	expect(() =>
		assertPiRawFallbackFits(messages, 20000, () => {}, null, observed),
	).not.toThrow();
	expect(() =>
		assertPiRawFallbackFits(messages, 12000, () => {}, null, observed),
	).toThrow();
});

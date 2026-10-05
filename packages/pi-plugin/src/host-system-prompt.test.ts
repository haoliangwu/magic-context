import { describe, expect, it } from "bun:test";
import { readHostSystemPrompt } from "./host-system-prompt";

describe("readHostSystemPrompt", () => {
	it("returns Pi's single string unchanged", () => {
		expect(readHostSystemPrompt({ getSystemPrompt: () => "one prompt" })).toBe(
			"one prompt",
		);
	});

	it("joins Oh My Pi's prompt segments", () => {
		expect(
			readHostSystemPrompt({ getSystemPrompt: () => ["contract", "context"] }),
		).toBe("contract\n\ncontext");
	});

	it("rejects missing or malformed prompts", () => {
		expect(readHostSystemPrompt({})).toBeUndefined();
		expect(
			readHostSystemPrompt({ getSystemPrompt: () => undefined }),
		).toBeUndefined();
		expect(
			readHostSystemPrompt({ getSystemPrompt: () => ["a", 1] }),
		).toBeUndefined();
	});
});

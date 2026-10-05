import { afterEach, expect, test } from "bun:test";
import { runPiDebugAssertion } from "./debug-assertions-pi";

const original = process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS;
const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => {
	if (original === undefined) delete process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS;
	else process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS = original;
	if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
	else process.env.NODE_ENV = originalNodeEnv;
});

test("Pi debug assertions do not walk content without explicit opt-in", () => {
	for (const nodeEnv of [undefined, "test", "development", "production"]) {
		if (nodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = nodeEnv;
		for (const value of [undefined, "", "0", "false"]) {
			if (value === undefined)
				delete process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS;
			else process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS = value;
			let calls = 0;
			runPiDebugAssertion(() => {
				calls++;
			});
			expect(calls).toBe(0);
		}
	}
});

test("Pi explicit debug opt-in still detects last-writer drift in production", () => {
	process.env.NODE_ENV = "production";
	process.env.MAGIC_CONTEXT_DEBUG_ASSERTIONS = "1";
	expect(() =>
		runPiDebugAssertion(() => {
			throw new Error("last-writer drift");
		}),
	).toThrow("last-writer drift");
	expect(() => runPiDebugAssertion(undefined)).not.toThrow();
});

import { afterEach, describe, expect, it, spyOn } from "bun:test";

import * as loggerModule from "@magic-context/core/shared/logger";

import { __test } from "./index";

afterEach(() => {
	__test.resetLoggedPiConfigDirs();
});

describe("Pi config load logging", () => {
	it("dedupes /cd config warnings per directory", () => {
		const logSpy = spyOn(loggerModule, "log").mockImplementation(
			() => undefined,
		);
		try {
			__test.logPiConfigLoad({
				dir: "/tmp/project-a",
				loadedFromPaths: ["/tmp/project-a/.cortexkit/magic-context.jsonc"],
				warnings: ["Ignoring historian.model from project config"],
				dedupe: true,
			});
			__test.logPiConfigLoad({
				dir: "/tmp/project-a",
				loadedFromPaths: ["/tmp/project-a/.cortexkit/magic-context.jsonc"],
				warnings: ["Ignoring historian.model from project config"],
				dedupe: true,
			});
			__test.logPiConfigLoad({
				dir: "/tmp/project-b",
				loadedFromPaths: [],
				warnings: ["Ignoring execute_threshold_percentage from project config"],
				dedupe: true,
			});

			const messages = logSpy.mock.calls.map(([message]) => String(message));
			expect(
				messages.filter((message) => message.includes("config loaded from:")),
			).toHaveLength(1);
			expect(
				messages.filter((message) =>
					message.includes(
						"config: no magic-context.jsonc found, using schema defaults",
					),
				),
			).toHaveLength(1);
			expect(
				messages.filter((message) =>
					message.includes("Ignoring historian.model from project config"),
				),
			).toHaveLength(1);
			expect(
				messages.filter((message) =>
					message.includes(
						"Ignoring execute_threshold_percentage from project config",
					),
				),
			).toHaveLength(1);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("surfaces the protected_tokens below-minimum warning through the config load log", () => {
		const logSpy = spyOn(loggerModule, "log").mockImplementation(
			() => undefined,
		);
		try {
			__test.logPiConfigLoad({
				dir: "/tmp/project-belowmin",
				loadedFromPaths: [
					"/tmp/project-belowmin/.cortexkit/magic-context.jsonc",
				],
				warnings: [
					"protected_tokens is a token floor (minimum 4000, default derived from the context window); 20 looks like the old protected_tags count. Remove the key to use the default, or set a token count such as 16000.",
				],
				dedupe: true,
			});

			const messages = logSpy.mock.calls.map(([message]) => String(message));
			expect(
				messages.some((message) =>
					message.includes("protected_tokens is a token floor"),
				),
			).toBe(true);
			expect(
				messages.some((message) =>
					message.includes("20 looks like the old protected_tags count"),
				),
			).toBe(true);
		} finally {
			logSpy.mockRestore();
		}
	});
});

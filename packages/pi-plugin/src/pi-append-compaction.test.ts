import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as logger from "@magic-context/core/shared/logger";
import { adaptPiAppendCompaction } from "./pi-append-compaction";
import { __setPiHarnessKindForTesting } from "./pi-harness-kind";

const details = { source: "magic-context", lastCompactedOrdinal: 2 };
const stored = { type: "compaction", firstKeptEntryId: "kept", details };

function piHost() {
	return {
		// Pi 0.83.0, 0.86.0, 0.87.1 and 1.3.0: dist/core/session-manager.js.
		appendCompaction: mock(function (
			this: unknown,
			_summary: unknown,
			_firstKeptEntryId: unknown,
			_tokensBefore: unknown,
			_details: unknown,
			_fromHook: unknown,
			_usage: unknown,
		) {
			return "marker";
		}),
		getEntry: mock((_id: string): unknown => stored),
	};
}

function ompHost() {
	return {
		// OMP 18.2.6: src/session/session-manager.ts:2858; 18.12.3:3547.
		appendCompaction: mock(function (
			this: unknown,
			_summary: unknown,
			_shortSummary: unknown,
			_firstKeptEntryId: unknown,
			_tokensBefore: unknown,
			_options: unknown = {},
		) {
			return "marker";
		}),
		getEntry: mock((_id: string): unknown => stored),
	};
}

function omp17Host() {
	return {
		// OMP 17.1.7: src/session/session-manager.ts:1951-1959 (no defaults).
		appendCompaction: mock(function (
			this: unknown,
			_summary: unknown,
			_shortSummary: unknown,
			_firstKeptEntryId: unknown,
			_tokensBefore: unknown,
			_details: unknown,
			_fromExtension: unknown,
			_preserveData: unknown,
		) {
			return "marker";
		}),
		getEntry: mock((_id: string): unknown => stored),
	};
}

afterEach(() => __setPiHarnessKindForTesting(undefined));

describe("host compaction binding", () => {
	it("passes the supported Pi length-5 signature through unchanged", () => {
		__setPiHarnessKindForTesting("pi");
		const host = {
			// Pi 0.74.0 dist/core/session-manager.js:617; also Pi 0.80.2:717.
			appendCompaction: mock(
				(
					_summary: unknown,
					_firstKeptEntryId: unknown,
					_tokensBefore: unknown,
					_details: unknown,
					_fromHook: unknown,
				) => "marker",
			),
			getEntry: mock((_id: string) => stored),
		};
		expect(host.appendCompaction.length).toBe(5);
		expect(
			adaptPiAppendCompaction(host)?.("summary", "kept", 200, details, true),
		).toBe("marker");
		expect(host.appendCompaction).toHaveBeenCalledWith(
			"summary",
			"kept",
			200,
			details,
			true,
		);
		expect(host.getEntry).toHaveBeenCalledWith("marker");
		__setPiHarnessKindForTesting("omp");
		expect(adaptPiAppendCompaction(host)).toBeUndefined();
	});
	it("passes Pi arguments through unchanged and reads the returned entry id", () => {
		__setPiHarnessKindForTesting("pi");
		const host = piHost();
		expect(host.appendCompaction.length).toBe(6);
		expect(
			adaptPiAppendCompaction(host)?.("summary", "kept", 200, details, true),
		).toBe("marker");
		expect(host.appendCompaction).toHaveBeenCalledWith(
			"summary",
			"kept",
			200,
			details,
			true,
		);
		expect(host.appendCompaction.mock.contexts[0]).toBe(host);
		expect(host.getEntry).toHaveBeenCalledWith("marker");
	});

	it("translates OMP arguments including the empty shortSummary and extension options", () => {
		__setPiHarnessKindForTesting("omp");
		const host = ompHost();
		expect(host.appendCompaction.length).toBe(4);
		expect(
			adaptPiAppendCompaction(host)?.("summary", "kept", 200, details, true),
		).toBe("marker");
		expect(host.appendCompaction).toHaveBeenCalledWith(
			"summary",
			undefined,
			"kept",
			200,
			{ details, fromExtension: true },
		);
		expect(host.appendCompaction.mock.contexts[0]).toBe(host);
		expect(host.getEntry).toHaveBeenCalledWith("marker");
	});

	it("refuses a detection/arity disagreement in either direction and logs once", async () => {
		const modulePath = "./pi-append-compaction.ts?isolated-arity-warning";
		const { adaptPiAppendCompaction: adapt } = await import(modulePath);
		const log = spyOn(logger, "log").mockImplementation(() => undefined);
		try {
			const pi = piHost();
			const omp = ompHost();
			for (let pass = 0; pass < 2; pass++) {
				__setPiHarnessKindForTesting("omp");
				expect(adapt(pi)).toBeUndefined();
				__setPiHarnessKindForTesting("pi");
				expect(adapt(omp)).toBeUndefined();
				expect(adapt({ appendCompaction: () => "marker" })).toBeUndefined();
			}
			expect(pi.appendCompaction).not.toHaveBeenCalled();
			expect(omp.appendCompaction).not.toHaveBeenCalled();
			expect(log).toHaveBeenCalledTimes(1);
			expect(log.mock.calls[0]?.[0]).toContain("leaving marker pending");
		} finally {
			log.mockRestore();
		}
	});

	it("translates OMP 17 positional details and extension arguments", () => {
		__setPiHarnessKindForTesting("omp");
		const host = omp17Host();
		expect(host.appendCompaction.length).toBe(7);
		expect(
			adaptPiAppendCompaction(host)?.("summary", "kept", 200, details, true),
		).toBe("marker");
		expect(host.appendCompaction).toHaveBeenCalledWith(
			"summary",
			undefined,
			"kept",
			200,
			details,
			true,
		);
		expect(host.getEntry).toHaveBeenCalledWith("marker");
		__setPiHarnessKindForTesting("pi");
		expect(adaptPiAppendCompaction(host)).toBeUndefined();
	});

	it.each([
		["boundary", { ...stored, firstKeptEntryId: 200 }],
		["ownership", { ...stored, details: {} }],
		["missing entry", undefined],
	])("latches a read-back %s mismatch across rebinding without another append", (_name, entry) => {
		__setPiHarnessKindForTesting("pi");
		const host = piHost();
		host.getEntry.mockImplementation(() => entry);
		const log = spyOn(logger, "log").mockImplementation(() => undefined);
		try {
			const append = adaptPiAppendCompaction(host)!;
			for (let pass = 0; pass < 3; pass++) {
				expect(() => append("summary", "kept", 200, details, true)).toThrow(
					"read-back failed",
				);
				expect(adaptPiAppendCompaction(host)).toBeUndefined();
			}
			expect(host.appendCompaction).toHaveBeenCalledTimes(1);
			expect(host.getEntry).toHaveBeenCalledWith("marker");
			expect(log).toHaveBeenCalledTimes(1);
		} finally {
			log.mockRestore();
		}
	});

	it("latches a read-back exception without retrying the already persisted write", () => {
		__setPiHarnessKindForTesting("omp");
		const host = ompHost();
		host.getEntry.mockImplementation(() => {
			throw new Error("private transcript");
		});
		const append = adaptPiAppendCompaction(host)!;
		for (let pass = 0; pass < 2; pass++) {
			expect(() => append("summary", "kept", 200, details, true)).toThrow(
				"read-back failed",
			);
			expect(adaptPiAppendCompaction(host)).toBeUndefined();
		}
		expect(host.appendCompaction).toHaveBeenCalledTimes(1);
	});
});

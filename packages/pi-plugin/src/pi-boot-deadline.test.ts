import { describe, expect, it } from "bun:test";

import {
	bootPiRuntimeWithDeadline,
	type PiFailClosedRegistration,
} from "./pi-boot-deadline";

type TestDb = { id: string };
type TestReason = { kind: "storage_failure"; cause: string };

describe("Pi runtime boot deadline", () => {
	it("returns at the deadline, reuses the in-flight open, and adopts its late result", async () => {
		let resolveOpen!: (value: TestDb | null) => void;
		let openCalls = 0;
		let runtimeStarts = 0;
		let registration: PiFailClosedRegistration<TestDb, TestReason> | undefined;
		const db = { id: "late-db" };

		const boot = bootPiRuntimeWithDeadline<TestDb, TestReason>({
			deadlineMs: 10,
			openStorage: () => {
				openCalls += 1;
				return new Promise((resolve) => {
					resolveOpen = resolve;
				});
			},
			startRuntime: async (value) => {
				expect(value).toBe(db);
				runtimeStarts += 1;
			},
			unavailableReason: () => ({
				kind: "storage_failure",
				cause: "unavailable",
			}),
			deadlineReason: {
				kind: "storage_failure",
				cause: "deadline",
			},
			registerFailClosed: (value) => {
				registration = value;
				return {
					adoptRecovered: async (lateDb) => {
						await value.onRecovered(lateDb);
						return true;
					},
				};
			},
			report: () => {},
		});

		const observed = await boot;
		expect(observed.status).toBe("timed_out");
		expect(registration?.reason).toEqual({
			kind: "storage_failure",
			cause: "deadline",
		});

		const sharedPendingOpen = registration?.tryReopen();
		resolveOpen(db);
		await expect(sharedPendingOpen).resolves.toBe(db);
		if (observed.status === "timed_out") {
			await expect(observed.lateAdoption).resolves.toBe(true);
		}
		expect(openCalls).toBe(1);
		expect(runtimeStarts).toBe(1);
	});

	it("starts immediately after a completed open without a fail-closed surface", async () => {
		const db = { id: "ready-db" };
		let registered = false;
		let startedWith: TestDb | undefined;
		const result = await bootPiRuntimeWithDeadline<TestDb, TestReason>({
			deadlineMs: 100,
			openStorage: async () => db,
			startRuntime: async (value) => {
				startedWith = value;
			},
			unavailableReason: () => ({
				kind: "storage_failure",
				cause: "unavailable",
			}),
			deadlineReason: {
				kind: "storage_failure",
				cause: "deadline",
			},
			registerFailClosed: () => {
				registered = true;
				return { adoptRecovered: async () => true };
			},
			report: () => {},
		});

		expect(result).toEqual({ status: "ready" });
		expect(startedWith).toBe(db);
		expect(registered).toBe(false);
	});
});

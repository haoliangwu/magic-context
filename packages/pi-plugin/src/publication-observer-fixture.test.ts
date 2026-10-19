/// <reference types="bun" />
import { expect, spyOn } from "bun:test";
import * as persistence from "@magic-context/core/hooks/magic-context/lkg-persist";
import * as logger from "@magic-context/core/shared/logger";
import {
	type PiTransformTimingSample,
	setPiTransformTimingObserver,
} from "./context-perf-hooks";

/** Observe real publication writes, warning lines and per-pass counters without replacing their behavior. */
export function observePiPublicationForTest(sessionId: string) {
	const samples: PiTransformTimingSample[] = [];
	const restoreTiming = setPiTransformTimingObserver((sample) => {
		if (sample.sessionId === sessionId && sample.publication)
			samples.push(sample);
	});
	const log = spyOn(logger, "sessionLog");
	const save = spyOn(persistence, "saveLkgSlotToDb");
	return {
		samples,
		reset() {
			samples.length = 0;
			log.mockClear();
			save.mockClear();
		},
		expect(
			status: NonNullable<PiTransformTimingSample["publication"]>["status"],
			reason: string,
			passes: number,
			lkgWrites = 0,
		) {
			expect(samples.map((sample) => sample.publication)).toEqual(
				Array.from({ length: passes }, () => ({ status, reason, count: 1 })),
			);
			expect(
				log.mock.calls.filter(
					([id, line]) =>
						id === sessionId &&
						typeof line === "string" &&
						line.startsWith(`Pi publication ${status} reason=${reason};`),
				),
			).toHaveLength(1);
			expect(save.mock.calls.filter(([, id]) => id === sessionId)).toHaveLength(
				lkgWrites,
			);
		},
		restore() {
			save.mockRestore();
			log.mockRestore();
			restoreTiming();
		},
	};
}

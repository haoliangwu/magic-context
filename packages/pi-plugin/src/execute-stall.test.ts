import { expect, test } from "bun:test";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage";
import { readExecuteReclaimState } from "@magic-context/core/hooks/magic-context/execute-reclaim";
import { __test } from "./context-handler";
import { rideHarness } from "./deferred-ride-evidence.test";

test("pi floor stall marks, holds, fires next pass and drains in one publication rebuild", async () => {
	const h = rideHarness(true, "floor");
	let rebuilds = 0;
	const restore = __test.setPipelineResultObserverForTests((id, result) => {
		if (id === h.id && result.bustedThisPass) rebuilds++;
	});
	const originalEnv = process.env.NODE_ENV;
	try {
		process.env.NODE_ENV = "production";
		const warm = await h.pass(40);
		const initialBusts = rebuilds;
		h.queue();
		expect(await h.pass(76)).toEqual(warm);
		expect(readExecuteReclaimState(h.db, h.id).floorPromptId).toBe("entry-2");
		expect(h.historianRuns).toBe(0);
		expect(getPendingOps(h.db, h.id)).toHaveLength(1);
		expect(await h.pass(77)).toEqual(warm);
		expect(readExecuteReclaimState(h.db, h.id).floorOrdinal).toBeNull();
		expect(rebuilds).toBe(initialBusts);
		await h.finishHistorian();
		expect(h.historianRuns).toBeGreaterThan(0);
		const published = await h.pass(79);
		expect(published).not.toEqual(warm);
		expect(getPendingOps(h.db, h.id)).toHaveLength(0);
		expect(rebuilds - initialBusts).toBe(1);
		expect(await h.pass(40)).toEqual(published);
	} finally {
		await h.finishHistorian();
		if (originalEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = originalEnv;
		restore();
		h.close();
	}
});

test("pi worth bound holds tiny queue twice then reclaims once without a historian", async () => {
	const h = rideHarness(true, "small");
	let rebuilds = 0;
	const restore = __test.setPipelineResultObserverForTests((id, result) => {
		if (id === h.id && result.bustedThisPass) rebuilds++;
	});
	try {
		const warm = await h.pass(40);
		const initialBusts = rebuilds;
		h.queue();
		expect(await h.pass(76)).toEqual(warm);
		expect(await h.pass(77)).toEqual(warm);
		expect(readExecuteReclaimState(h.db, h.id).heldPasses).toBe(2);
		const reclaimed = await h.pass(79);
		expect(reclaimed).not.toEqual(warm);
		expect(getPendingOps(h.db, h.id)).toHaveLength(0);
		expect(rebuilds - initialBusts).toBe(1);
		expect(await h.pass(78)).toEqual(reclaimed);
		expect(rebuilds - initialBusts).toBe(1);
	} finally {
		restore();
		h.close();
	}
});

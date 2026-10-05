import { describe, expect, it } from "bun:test";
import {
    canConsumeDeferredOnThisPass,
    hasReclaimRide,
    type ReclaimRideSignals,
    reclaimRideLabel,
} from "./cache-busting-signals";

/**
 * `canConsumeDeferredOnThisPass` is the mid-turn-aware gate that decides whether
 * a deferred publication signal (deferred history refresh / materialization) may
 * be consumed on THIS transform pass. It takes the MID-TURN-ADJUSTED scheduler
 * decision, so a deferred publish that lands mid-turn (decision downgraded to
 * "defer") is NOT consumed until the next non-mid-turn execute/force pass. Pi
 * now mirrors this exact logic (it previously read the raw deferred-set
 * membership, draining mid-turn where OpenCode stayed deferred).
 */
describe("canConsumeDeferredOnThisPass", () => {
    it("defers when mid-turn (decision=defer) and below force threshold", () => {
        expect(
            canConsumeDeferredOnThisPass({
                schedulerDecision: "defer",
                contextPercentage: 50,
                justAwaitedPublication: false,
                activeRunBlocksMaterialization: false,
            }),
        ).toBe(false);
    });

    it("consumes on an execute pass", () => {
        expect(
            canConsumeDeferredOnThisPass({
                schedulerDecision: "execute",
                contextPercentage: 70,
                justAwaitedPublication: false,
                activeRunBlocksMaterialization: false,
            }),
        ).toBe(true);
    });

    it("consumes mid-turn only at the resolved force-materialization band", () => {
        const input = {
            schedulerDecision: "defer" as const,
            justAwaitedPublication: false,
            activeRunBlocksMaterialization: false,
            forceMaterializationPercentage: 92,
        };
        expect(canConsumeDeferredOnThisPass({ ...input, contextPercentage: 91 })).toBe(false);
        expect(canConsumeDeferredOnThisPass({ ...input, contextPercentage: 92 })).toBe(true);
    });

    it("always consumes right after awaiting a publication (inline await path)", () => {
        expect(
            canConsumeDeferredOnThisPass({
                schedulerDecision: "defer",
                contextPercentage: 10,
                justAwaitedPublication: true,
                activeRunBlocksMaterialization: false,
            }),
        ).toBe(true);
    });

    it("consumes published work despite an active historian below force threshold", () => {
        expect(
            canConsumeDeferredOnThisPass({
                schedulerDecision: "execute",
                contextPercentage: 70,
                justAwaitedPublication: false,
                activeRunBlocksMaterialization: true,
            }),
        ).toBe(true);
    });
});

/**
 * The logs that announce the mutation permission must name the signal that
 * granted it. They used to print "scheduler_execute" on every pass that reached
 * the fall-through, including passes where the scheduler had decided to defer
 * and the real grant was freshly published history.
 */
describe("reclaimRideLabel", () => {
    const noRide: ReclaimRideSignals = {
        hardFold: false,
        force: false,
        explicitFlush: false,
        publishedHistory: false,
    };

    it("gives two passes with different true rides two different labels", () => {
        const publishedHistoryPass = reclaimRideLabel({ ...noRide, publishedHistory: true });
        const forcePass = reclaimRideLabel({ ...noRide, force: true });

        expect(publishedHistoryPass).toBe("ride=publishedHistory");
        expect(forcePass).toBe("ride=force");
        expect(publishedHistoryPass).not.toBe(forcePass);
    });

    it("names every true ride when more than one granted the pass", () => {
        expect(reclaimRideLabel({ ...noRide, hardFold: true, publishedHistory: true })).toBe(
            "ride=hardFold+publishedHistory",
        );
        expect(
            reclaimRideLabel({
                hardFold: true,
                force: true,
                explicitFlush: true,
                publishedHistory: true,
            }),
        ).toBe("ride=hardFold+force+explicitFlush+publishedHistory");
    });

    it("labels each single ride distinctly and says none when there is no permission", () => {
        const labels = (["hardFold", "force", "explicitFlush", "publishedHistory"] as const).map(
            (ride) => reclaimRideLabel({ ...noRide, [ride]: true }),
        );

        expect(new Set(labels).size).toBe(labels.length);
        expect(reclaimRideLabel(noRide)).toBe("ride=none");
        expect(hasReclaimRide(noRide)).toBe(false);
    });

    it("names the subagent execute permission without inventing a primary ride", () => {
        expect(hasReclaimRide({ ...noRide, subagentExecute: true })).toBe(true);
        expect(reclaimRideLabel({ ...noRide, subagentExecute: true })).toBe("ride=subagentExecute");
        expect(hasReclaimRide({ ...noRide, subagentExecute: false })).toBe(false);
    });
});

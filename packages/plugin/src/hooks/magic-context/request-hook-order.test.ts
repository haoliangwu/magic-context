/// <reference types="bun-types" />
import { describe, expect, it } from "bun:test";
import { createRequestHookOrder } from "./request-hook-order";

const history = [
    { info: { id: "msg_0001", role: "user" } },
    { info: { id: "msg_0002", role: "assistant" } },
    { info: { id: "msg_0003", role: "user" } },
];

describe("request hook order", () => {
    it("reports messages-first when the system hook follows its own messages pass", () => {
        const order = createRequestHookOrder();
        order.messagesPrepared("s", history);
        expect(order.consumeMessagesPrepared("s")).toBe(true);
        // Consumed: a second system call for the same request does not see it again.
        expect(order.consumeMessagesPrepared("s")).toBe(false);
    });

    it("clears the marker when a newer reply completes between the messages pass and the system hook", () => {
        const order = createRequestHookOrder();
        expect(order.consumeMessagesPrepared("s")).toBe(false);
        order.messagesPrepared("s", history);
        // The reply to the prepared request is newer than every assistant it saw.
        order.assistantCompleted("s", "msg_0004");
        expect(order.consumeMessagesPrepared("s")).toBe(false);
    });

    it("ignores a late completion event for a reply the messages pass already saw", () => {
        const order = createRequestHookOrder();
        order.messagesPrepared("s", history);
        order.assistantCompleted("s", "msg_0002");
        expect(order.consumeMessagesPrepared("s")).toBe(true);
    });

    it("treats a completion without a comparable id as a reply", () => {
        const order = createRequestHookOrder();
        order.messagesPrepared("s", history);
        order.assistantCompleted("s", undefined);
        expect(order.consumeMessagesPrepared("s")).toBe(false);
    });

    // Pins a known limitation, not a desired behaviour. The marker is session-keyed
    // and has no request identity. On a system-first host, request A's messages pass
    // sets it, A ends without a completed-assistant event (or the event is late), and
    // request B's system hook, which runs BEFORE B's messages transform, still reads
    // true. That is why the helper is wired only into stock OpenCode 1, where the
    // messages transform runs before the system hook for every main request. Wiring
    // it into a system-first host needs a seam that ties both hooks to one request;
    // when such a seam exists, this test should flip to expect false.
    it("LIMITATION: without a request-correlation seam, an unfinished previous request makes a system-first request look messages-final", () => {
        const order = createRequestHookOrder();
        // system(A) on a system-first host: no messages pass yet.
        expect(order.consumeMessagesPrepared("s")).toBe(false);
        // messages(A) runs; A then ends with no completion event observed.
        order.messagesPrepared("s", [{ info: { id: "msg_0002", role: "assistant" } }]);
        // system(B) runs before messages(B), yet the stale marker reads true.
        expect(order.consumeMessagesPrepared("s")).toBe(true);
    });

    it("keeps sessions apart and forgets cleared sessions", () => {
        const order = createRequestHookOrder();
        order.messagesPrepared("a", history);
        order.messagesPrepared("b", history);
        order.assistantCompleted("a", "msg_0009");
        order.clearSession("b");
        expect(order.consumeMessagesPrepared("a")).toBe(false);
        expect(order.consumeMessagesPrepared("b")).toBe(false);
    });
});

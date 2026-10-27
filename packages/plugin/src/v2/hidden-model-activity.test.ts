import { expect, test } from "bun:test";
import { HiddenModelActivity } from "./hidden-model-activity";

test("OpenCode 2 output events are child-scoped and watchers are removed after an attempt", () => {
    const activity = new HiddenModelActivity();
    let received = 0;
    const stop = activity.watch("child", () => received++);
    for (const type of [
        "session.execution.started",
        "session.text.started",
        "session.reasoning.started",
        "session.error",
    ]) {
        activity.observe({ type, data: { sessionID: "child" } });
    }
    activity.observe({ type: "session.text.delta", data: { sessionID: "foreign", delta: "x" } });
    activity.observe({ type: "session.text.delta", data: { sessionID: "child", delta: "" } });
    expect(received).toBe(0);
    for (const type of [
        "session.text.delta",
        "session.reasoning.delta",
        "session.tool.input.delta",
    ]) {
        activity.observe({ type, data: { sessionID: "child", delta: "x" } });
    }
    activity.observe({
        type: "session.tool.input.started",
        data: { sessionID: "child", name: "read" },
    });
    for (const type of ["session.text.ended", "session.reasoning.ended"]) {
        activity.observe({ type, data: { sessionID: "child", text: "x" } });
    }
    expect(received).toBe(6);
    stop();
    activity.observe({ type: "session.text.delta", data: { sessionID: "child", delta: "late" } });
    expect(received).toBe(6);
});

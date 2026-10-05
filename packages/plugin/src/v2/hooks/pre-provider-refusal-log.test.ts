/// <reference types="bun-types" />

/**
 * A turn that Magic Context refuses before the model call leaves no trace a user
 * can see: OpenCode stores the turn as interrupted, the assistant never answers,
 * and no error is painted. The Magic Context log is the one artifact support asks
 * for, so the reason the turn was refused has to reach it.
 *
 * The store-generation message below is the real one an OpenCode 2 host produced
 * on a data directory that had been used by OpenCode 1: the v2 store reader
 * refused the migrated database, every turn died silently, and the plugin log
 * held only its boot lines.
 */
import { beforeEach, expect, mock, test } from "bun:test";

const logged: Array<{ sessionId: string; message: string }> = [];
const mockSessionLog = mock((sessionId: string, message: string) => {
    logged.push({ sessionId, message });
});

mock.module("../../shared/logger", () => ({
    log: mock(() => {}),
    sessionLog: mockSessionLog,
    flushLogger: mock(() => {}),
    setLogLineForwarder: mock(() => {}),
    writeForwardedLogLine: mock(() => {}),
    getLogFilePath: () => "/tmp/magic-context-test.log",
    getLoggerDiagnostics: () => ({
        swallowedWriteCount: 0,
        lastErrorMessage: null,
        lastErrorTime: null,
    }),
}));

const { reportPreProviderRefusal } = await import("./context");

beforeEach(() => {
    logged.length = 0;
});

test("a pre-provider refusal names its cause and session in the Magic Context log", () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
        reportPreProviderRefusal(
            "ses_aged_store",
            new Error(
                "OpenCode store generation mismatch at /data/opencode/opencode.db: expected v2, found v1; refusing generation-specific database access",
            ),
        );
    } finally {
        console.warn = warn;
    }

    expect(logged).toHaveLength(1);
    expect(logged[0]?.sessionId).toBe("ses_aged_store");
    expect(logged[0]?.message).toContain("refusing this turn before the model call");
    expect(logged[0]?.message).toContain("OpenCode store generation mismatch");
});

test("a non-Error refusal cause still reaches the log", () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
        reportPreProviderRefusal("ses_other", "context storage is not durable");
    } finally {
        console.warn = warn;
    }

    expect(logged).toHaveLength(1);
    expect(logged[0]?.message).toContain("context storage is not durable");
});

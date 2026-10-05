import { describe, expect, test } from "bun:test";
import { runTokenLog } from "./run-token-log";

describe("run token log host usage", () => {
    test("OpenCode assistant message tokens retain reasoning and cache", () => {
        const message = {
            info: {
                finish: "length",
                tokens: { input: 10, output: 50, reasoning: 48, cache: { read: 7, write: 0 } },
            },
        };
        expect(runTokenLog(message.info.tokens, 64, message.info.finish)).toEqual({
            input: 10,
            output: 50,
            reasoning: 48,
            cache_read: 7,
            cache_write: 0,
            max_tokens: 64,
            finish_reason: "length",
        });
    });

    test("OpenCode hidden-completion usage preserves omitted reasoning as null", () => {
        const row = {
            data: {
                finish: "stop",
                tokens: { input: 20, output: 4, cache: { read: 0, write: 3 } },
            },
        };
        expect(runTokenLog(row.data.tokens, undefined, row.data.finish)).toEqual({
            input: 20,
            output: 4,
            reasoning: null,
            cache_read: 0,
            cache_write: 3,
            max_tokens: null,
            finish_reason: "stop",
        });
    });

    test("Pi stdout usage and absent usage remain distinguishable", () => {
        const message = {
            stopReason: "length",
            usage: { input: 3, output: 12, cacheRead: 2, cacheWrite: 0 },
        };
        expect(runTokenLog(message.usage, 12, message.stopReason)).toEqual({
            input: 3,
            output: 12,
            reasoning: null,
            cache_read: 2,
            cache_write: 0,
            max_tokens: 12,
            finish_reason: "length",
        });
        expect(runTokenLog(undefined)).toEqual({
            input: null,
            output: null,
            reasoning: null,
            cache_read: null,
            cache_write: null,
            max_tokens: null,
            finish_reason: null,
        });
    });
});

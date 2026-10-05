import { describe, expect, it } from "bun:test";

import { isTransientHistorianPromptError } from "./historian-transient-error";

describe("isTransientHistorianPromptError", () => {
    it.each([
        "429 rate limit from provider",
        "rate_limit_error: slow down",
        "503 Service Unavailable",
        "502 Bad Gateway from upstream", // "bad gateway" is not "bad request"
        "500 Internal Server Error",
        "Overloaded",
        "request timeout",
        "read ECONNRESET",
        "connect ETIMEDOUT",
        "503 upstream author-profile service unavailable",
    ])("retries %p", (message) => {
        expect(isTransientHistorianPromptError(message)).toBe(true);
    });

    it.each([
        "401 unauthorized",
        "403 Forbidden",
        "authentication_error: invalid x-api-key",
        "OAuth token expired; 503",
        "Authorization header missing (429)",
        "400 Bad Request",
        "status 400: malformed",
        "invalid_request_error: prompt is too long: 250000 tokens > 200000 maximum",
        "prompt is too long: 250000 tokens",
        "request id 15003 failed",
        "model not found",
    ])("does not retry %p", (message) => {
        expect(isTransientHistorianPromptError(message)).toBe(false);
    });
});

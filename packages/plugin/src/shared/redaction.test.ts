/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import {
    hasShareabilitySensitiveText,
    isSecretKey,
    redactSecretText,
    sanitizeConfigValue,
} from "./redaction";

describe("redactSecretText — token counts and scalar diagnostics stay visible", () => {
    test("keeps numeric/boolean values whose key merely contains a secret word", () => {
        // These log shapes are counts/flags, not secrets, so they must stay readable.
        expect(redactSecretText("tokens.input=45000 cache.read=0 cache.write=0")).toBe(
            "tokens.input=45000 cache.read=0 cache.write=0",
        );
        expect(redactSecretText("hasUsageTokens=true")).toBe("hasUsageTokens=true");
        expect(redactSecretText("totalInputTokens=132000")).toBe("totalInputTokens=132000");
        expect(redactSecretText("max_tokens=4096")).toBe("max_tokens=4096");
    });

    test("keeps quoted numeric values matched only on the key word", () => {
        expect(redactSecretText('"max_tokens": "4096"')).toBe('"max_tokens": "4096"');
    });

    test("still redacts real secret string values", () => {
        // High-entropy / non-scalar values must always be redacted; only bare
        // numeric/boolean scalars are exempt from the key-based match.
        expect(redactSecretText("api_key=sk-abc123XYZsecretvalue")).toContain("<REDACTED:");
        expect(redactSecretText("api_key=sk-abc123XYZsecretvalue")).not.toContain(
            "sk-abc123XYZsecretvalue",
        );
        expect(redactSecretText('"auth_token": "tok_live_9f8e7d6c5b"')).toContain("<REDACTED:");
    });

    test("value-shaped secret patterns still fire independent of key name", () => {
        // A bearer/JWT value is caught by its own pattern even if its key is bland.
        expect(redactSecretText("Authorization: Bearer abc123def456ghi789")).toContain(
            "<REDACTED:bearer>",
        );
        expect(redactSecretText("blob=eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSMeKKF2QT4")).toContain(
            "<JWT_REDACTED>",
        );
    });
});

describe("hasShareabilitySensitiveText", () => {
    test("safe project facts are shareable", () => {
        expect(
            hasShareabilitySensitiveText(
                "The historian runs as a hidden subagent and never busts the prompt cache.",
            ),
        ).toBe(false);
        expect(
            hasShareabilitySensitiveText("Migration v45 adds the retrospective watermark column."),
        ).toBe(false);
    });

    test("flags inline key:value / key=value secrets the keyed redactor misses in prose", () => {
        expect(hasShareabilitySensitiveText("Set api_key: sk-live-abc123 in the env.")).toBe(true);
        expect(hasShareabilitySensitiveText("password=hunter2 for the staging box")).toBe(true);
        expect(hasShareabilitySensitiveText("client_secret = abcdef in the OAuth app")).toBe(true);
    });

    test("flags Windows forward-slash home (sanitizePathString only rewrites backslash form)", () => {
        expect(hasShareabilitySensitiveText("logs are under C:/Users/ufuk/AppData/mc")).toBe(true);
    });

    test("flags ~/ rooted personal paths", () => {
        expect(hasShareabilitySensitiveText("config lives at ~/.config/opencode/x.jsonc")).toBe(
            true,
        );
    });

    test("flags local / private endpoints", () => {
        expect(hasShareabilitySensitiveText("embed endpoint is http://localhost:1234/v1")).toBe(
            true,
        );
        expect(hasShareabilitySensitiveText("the box answers on 127.0.0.1:8080")).toBe(true);
        expect(hasShareabilitySensitiveText("LAN host 192.168.1.42 runs the model")).toBe(true);
        expect(hasShareabilitySensitiveText("internal 10.0.0.5 endpoint")).toBe(true);
    });

    test("a public IP / port alone is not flagged by the private-range rules", () => {
        // 8.8.8.8 is public; no private-range or localhost pattern should match.
        expect(hasShareabilitySensitiveText("DNS resolver at 8.8.8.8")).toBe(false);
    });
});

describe("redaction gaps: unambiguous secret key names and header/URL credentials", () => {
    test("object keys naming a password, secret, credential or ID token are redacted", () => {
        for (const key of [
            "db_password",
            "id_token",
            "secret_value",
            "smtp_password",
            "aws_credentials",
        ]) {
            expect(isSecretKey(key)).toBe(true);
            expect(sanitizeConfigValue({ [key]: "hunter2-value" })).toEqual({
                [key]: expect.stringContaining("<REDACTED:"),
            });
        }
    });

    test("ambiguous key/token compounds that are counts or labels stay visible", () => {
        for (const key of [
            "max_tokens",
            "input_tokens",
            "cache_key",
            "sort_key",
            "password_min_length",
        ]) {
            expect(isSecretKey(key)).toBe(false);
        }
    });

    test("URL userinfo credentials are redacted", () => {
        const redacted = redactSecretText(
            "connecting to https://alice:s3cretPass@db.example.com/x",
        );
        expect(redacted).not.toContain("s3cretPass");
        expect(redacted).toContain("db.example.com");
    });

    test("Basic authorization and API-key headers are redacted", () => {
        const basic = redactSecretText("Authorization: Basic YWxpY2U6czNjcmV0UGFzcw==");
        expect(basic).not.toContain("YWxpY2U6czNjcmV0UGFzcw==");
        const apiKey = redactSecretText("x-api-key: live_9f8e7d6c5b4a3");
        expect(apiKey).not.toContain("live_9f8e7d6c5b4a3");
        expect(apiKey).toContain("x-api-key");
    });
});

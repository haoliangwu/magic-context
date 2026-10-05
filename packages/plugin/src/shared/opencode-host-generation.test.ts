import { describe, expect, it } from "bun:test";
import { openCodeHostGenerationFromVersion } from "./opencode-db-path";

// The generation is decided from the version the executable reports, never
// from its name: the public installer puts OpenCode 2 at ~/.opencode/bin/opencode
// with a tiny `opencode2` shim beside it, so the name says nothing. The raw
// `--version` stdout carries a program-name prefix ("opencode v2.0.12"); a
// parser that feeds that to Number.parseInt reads NaN and demotes every
// standalone 2.x install to 1.x (AFT hit this on a clean VM, 2026-09-21).
// OpenCode 2's pre-GA betas were `@opencode-ai/*@0.0.0-beta-<n>` — the V2 line
// wearing the old scope's version string — so a major of 0 is v2, not v1.
describe("OpenCode host generation from --version output", () => {
    it.each([
        ["opencode v2.0.12", "v2"],
        ["v2.0.12", "v2"],
        ["2.0.12", "v2"],
        ["opencode v2.0.12\n", "v2"],
        ["opencode 1.18.31", "v1"],
        ["1.18.31", "v1"],
        ["0.0.0-beta-19234", "v2"],
        ["opencode v0.0.0-beta-19234", "v2"],
        ["0.0.0-dev-42", "v2"],
        ["0.9.3", "v1"],
        [null, "v1"],
        ["", "v1"],
    ])("%p → %s", (raw, expected) => {
        expect(openCodeHostGenerationFromVersion(raw)).toBe(expected);
    });
});

import { describe, expect, it } from "bun:test";
import { DREAMER_CURATE_ALLOWED_TOOLS, DREAMER_DOCS_ALLOWED_TOOLS } from "./dreamer";
import {
    applyDisallowedTools,
    buildAllowOnlyPermission,
    HISTORIAN_ALLOWED_TOOLS,
} from "./permissions";

describe("buildAllowOnlyPermission", () => {
    it("starts with wildcard deny so nothing is allowed by default", () => {
        const perm = buildAllowOnlyPermission([]);
        expect(perm["*"]).toBe("deny");
    });

    it("layers the allow-list on top of the wildcard deny", () => {
        const perm = buildAllowOnlyPermission(["read", "ctx_search"]);
        expect(perm["*"]).toBe("deny");
        expect(perm.read).toBe("allow");
        expect(perm.ctx_search).toBe("allow");
    });

    it("places named allows AFTER the wildcard deny so findLast-semantics make them win", () => {
        // OpenCode's Permission.evaluate uses `findLast` over the ruleset
        // built from this object's insertion order. If "*" appeared after a
        // named tool, the deny would clobber it — guard against accidental
        // regressions in the helper's ordering.
        const perm = buildAllowOnlyPermission(["read"]);
        const keys = Object.keys(perm);
        const wildcardIdx = keys.indexOf("*");
        const readIdx = keys.indexOf("read");
        expect(wildcardIdx).toBeLessThan(readIdx);
    });

    it("never accidentally allows `task`, `bash`, or `edit` unless explicitly listed", () => {
        // The whole point of this helper is preventing historian / dreamer /
        // hidden agents from inheriting the primary-agent surface. Lock that in.
        const perm = buildAllowOnlyPermission(["read"]);
        expect(perm.task).toBeUndefined();
        expect(perm.bash).toBeUndefined();
        expect(perm.edit).toBeUndefined();
        expect(perm.webfetch).toBeUndefined();
        expect(perm.websearch).toBeUndefined();
        // The wildcard deny covers them via findLast — verified above.
    });

    it("returns an empty allow-list as just the wildcard deny", () => {
        const perm = buildAllowOnlyPermission([]);
        expect(Object.keys(perm)).toEqual(["*"]);
    });
});

describe("HISTORIAN_ALLOWED_TOOLS", () => {
    it("has no tools: all reference state is supplied inline", () => {
        expect([...HISTORIAN_ALLOWED_TOOLS]).toEqual([]);
    });
});

describe("applyDisallowedTools", () => {
    it("returns the defaults unchanged when disallowed is empty", () => {
        expect(applyDisallowedTools(["read", "aft_outline", "aft_zoom", "aft_search"], [])).toEqual(
            ["read", "aft_outline", "aft_zoom", "aft_search"],
        );
    });

    it('removes all tools when "*" is in the disallowed list', () => {
        expect(
            applyDisallowedTools(["read", "aft_outline", "aft_zoom", "aft_search"], ["*"]),
        ).toEqual([]);
    });

    it('removes all tools when "*" appears alongside other entries', () => {
        expect(
            applyDisallowedTools(["read", "aft_outline", "aft_zoom", "aft_search"], ["*", "read"]),
        ).toEqual([]);
    });

    it("removes a single tool by name", () => {
        const result = applyDisallowedTools(
            ["read", "aft_outline", "aft_zoom", "aft_search"],
            ["read"],
        );
        expect(result).not.toContain("read");
        expect(result).toContain("aft_outline");
        expect(result).toContain("aft_zoom");
        expect(result).toContain("aft_search");
    });

    it("removes multiple tools by name", () => {
        const result = applyDisallowedTools(
            ["read", "aft_outline", "aft_zoom", "aft_search"],
            ["read", "aft_search"],
        );
        expect(result).toEqual(["aft_outline", "aft_zoom"]);
    });

    it("silently ignores unknown tool names (defense-in-depth)", () => {
        expect(
            applyDisallowedTools(
                ["read", "aft_outline", "aft_zoom", "aft_search"],
                ["nonexistent"],
            ),
        ).toEqual(["read", "aft_outline", "aft_zoom", "aft_search"]);
    });

    it("produces empty allow-list → buildAllowOnlyPermission yields wildcard deny only", () => {
        const allowed = applyDisallowedTools(
            ["read", "aft_outline", "aft_zoom", "aft_search"],
            ["*"],
        );
        const perm = buildAllowOnlyPermission(allowed);
        expect(perm).toEqual({ "*": "deny" });
    });
});

describe("DREAMER_CURATE_ALLOWED_TOOLS (base dreamer = curate only)", () => {
    it("allows only ctx_memory — the category snapshot replaces enumeration", () => {
        // A separate verify task owns memory-vs-code correctness; curate is
        // pure pool hygiene, so it has no read/grep/bash/write/edit surface.
        expect([...DREAMER_CURATE_ALLOWED_TOOLS]).toEqual(["ctx_memory"]);
    });

    it("does NOT include any codebase / shell / file-write tool", () => {
        for (const denied of [
            "read",
            "grep",
            "glob",
            "bash",
            "write",
            "edit",
            "aft_search",
            "ctx_search",
            "ctx_note",
            "task",
        ]) {
            expect(DREAMER_CURATE_ALLOWED_TOOLS).not.toContain(denied);
        }
    });
});

describe("DREAMER_DOCS_ALLOWED_TOOLS (maintain-docs)", () => {
    it("includes read-only source investigation tools for doc proposals", () => {
        for (const tool of ["read", "grep", "glob", "aft_outline", "aft_zoom", "aft_search"]) {
            expect(DREAMER_DOCS_ALLOWED_TOOLS).toContain(tool);
        }
    });

    it("denies write, shell and memory tools", () => {
        for (const denied of [
            "bash",
            "write",
            "edit",
            "ctx_memory",
            "ctx_search",
            "ctx_note",
            "task",
        ]) {
            expect(DREAMER_DOCS_ALLOWED_TOOLS).not.toContain(denied);
        }
    });
});

describe("integration: full hidden-agent permission shape", () => {
    it("historian permission object denies every tool", () => {
        const perm = buildAllowOnlyPermission(HISTORIAN_ALLOWED_TOOLS);
        expect(perm).toEqual({ "*": "deny" });
    });

    it("base dreamer permission object denies all except ctx_memory", () => {
        const perm = buildAllowOnlyPermission(DREAMER_CURATE_ALLOWED_TOOLS);
        expect(perm).toEqual({
            "*": "deny",
            ctx_memory: "allow",
        });
    });

    it("dreamer-docs permission object denies writes and allows read-only source tools", () => {
        const perm = buildAllowOnlyPermission(DREAMER_DOCS_ALLOWED_TOOLS);
        expect(perm).toEqual({
            "*": "deny",
            read: "allow",
            grep: "allow",
            glob: "allow",
            aft_outline: "allow",
            aft_zoom: "allow",
            aft_search: "allow",
        });
    });
});

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Host } from "@opencode/plugin/host";
import { Schema } from "effect";
import plugin from "../index";
import server from "./server";

// Verbatim GA Module schema, core-module-schema.excerpt.js:34-45.
const Module = Schema.Struct({
    default: Schema.Union([
        Schema.Struct({
            id: Schema.String,
            effect: Schema.declare((input) => typeof input === "function"),
        }),
        Schema.Struct({
            id: Schema.String,
            setup: Schema.declare((input) => typeof input === "function"),
        }),
    ]),
});
const decode = Schema.decodeUnknownSync(Module);
const missingEntryCodes = new Set([
    "ENOENT",
    "ENOTDIR",
    "MODULE_NOT_FOUND",
    "ERR_MODULE_NOT_FOUND",
    "ERR_PACKAGE_PATH_NOT_EXPORTED",
    "ERR_UNSUPPORTED_DIR_IMPORT",
]);

function isMissingEntryError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        missingEntryCodes.has(String((error as { code: unknown }).code))
    );
}

function resolveDirectoryHost(directory: string): ReturnType<typeof Host.resolve> {
    try {
        return Host.resolve({ directory });
    } catch (error) {
        if (!isMissingEntryError(error)) throw error;

        // Some Bun releases return a non-Error ResolveMessage. If Host rejects
        // that shape before checking its code, repeat its probes by code so this
        // test remains about package entry selection rather than error ancestry.
        const entry = (subpaths: string[]): string | undefined => {
            for (const subpath of subpaths) {
                try {
                    return Bun.resolveSync(resolve(directory, subpath || "index"), directory);
                } catch (entryError) {
                    if (!isMissingEntryError(entryError)) throw entryError;
                }
            }
            return undefined;
        };
        return { server: entry(["server", ""]), tui: entry(["tui"]), rpc: entry(["rpc"]) };
    }
}

test("GA Module accepts exact id/setup export", () => {
    expect(decode({ default: server }).default).toEqual(server);
    expect(Object.keys(server).sort()).toEqual(["id", "setup"]);
});
test("GA Module ignores extras and rejects v1 id/server with LoadError cause", () => {
    expect(decode({ default: { ...server, stray: true } }).default).toEqual(server);
    expect(() => decode({ default: { id: server.id, server() {} } })).toThrow();
});
// Both hosts select their own callback from the same plain object. A ./server
// subpath would take precedence on v1, so directory loading uses index.js instead.
test("union entry satisfies both loaders without a ./server override", () => {
    const directory = resolve(import.meta.dir, "../..");
    const pkg = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8")) as {
        exports: Record<string, unknown>;
        files: string[];
    };
    expect(Object.keys(plugin).sort()).toEqual(["id", "server", "setup"]);
    expect(decode({ default: plugin }).default).toEqual({ id: plugin.id, setup: server.setup });
    expect(typeof plugin.id).toBe("string");
    expect(typeof plugin.server).toBe("function");
    expect(Object.keys(pkg.exports)).not.toContain("./server");
    expect(pkg.files).not.toContain("server.js");
    expect(existsSync(resolve(directory, "server.js"))).toBe(false);
    expect(pkg.files).toContain("index.js");
    expect(readFileSync(resolve(directory, "index.js"), "utf8")).toBe(
        'export { default } from "./dist/index.js";\n',
    );
    const byDirectory = resolveDirectoryHost(directory);
    expect(byDirectory.server).toContain("index.js");
    expect(byDirectory.rpc).toBeUndefined();
});

// The v2 SDK's OpenTUI peers conflict with the v1 TUI runtime. Keep v2
// development tooling out of the dependency tree npm installs for v1 users.
test("published runtime dependencies contain no v2 @opencode packages", () => {
    const pkg = JSON.parse(
        readFileSync(resolve(import.meta.dir, "../../package.json"), "utf8"),
    ) as {
        dependencies: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies).filter((name) => name.startsWith("@opencode/"))).toEqual(
        [],
    );
});

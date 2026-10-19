import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import packageMetadata from "../package.json";

const markerSymbol = Symbol.for("cortexkit.standalone-plugins");
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
let originalMarker: unknown;

// Stub the v2 server so this test proves the v1 entry registers the
// standalone-plugin marker itself rather than relying on its v2 import.
mock.module("./v2/server", () => ({ setup: async () => {} }));

beforeEach(() => {
    originalMarker = globals[markerSymbol];
});

afterEach(() => {
    if (originalMarker === undefined) delete globals[markerSymbol];
    else globals[markerSymbol] = originalMarker;
});

test("loading the OpenCode 1 entry registers Magic Context", async () => {
    const registry = new Map<string, unknown>([["aft", { version: "1.2.3" }]]);
    globals[markerSymbol] = registry;

    await import("./index");

    expect(globals[markerSymbol]).toBe(registry);
    expect(registry.get("aft")).toEqual({ version: "1.2.3" });
    expect(registry.get("magic-context")).toEqual({
        version: packageMetadata.version,
    });
});

import { afterEach, expect, spyOn, test } from "bun:test";
import packageMetadata from "../package.json";
import { registerStandalonePluginMarker } from "./standalone-plugin-marker";

const markerSymbol = Symbol.for("cortexkit.standalone-plugins");
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
let originalMarker: unknown;

afterEach(() => {
    if (originalMarker === undefined) delete globals[markerSymbol];
    else globals[markerSymbol] = originalMarker;
    originalMarker = undefined;
});

test("creates the shared Map and registers Magic Context's package version", () => {
    originalMarker = globals[markerSymbol];
    delete globals[markerSymbol];

    registerStandalonePluginMarker(packageMetadata.version);

    expect(globals[markerSymbol]).toBeInstanceOf(Map);
    expect((globals[markerSymbol] as Map<string, unknown>).get("magic-context")).toEqual({
        version: packageMetadata.version,
    });
});

test("preserves the shared Map and entries registered by other products", () => {
    originalMarker = globals[markerSymbol];
    const registry = new Map<string, unknown>([["aft", { version: "1.2.3" }]]);
    globals[markerSymbol] = registry;

    registerStandalonePluginMarker(packageMetadata.version);

    expect(globals[markerSymbol]).toBe(registry);
    expect(registry.get("aft")).toEqual({ version: "1.2.3" });
    expect(registry.get("magic-context")).toEqual({
        version: packageMetadata.version,
    });
});

test("ignores registration failures without writing to the host console", () => {
    originalMarker = globals[markerSymbol];
    const invalidRegistry = {
        set() {
            throw new Error("registry is unavailable");
        },
    };
    globals[markerSymbol] = invalidRegistry;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});

    expect(() => {
        registerStandalonePluginMarker(packageMetadata.version);
        registerStandalonePluginMarker(packageMetadata.version);
    }).not.toThrow();
    expect(warning).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    warning.mockRestore();
    error.mockRestore();
});

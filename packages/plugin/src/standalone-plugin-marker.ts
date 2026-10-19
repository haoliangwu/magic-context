import { log } from "./shared/logger";

const markerSymbol = Symbol.for("cortexkit.standalone-plugins");

/**
 * Announce this plugin in the Map that CortexKit standalone plugins share, so a
 * harness bridge can detect a standalone Magic Context and refuse to run both.
 * Other products' entries are left untouched, and a failure never stops the
 * host from loading the plugin.
 */
export function registerStandalonePluginMarker(version: string): void {
    try {
        const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
        let registry = globals[markerSymbol];
        if (registry === undefined) {
            registry = new Map<string, { version: string }>();
            globals[markerSymbol] = registry;
        }
        (registry as Map<string, { version: string }>).set("magic-context", { version });
    } catch (error) {
        try {
            log("could not register the standalone plugin marker", error);
        } catch {
            // Registration must never prevent the host from loading the plugin.
        }
    }
}

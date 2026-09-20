import { loadPluginConfigDetailed } from "../config";
import { setHarness } from "../shared/harness";
import { log } from "../shared/logger";
import { registerContext } from "./hooks/context";
import type { V2Context } from "./hooks/types";
import { startUpdateChecks } from "./hooks/update-check";

/**
 * Only an OpenCode 2 host hands `setup` a context carrying `session.hook`.
 * The package's default export is the union `{ id, server, setup }`, and a
 * v1 host that finds `setup` on it must not run the v2 lane: locking the
 * harness to "opencode2" there mis-tags every row that seat writes.
 *
 * Proven against the shipped OpenCode 1.18.30 binary and traced to source at
 * tag v1.18.31: the v1 loader (`packages/opencode/src/plugin/index.ts`) calls
 * `server()`, and independently the bundled core external-plugin layer
 * (`packages/core/src/plugin/promise.ts:90`) adopts any module whose default
 * export matches `{ id, setup }` (`core/src/config/plugin/external.ts:15-30`)
 * and calls `setup(context)` with the 1.18-era v2 host surface
 * (`core/src/plugin/host.ts:30-208`): keys `[options, agent, aisdk, catalog,
 * command, integration, plugin, reference, skill]`, no `session`.
 * `registerContext` then throws on `context.session.hook`; that layer discards
 * the failure with `Effect.ignoreCause`, so nothing surfaced while the harness
 * stayed locked to "opencode2" for the rest of the v1 process.
 */
export function isOpenCode2HostContext(context: unknown): context is V2Context {
    if (typeof context !== "object" || context === null) return false;
    const session = (context as { session?: unknown }).session;
    return (
        typeof session === "object" &&
        session !== null &&
        typeof (session as { hook?: unknown }).hook === "function"
    );
}

export async function setup(context: V2Context) {
    if (!isOpenCode2HostContext(context)) {
        // Every OpenCode 1.18.x seat takes this branch at boot (the core
        // external-plugin layer calls setup() on the union export), so this is
        // routine, not a fault: record it in the plugin log and never on the
        // console, which the TUI paints straight onto the screen.
        log(
            "v2 setup() called on a host without session.hook; v1 server lane owns this host, v2 lane inert",
        );
        return async () => {};
    }
    setHarness("opencode2");
    const duties = await registerContext(context);
    const checks =
        loadPluginConfigDetailed(context.location.directory).config.auto_update === false
            ? undefined
            : startUpdateChecks(context);
    console.info("[magic-context] @cortexkit/opencode-magic-context v2 setup");
    return async () => {
        await checks?.dispose();
        await duties?.dispose();
    };
}

export default {
    id: "@cortexkit/opencode-magic-context",
    setup,
};

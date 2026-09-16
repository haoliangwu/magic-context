import { loadPluginConfigDetailed } from "../config";
import { setHarness } from "../shared/harness";
import { registerContext } from "./hooks/context";
import type { V2Context } from "./hooks/types";
import { startUpdateChecks } from "./hooks/update-check";

export async function setup(context: V2Context) {
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

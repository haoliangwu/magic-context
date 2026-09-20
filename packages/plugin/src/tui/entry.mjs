// Prefer the host OpenTUI runtime registry when it exists. OpenTUI 0.4.x
// registers these virtual modules process-wide, which lets the precompiled TUI
// use the host's single Solid/OpenTUI runtime even when this package is loaded
// from an npm cache under node_modules.
const runtimeProbe = "opentui:runtime-module:" + encodeURIComponent("@opentui/solid");

function isMissingRuntimeRegistry(error) {
    const message = error instanceof Error ? error.message : String(error);
    return /Cannot find|Could not resolve|Module not found|Unable to resolve/.test(message) &&
        message.includes("opentui:runtime-module:");
}

let mod;
try {
    await import(runtimeProbe);
} catch (error) {
    if (!isMissingRuntimeRegistry(error)) {
        console.error("Magic Context TUI runtime registry probe failed", error);
        throw error;
    }
    // Older hosts and bare Bun do not provide the virtual registry. Falling back
    // to the raw TSX entry keeps development checkouts and OpenTUI 0.3.x hosts
    // working where the Solid transform still applies to this source path.
    mod = await import("./index.tsx");
}

if (!mod) {
    try {
        mod = await import("../tui-compiled/index.tsx");
    } catch (error) {
        console.error("Magic Context compiled TUI failed to load", error);
        throw error;
    }
}

const v1 = mod.default;

async function setup(context) {
    const v2 = await import("../v2/tui/index.ts");
    return v2.setup(context);
}

// OpenCode 1.18.30's TUI loader reads only id/server/tui and ignores setup
// (packages/opencode/src/plugin/shared.ts:272-304). OpenCode 2.0.3 validates
// id/setup and ignores tui, so one object safely serves both package loaders.
export default { id: v1.id, tui: v1.tui, setup };

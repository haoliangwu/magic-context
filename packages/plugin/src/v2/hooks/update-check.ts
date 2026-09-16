import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLatestVersion } from "../../hooks/auto-update-checker/checker";
import { compareSemverCore } from "../../hooks/auto-update-checker/semver";
import { pushNotification } from "../../shared/rpc-notifications";
import type { V2Context } from "./types";

function packageInfo(): { version: string; development: boolean } {
    let directory = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        try {
            const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
            if (
                pkg.name === "@cortexkit/opencode-magic-context" &&
                typeof pkg.version === "string"
            ) {
                return {
                    version: pkg.version,
                    development: existsSync(join(directory, "src/v2/server.ts")),
                };
            }
        } catch {
            /* Continue to the package root, never infer a version from dist depth. */
        }
        const parent = dirname(directory);
        if (parent === directory) throw new Error("Magic Context package manifest is unavailable");
        directory = parent;
    }
}

/** GA eventMethods is exactly ["subscribe"] (promise/event.d.ts), not on.
 * The v2 plugin domain supplies list only; version checks must never use the
 * v1 checker's singular-plugin configuration writer against plural plugins.
 */
export function startUpdateChecks(
    context: Pick<V2Context, "event" | "storage">,
    check: (signal: AbortSignal) => Promise<string | null> = (signal) => {
        // A source checkout is a local development installation, not a registry install.
        return packageInfo().development
            ? Promise.resolve(null)
            : getLatestVersion("latest", { signal });
    },
) {
    const controller = new AbortController();
    const done = (async () => {
        try {
            for await (const _event of context.event.subscribe({ signal: controller.signal })) {
                if (controller.signal.aborted) break;
                const last = await context.storage.get("version-check-at");
                if (typeof last === "number" && Date.now() - last < 60 * 60 * 1000) continue;
                await context.storage.set("version-check-at", Date.now());
                const latest = await check(controller.signal);
                const comparison = latest ? compareSemverCore(latest, packageInfo().version) : null;
                if (!controller.signal.aborted && comparison !== null && comparison > 0) {
                    pushNotification("toast", {
                        message: `Magic Context ${latest} is available. Update the plugin to install it.`,
                        variant: "info",
                    });
                }
            }
        } catch (error) {
            if (!controller.signal.aborted)
                console.warn("[magic-context] v2 update check unavailable", error);
        }
    })();
    return {
        done,
        async dispose() {
            controller.abort();
            await done;
        },
    };
}

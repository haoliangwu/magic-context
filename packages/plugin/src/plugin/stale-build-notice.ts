import type { HarnessId } from "../shared/harness";
import { pushNotification } from "../shared/rpc-notifications";
import { registerStalePluginBuildHost } from "../shared/stale-plugin-build";

interface ToastClient {
    tui?: {
        showToast?: (input: {
            body: { title: string; message: string; variant: "warning"; duration: number };
        }) => unknown;
    };
}

export function bindStaleBuildNotice(
    client: ToastClient,
    moduleUrl: string,
    harness: HarnessId = "opencode",
): void {
    registerStalePluginBuildHost({
        moduleUrl,
        harness,
        notify: (message: string) => {
            const body = {
                title: "Magic Context needs a restart",
                message,
                variant: "warning" as const,
                duration: 10_000,
            };
            // The v2 server and Magic Context's TUI use the RPC queue, not the
            // legacy SDK's toast method. Queueing also covers a disconnected UI.
            return client.tui?.showToast
                ? client.tui.showToast({ body })
                : pushNotification("toast", body);
        },
    });
}

/**
 * Mounts the OpenCode 1 `/ctx-status` dialog component on the OpenCode 2 dialog
 * surface, so both host generations show the same status view instead of one
 * host getting a plain-text summary of it.
 *
 * It is the same arrangement as `sidebar-mount.ts`, for the same reasons: the
 * component is loaded from `src/tui-compiled/` (Solid transform already applied,
 * runtime imports pointing at the host's `opentui:runtime-module:*` registry) so
 * it binds the host's single Solid/OpenTUI runtime rather than a second copy out
 * of this package.
 *
 * Unlike the sidebar, this component fetches nothing: the caller passes the
 * checked status result it already loaded over RPC, so no second data layer is
 * initialised here.
 */
import type { StatusDetailResult } from "../../tui/data/context-db";
import {
    type CompiledStatusDialog,
    loadCompiledStatusDialog,
} from "./load-compiled-status-dialog.mjs";
import { flattenTheme, isMissingOpenTuiRuntime } from "./sidebar-mount";
import type { V2TuiContext } from "./types";

export interface V1StatusDialogMount {
    /**
     * Replaces the host's dialog surface with the status view for one checked
     * result: the status itself, or the view naming why it is unavailable.
     */
    show(status: StatusDetailResult): void;
}

/**
 * Loads and mounts the v1 status dialog, or returns `null` when this host
 * cannot render it: either it publishes no component dialog surface, or it
 * registers no OpenTUI runtime modules to load the component through. Both
 * cases are answered by the caller's plain-text dialog.
 */
export async function mountV1StatusDialog(
    context: V2TuiContext,
): Promise<V1StatusDialogMount | null> {
    if (typeof context.ui.dialog.show !== "function") return null;
    let compiled: CompiledStatusDialog;
    try {
        compiled = await loadCompiledStatusDialog();
    } catch (error) {
        if (!isMissingOpenTuiRuntime(error)) throw error;
        return null;
    }
    return {
        show: (status) => {
            context.ui.dialog.show?.(() =>
                compiled.StatusDialog({
                    // Read through getters so a theme change repaints: the
                    // component wraps this in a memo, and the host's theme is a
                    // reactive store.
                    get api() {
                        return {
                            get theme() {
                                return {
                                    get current() {
                                        return flattenTheme(context.theme, context.themeMode);
                                    },
                                };
                            },
                        };
                    },
                    get status() {
                        return status;
                    },
                }),
            );
            // After `show`, which replaces the surface and resets it to the
            // host's default width. "large" is the widest the host offers (88
            // columns on GA 2.0.5); the component lays its sections out against
            // whatever width it ends up with.
            context.ui.dialog.set?.({ size: "large", centered: true });
        },
    };
}

/**
 * Mounts the OpenCode 1 sidebar component on the OpenCode 2 `sidebar.content`
 * slot, so both host generations render the same sidebar from the same
 * RPC-backed data layer.
 *
 * The component itself is loaded from `src/tui-compiled/`, the Solid-transformed
 * copy of `src/tui/` produced by `scripts/build-tui.ts`. Two properties of that
 * copy are what make it usable here:
 *
 *  - OpenCode's bundler plugin skips the Solid compile-time transform for files
 *    under `node_modules`, which is where an installed plugin lives. The raw
 *    `.tsx` source would therefore evaluate its JSX children once and freeze on
 *    the first paint; the precompiled copy has the transform already applied.
 *  - Its runtime imports name the `opentui:runtime-module:*` virtual modules
 *    that OpenCode registers process-wide, so the component binds the host's
 *    single Solid/OpenTUI runtime instead of loading a second copy out of this
 *    package. Two Solid instances in one process do not share reactive
 *    ownership, and the renderables would not belong to the host's tree.
 */
import { eventSessionID } from "./events";
import {
    type CompiledSidebarComponent,
    type CompiledSidebarData,
    loadCompiledSidebar,
    type V1SidebarApi,
    type V1Theme,
} from "./load-compiled-sidebar.mjs";
import type { V2ResolvedTheme, V2TuiContext } from "./types";

export interface V1SidebarMount {
    /** Renders the v1 component for one paint of the v2 `sidebar.content` slot. */
    render(input: { readonly sessionID: string }): unknown;
    /** Asks the mounted component to fetch a snapshot now, out of band. */
    refresh(): void;
    dispose(): void;
}

/**
 * Colour tokens moved between host generations: OpenCode 1 handed the sidebar a
 * flat table (`theme.accent`, `theme.textMuted`, …) while OpenCode 2 resolves a
 * token tree (`@opencode/theme/tui` `ResolvedThemeTokens`: `text.base`,
 * `text.muted`, `text.feedback.error.base`, `hue.accent[500]`, …). This maps
 * the eight tokens the sidebar reads. A token the host does not resolve falls
 * back to a colour chosen for the host's theme mode: an earlier fallback of
 * white text painted the section headers white-on-white on light themes when
 * the mapping read key names the theme package never had.
 *
 * The accent is read at hue step 200, the step the host draws its own accent
 * UI in. The ramp is ordered by distance from the page, not by lightness, so
 * step 200 stays a readable accent in both modes (captured GA host: #9d7cd8 on
 * #0a0a0a dark, #d68c27 on #ffffff light) where step 500 resolved to a dark
 * purple on the dark page and a pale orange on the light one.
 */
export function flattenTheme(
    theme: V2ResolvedTheme | undefined,
    mode: "dark" | "light" = "dark",
): V1Theme {
    const light = mode === "light";
    const feedback = theme?.text?.feedback;
    return {
        text: theme?.text?.base ?? (light ? "#1a1a1a" : "#ffffff"),
        textMuted: theme?.text?.muted ?? (light ? "#6b6b6b" : "#9a9a9a"),
        accent: theme?.hue?.accent?.[200] ?? "#5f87ff",
        background: theme?.background?.base ?? (light ? "#ffffff" : "#000000"),
        borderActive: theme?.border?.base ?? "#9a9a9a",
        error: feedback?.error?.base ?? "#d13b3b",
        warning: feedback?.warning?.base ?? "#c77d1a",
        success: feedback?.success?.base ?? "#2e9a4e",
    };
}

/**
 * True when the import failed because the host does not register the OpenTUI
 * runtime modules. That is the only failure this module is allowed to answer
 * with the plain-text fallback; anything else is a real defect and rethrows.
 */
export function isMissingOpenTuiRuntime(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
        message.includes("opentui:runtime-module:") &&
        /Cannot find|Could not resolve|Module not found|Unable to resolve/.test(message)
    );
}

/**
 * The directory of the Magic Context server that owns `sessionID` on this host,
 * or undefined while the host has not loaded the session (the caller then uses
 * its startup directory). See `directoryForSession`.
 */
export function sessionDirectory(context: V2TuiContext, sessionID: string): string | undefined {
    try {
        return context.data.session?.get(sessionID)?.location?.directory;
    } catch {
        return undefined;
    }
}

function createV1Api(context: V2TuiContext, directory: string): V1SidebarApi {
    return {
        state: {
            path: { directory },
            session: {
                get: (sessionID) => ({ directory: sessionDirectory(context, sessionID) }),
            },
        },
        renderer: { requestRender: () => context.renderer.requestRender() },
        event: {
            // OpenCode 1's event names ("message.updated", "session.updated",
            // "message.removed") do not exist on OpenCode 2, whose stream uses
            // "session.status", "session.idle", "session.step.ended" and so on.
            // Rather than guess a per-name mapping that would silently stop
            // updating when the host renames an event, every subscription is fed
            // every v2 event that carries a session id, projected into the v1
            // shape. The component debounces its refresh, so the three
            // subscriptions collapse into one fetch.
            on: (_type, handler) =>
                context.data.listen(({ details }) => {
                    const sessionID = eventSessionID(details);
                    if (!sessionID) return;
                    handler({
                        properties: { sessionID, info: { id: sessionID, sessionID } },
                    });
                }),
        },
    };
}

/**
 * Loads and mounts the v1 sidebar, or returns `null` when the host provides no
 * OpenTUI runtime registry to load it through.
 */
export async function mountV1Sidebar(
    context: V2TuiContext,
    directory: string,
): Promise<V1SidebarMount | null> {
    let compiled: CompiledSidebarComponent;
    let data: CompiledSidebarData;
    try {
        ({ component: compiled, data } = await loadCompiledSidebar());
    } catch (error) {
        if (!isMissingOpenTuiRuntime(error)) throw error;
        return null;
    }

    // The compiled tree carries its own copy of the RPC data layer, so its
    // client has to be initialised separately from the one `setupWithJsx`
    // creates for the status/recomp dialogs. Without this the component's
    // fetches return the empty snapshot and every row reads zero.
    data.initRpcClient(directory);

    const slot = compiled.createSidebarContentSlot(createV1Api(context, directory));
    return {
        render: (input) =>
            slot.slots.sidebar_content(
                {
                    // Read through a getter so a theme change repaints: the
                    // component wraps this in a memo, and the host's theme is a
                    // reactive store.
                    get theme() {
                        return {
                            get current() {
                                return flattenTheme(context.theme, context.themeMode);
                            },
                        };
                    },
                },
                {
                    // `input` is the slot's reactive props object; reading
                    // `sessionID` lazily keeps the component subscribed to
                    // session switches.
                    get session_id() {
                        return input.sessionID;
                    },
                },
            ),
        refresh: () => compiled.refreshSidebarSnapshot(),
        dispose: () => {
            slot.dispose();
            data.closeRpc();
        },
    };
}

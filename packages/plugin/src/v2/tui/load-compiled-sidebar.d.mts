/** Typed view of load-compiled-sidebar.mjs; see that file for why it is untyped JS. */

/** The colour table the OpenCode 1 sidebar reads (OpenTUI RGBA or a hex string). */
export type V1ThemeColor = { r: number; g: number; b: number; a?: number } | string;

export type V1Theme = Record<
    | "text"
    | "textMuted"
    | "accent"
    | "background"
    | "borderActive"
    | "error"
    | "warning"
    | "success",
    V1ThemeColor
>;

/**
 * The v1 event object as the sidebar component reads it. It only ever pulls a
 * session id out of these three fields.
 */
export interface V1Event {
    readonly properties: {
        readonly sessionID: string;
        readonly info: { readonly id: string; readonly sessionID: string };
    };
}

/** The slice of OpenCode 1's `TuiPluginApi` the sidebar component actually uses. */
export interface V1SidebarApi {
    readonly state: {
        readonly path: { readonly directory: string };
        /** The shown session's own directory, so the sidebar asks that directory's server. */
        readonly session: { get(sessionID: string): { readonly directory?: string } | undefined };
    };
    readonly renderer: { requestRender(): void };
    readonly event: { on(type: string, handler: (event: V1Event) => void): () => void };
}

export interface V1SidebarSlot {
    dispose(): void;
    slots: {
        sidebar_content(
            context: { readonly theme: { readonly current: V1Theme } },
            value: { readonly session_id: string },
        ): unknown;
    };
}

export interface CompiledSidebarComponent {
    createSidebarContentSlot(api: V1SidebarApi): V1SidebarSlot;
    refreshSidebarSnapshot(): void;
}

export interface CompiledSidebarData {
    initRpcClient(directory: string): void;
    closeRpc(): void;
}

export declare function loadCompiledSidebar(): Promise<{
    component: CompiledSidebarComponent;
    data: CompiledSidebarData;
}>;

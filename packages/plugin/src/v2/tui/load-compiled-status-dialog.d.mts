/** Typed view of load-compiled-status-dialog.mjs; see that file for why it is untyped JS. */
import type { StatusDetailResult } from "../../tui/data/context-db";
import type { V1Theme } from "./load-compiled-sidebar.d.mts";

/** The slice of OpenCode 1's `TuiPluginApi` the status dialog component reads. */
export interface V1StatusDialogApi {
    readonly theme: { readonly current: V1Theme };
}

export interface CompiledStatusDialog {
    StatusDialog(props: {
        readonly api: V1StatusDialogApi;
        /** Checked status result from `loadStatusDetail`, never a raw RPC reply. */
        readonly status: StatusDetailResult;
    }): unknown;
}

export declare function loadCompiledStatusDialog(): Promise<CompiledStatusDialog>;

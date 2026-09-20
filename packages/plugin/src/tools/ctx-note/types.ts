import type { ImitatedReducedArgs } from "../unwrap-imitated-reduced-args";

export type CtxNoteReadFilter = "all" | "active" | "pending" | "ready" | "dismissed";

export interface CtxNoteArgs extends ImitatedReducedArgs {
    action?: "write" | "read" | "dismiss" | "update";
    content?: string;
    surface_condition?: string;
    filter?: CtxNoteReadFilter;
    /** Max notes per section for read, newest first (default 25). */
    limit?: number;
    /** Skip this many newest notes for read — pages older ones (default 0). */
    offset?: number;
    /** Exactly one id for update, one to fifty for dismiss; ignored by write and read. */
    note_ids?: number[];
}

import {
    formatUnresolvedOpenCode2RelabelDoctorLines,
    readUnresolvedOpenCode2Relabel,
} from "@magic-context/core/features/magic-context/opencode2-relabel";
import type { Database } from "@magic-context/core/shared/sqlite";

/**
 * Report sessions whose OpenCode harness label could not be verified.
 *
 * Migration v87 decides each session's label from the OpenCode session store.
 * When that store could not be read at migration time it changes nothing and
 * records the sessions it skipped; without this line those sessions would keep
 * whatever label they had (possibly the one migration v85 rewrote) with no
 * visible trace. Returns true when a warning was emitted.
 */
export function reportUnresolvedHarnessRelabel(args: {
    db: Pick<Database, "prepare" | "exec">;
    warn: (message: string) => void;
    detail: (message: string) => void;
}): boolean {
    const state = readUnresolvedOpenCode2Relabel(args.db);
    if (!state || state.sessionIds.length === 0) return false;
    const [headline, ...rest] = formatUnresolvedOpenCode2RelabelDoctorLines(state);
    if (headline === undefined) return false;
    args.warn(headline);
    for (const line of rest) args.detail(line);
    return true;
}

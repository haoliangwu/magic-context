import {
    type BackfillResult,
    runSessionProjectBackfill,
} from "../../features/magic-context/session-project-backfill";
import { getHarness } from "../../shared/harness";
import type { Database } from "../../shared/sqlite";
import type { V2StoreReader } from "../store-reader";

/**
 * Bind every existing OpenCode 2 session to its project.
 *
 * The OpenCode 1 lane runs the same backfill at boot over the host's `session`
 * table. OpenCode 2 never runs that lane, and its sessions live in
 * `session_v2`, so sessions created before the plugin started recording the
 * binding (or while it could not) stayed projectless: the Dashboard groups
 * sessions into projects only through `session_projects`. The backfill records
 * completion per harness, so this pass runs to completion once per store.
 */
export function runV2SessionProjectBackfill(
    db: Database,
    openStoreReader: () => Pick<V2StoreReader, "sessionDirectoryPage" | "close">,
    allowHomeProject = false,
): Promise<BackfillResult> {
    return runSessionProjectBackfill(
        db,
        (afterSessionId, limit) => {
            const reader = openStoreReader();
            try {
                return reader.sessionDirectoryPage(afterSessionId, limit);
            } finally {
                reader.close();
            }
        },
        { leaseKey: `${getHarness()}:session-projects-creation-v2`, allowHomeProject },
    );
}

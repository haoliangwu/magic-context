// Run by the bounded-summary test in a fresh Bun process so the test runner's
// retained objects and garbage collections cannot distort the reader deltas.
import { visitRawSessionMessages } from "../../src/hooks/magic-context/read-session-chunk";
import {
    closeReadOnlySessionDb,
    withReadOnlySessionDb,
} from "../../src/hooks/magic-context/read-session-db";
import { readRawSessionMessagesFromDb } from "../../src/hooks/magic-context/read-session-raw";

process.env.OPENCODE_DB = process.argv[2];
const turns = Number(process.argv[3]);
if (!process.env.OPENCODE_DB || !Number.isInteger(turns) || turns <= 0) {
    throw new Error("Expected an OpenCode fixture database path and positive turn count");
}

const heap = () => {
    Bun.gc(true);
    return process.memoryUsage().heapUsed;
};

try {
    // Streamed summary read of the whole session, sampling the heap as it goes.
    const beforeVisit = heap();
    let peakVisit = beforeVisit;
    let visited = 0;
    visitRawSessionMessages(
        "ses_large",
        1,
        turns * 2,
        () => {
            visited += 1;
            if (visited % 200 === 0) {
                peakVisit = Math.max(peakVisit, process.memoryUsage().heapUsed);
            }
            return true;
        },
        { summary: true },
    );

    // The whole-session reader holds every parsed part at once.
    const beforeFull = heap();
    const full = withReadOnlySessionDb((db) => readRawSessionMessagesFromDb(db, "ses_large"));
    const fullDelta = process.memoryUsage().heapUsed - beforeFull;
    console.log(
        JSON.stringify({
            visited,
            fullCount: full?.length,
            visitDelta: peakVisit - beforeVisit,
            fullDelta,
        }),
    );
} finally {
    closeReadOnlySessionDb();
}

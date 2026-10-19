import { parentPort, workerData } from "node:worker_threads";
import type { MarkerCandidateReply } from "./compaction-marker-candidates";

const port = parentPort;
if (!port) throw new Error("marker candidate worker requires a parent port");
port.postMessage({ kind: "accepted" } satisfies MarkerCandidateReply);
const [{ Database }, { scanMarkerCandidateSnapshot }] = await Promise.all([
    import("../../shared/sqlite"),
    import("./compaction-marker-candidates"),
]);
const input = workerData as { path: string; sessionId: string };
let db: InstanceType<typeof Database> | undefined;
let reply: MarkerCandidateReply;
try {
    db = new Database(input.path, { readonly: true });
    db.exec("PRAGMA busy_timeout=250");
    reply = { kind: "candidates", snapshot: scanMarkerCandidateSnapshot(db, input.sessionId) };
} catch (error) {
    reply = { kind: "error", error: error instanceof Error ? error.message : String(error) };
} finally {
    db?.close();
}
port.postMessage(reply);
port.close();

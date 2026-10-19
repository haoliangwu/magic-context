import { existsSync, writeFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import type { RawOrdinalWarmupInput } from "./raw-ordinal-warmup";

// A controlled worker keeps lifecycle assertions independent of scan speed.
const input = workerData as RawOrdinalWarmupInput;
const port = parentPort;
if (!port) throw new Error("controlled ordinal worker requires a parent port");
const marker = `${input.path}.${input.sessionId}`;
if (input.sessionId.includes("unaccepted")) {
    writeFileSync(`${marker}.ready`, "waiting without accepting");
    setInterval(() => {}, 1000);
} else {
    port.postMessage({ kind: "accepted" });
    if (input.sessionId.includes("silent")) {
        writeFileSync(`${marker}.ready`, "accepted without a result");
        setInterval(() => {}, 1000);
    } else {
        const [{ Database }, { scanRawSessionSummaryRows }] = await Promise.all([
            import("../../shared/sqlite"),
            import("./read-session-raw"),
        ]);
        const db = new Database(input.path, { readonly: true });
        const scan = scanRawSessionSummaryRows(db, input.sessionId);
        db.close();
        writeFileSync(`${marker}.ready`, "snapshot captured");
        const timer = setInterval(() => {
            if (!existsSync(`${marker}.release`)) return;
            clearInterval(timer);
            port.postMessage({ kind: "scan", scan });
            port.close();
        }, 5);
    }
}

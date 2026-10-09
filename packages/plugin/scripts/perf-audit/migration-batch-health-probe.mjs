// Keep health scheduling independent of the rehearsal driver's SDK/module work.
// Otherwise a busy driver can look like an unresponsive host without issuing a
// single request during the apparent gap.
import { strict as assert } from "node:assert";

const endpoint = new URL(process.argv[2]);
assert.equal(endpoint.hostname, "127.0.0.1");
const headers = JSON.parse(process.argv[3]);
const pending = new Set();
let stopping = false;
let primed = false;
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const probe = () => {
    const started = performance.now();
    const wallStarted = Date.now();
    const request = fetch(new URL("/health", endpoint), {
        headers,
        signal: AbortSignal.timeout(1000),
    })
        .then(async (response) => {
            await response.arrayBuffer();
            emit({
                started,
                ended: performance.now(),
                wallStarted,
                wallEnded: Date.now(),
                status: response.status,
            });
            if (!primed && response.status === 200) {
                primed = true;
                emit({ type: "primed" });
            }
        })
        .catch((error) =>
            emit({
                started,
                ended: performance.now(),
                wallStarted,
                wallEnded: Date.now(),
                error: String(error),
            }),
        )
        .finally(() => pending.delete(request));
    pending.add(request);
};
probe();
const timer = setInterval(probe, 250);
async function stop() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    await Promise.all(pending);
    process.stdin.pause();
    process.stdout.write("", () => process.exit(0));
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", () => void stop());
process.stdin.on("end", () => void stop());

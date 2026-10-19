import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay, setImmediate as tick } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { inRootAsyncContext } from "./sqlite";

const scope = new AsyncLocalStorage();
const gc = globalThis.Bun ? () => Bun.gc(true) : globalThis.gc;
const references = {};
const resources = [];
const timerStores = {};
const ambientTick = () => { timerStores.ambient = scope.getStore() !== undefined; };
const rootTick = () => { timerStores.root = scope.getStore() !== undefined; };
function create(name, root, worker) {
    const payload = { synthetic: name };
    references[name] = new WeakRef(payload);
    scope.run(payload, () => {
        const make = worker
            ? () => new Worker(new URL("worker.mjs", import.meta.url))
            : () => setInterval(root ? rootTick : ambientTick, 5);
        resources.push(root ? inRootAsyncContext(make) : make());
        assert.equal(scope.getStore(), payload, "Root execution must restore the caller's store");
    });
}
create("ambientWorker", false, true);
create("rootWorker", true, true);
create("ambientTimer", false, false);
create("rootTimer", true, false);
await delay(30);
for (let i = 0; i < 12; i++) { await tick(); gc(); await tick(); }
const retained = Object.fromEntries(Object.entries(references).map(([key, ref]) => [key, Number(ref.deref() !== undefined)]));
for (const resource of resources) {
    if (resource instanceof Worker) await resource.terminate();
    else clearInterval(resource);
}
console.log(JSON.stringify({ runtime: globalThis.Bun ? `Bun ${Bun.version}` : process.version, timerStores, retained }));

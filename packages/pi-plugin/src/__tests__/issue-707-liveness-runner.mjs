import assert from "node:assert/strict";
import { AsyncResource, createHook } from "node:async_hooks";
import { setImmediate as tick } from "node:timers/promises";
import { EmbeddingWorkerClient } from "../../../plugin/src/features/magic-context/memory/embedding-worker-client";
import { assertTransformWrite } from "../../../plugin/src/shared/sqlite";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "../context-handler";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "../test-utils.test";

const gc = globalThis.Bun ? () => Bun.gc(true) : globalThis.gc;
assert.equal(typeof gc, "function");
const client = new EmbeddingWorkerClient(
	{},
	new URL("worker.mjs", import.meta.url),
	5000,
	async () => true,
);
const snapshots = [];
const inputs = [];
let descendant;
let workerStarts = 0;
let workerInheritedPass = false;
const hook = createHook({
	init(_id, type) {
		if (type === "WORKER") {
			workerStarts++;
			workerInheritedPass ||= globalThis.__readLease() !== undefined;
		}
	},
}).enable();

// A detached async resource retains the old SQLite pass's lease after completion.
// Its guard must still reject stale writes, but must not capture the handler's
// obsolete conversation snapshot along with the budget it actually needs.
globalThis.__observePass = async (snapshot, messages) => {
	assert(
		snapshot,
		"Real handler must reach final publication with an LKG snapshot",
	);
	snapshots.push(new WeakRef(snapshot));
	inputs.push(new WeakRef(messages));
	if (snapshots.length === 1) {
		descendant = new AsyncResource("detached-old-pass");
		assert.equal((await client.request()).loaded, true);
	}
};

const db = createTestDb();
const fake = createFakePi();
Object.assign(fake.pi, { getAllTools: () => [] });
registerPiContextHandler(fake.pi, {
	db,
	protectedTags: 0,
	autoSearch: { enabled: false },
});
const handler = fake.handlers.get("context");
const session = "synthetic-worker-liveness";
async function pass(index) {
	const messages = [
		userMessage(
			`synthetic request ${index}: ${"payload ".repeat(8192)}`,
			index,
		),
	];
	const result = await handler(
		{ messages },
		{
			...fakeContext(
				session,
				process.env.MAGIC_CONTEXT_STORAGE_DIR,
				[`entry-${index}`],
				messages,
			),
			getSystemPrompt: () => "Synthetic system prompt.",
			model: {
				provider: "openai",
				id: "synthetic",
				contextWindow: 272000,
				maxTokens: 68000,
			},
		},
	);
	assert(result?.messages.length, "Handler must serve a real managed request");
	return result;
}
await pass(1);
const currentRequest = await pass(2);
assert.equal(snapshots.length, 2);
assert(client.isRunning(), "Keep embedding owner alive through GC");
assert.throws(
	() => descendant.runInAsyncScope(assertTransformWrite),
	/superseded/i,
);
// Node exposes WORKER init events; Bun's worker implementation may not.
// shared/root-async-context.test.ts separately measures whether each runtime's
// workers and timers retain the AsyncLocalStorage store present at construction.
if (!globalThis.Bun) assert.equal(workerStarts, 1);
assert.equal(
	workerInheritedPass,
	false,
	"Embedding Worker must not inherit a pass lease",
);
let retainedSnapshots;
let retainedInputs;
for (let i = 0; i < 20; i++) {
	await tick();
	gc();
	await tick();
	retainedSnapshots = Number(snapshots[0].deref() !== undefined);
	retainedInputs = Number(inputs[0].deref() !== undefined);
	if (!retainedSnapshots && !retainedInputs) break;
}
assert.equal(retainedSnapshots, 0, "Superseded snapshot must be unreachable");
assert.equal(retainedInputs, 0, "Superseded inputs must be unreachable");
assert(currentRequest.messages.length);
assert(client.isRunning());
descendant.emitDestroy();
hook.disable();
await client.dispose();
clearContextHandlerSession(session);
db.close();
console.log(
	JSON.stringify({
		runtime: process.version,
		passes: 2,
		staleWriteRejected: true,
		retainedSnapshots,
		retainedInputs,
		workerInheritedPass,
		workerStarts,
	}),
);

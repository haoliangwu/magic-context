import { expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	freezePiContentDecision,
	getPiContentDecisions,
} from "@magic-context/core/features/magic-context/pi-content-decisions";
import {
	getPendingOps,
	insertTag,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import { getNativeReplayState } from "@magic-context/core/features/magic-context/storage-native-replay";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { applyPendingOperations } from "@magic-context/core/hooks/magic-context/apply-operations";
import { Database } from "@magic-context/core/shared/sqlite";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { authorizePiToolRemoval } from "./native-replay-state-pi";
import {
	assistantToolCall,
	createTestDb,
	toolResultMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

it("Pi write admission preserves the last served array under contention and retries reclaim", () => {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-write-admission-"));
	const path = join(dir, "context.db");
	const db = createTestDb(path);
	const blocker = new Database(path);
	const sessionId = "pi-write-admission";
	try {
		const messages = Array.from({ length: 22 }, (_, index) => [
			assistantToolCall(
				`call-${index}`,
				"read",
				{ path: `${index}` },
				index * 2,
			),
			toolResultMessage(`call-${index}`, "result ".repeat(100), index * 2 + 1),
		]).flat();
		const tagger = createTagger();
		tagger.initFromDb(sessionId, db);
		let removalAttempts = 0;
		const prepare = () => {
			const saved = getNativeReplayState(db, sessionId).toolInputs;
			const transcript = createPiTranscript(
				structuredClone(messages),
				sessionId,
				messages.map((_, index) => `entry-${index}`),
				{
					authorizeToolRemoval: (callId) => {
						removalAttempts++;
						return authorizePiToolRemoval({
							db,
							sessionId,
							callId,
							saved,
							canApply: true,
						});
					},
				},
			);
			const { targets } = tagTranscript(sessionId, transcript, tagger, db);
			return { transcript, targets };
		};
		const first = prepare();
		first.transcript.commit();
		const hash = (transcript: ReturnType<typeof createPiTranscript>) =>
			createHash("sha256")
				.update(JSON.stringify(transcript.getOutputMessages()))
				.digest("hex");
		const lastGoodHash = hash(first.transcript);
		const { transcript, targets } = prepare();
		const tag = [...targets.keys()][0];
		if (tag === undefined) throw new Error("Expected a reclaim target");
		queuePendingOp(db, sessionId, tag, "drop");
		db.exec(
			"CREATE TRIGGER fail_marker BEFORE UPDATE OF trailing_blank_decisions ON session_meta BEGIN SELECT RAISE(ABORT, 'database is locked'); END",
		);
		const vetoed = prepare();
		expect(
			applyPendingOperations(sessionId, db, vetoed.targets, new Set()),
		).toBe(false);
		vetoed.transcript.commit();
		expect(hash(vetoed.transcript)).toBe(lastGoodHash);
		expect(getPendingOps(db, sessionId)).toHaveLength(1);
		db.exec("DROP TRIGGER fail_marker");
		removalAttempts = 0;
		db.exec("PRAGMA busy_timeout=1");
		blocker.exec("BEGIN IMMEDIATE");
		expect(applyPendingOperations(sessionId, db, targets, new Set())).toBe(
			false,
		);
		transcript.commit();
		expect(hash(transcript)).toBe(lastGoodHash);
		expect(removalAttempts).toBe(0);
		expect(getPendingOps(db, sessionId)).toHaveLength(1);
		blocker.exec("ROLLBACK");
		const retry = prepare();
		expect(
			applyPendingOperations(sessionId, db, retry.targets, new Set()),
		).toBe(true);
		retry.transcript.commit();
		expect(hash(retry.transcript)).not.toBe(lastGoodHash);
		expect(getPendingOps(db, sessionId)).toHaveLength(0);
	} finally {
		blocker.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("Pi content marker contention declines only the new decision and retries after unlock", () => {
	const dir = createTestTempDirFromPath(
		join(tmpdir(), "pi-marker-contention-"),
	);
	const path = join(dir, "context.db");
	const db = createTestDb(path);
	const blocker = new Database(path);
	try {
		expect(
			freezePiContentDecision(db, "marker-session", "reminder-strip", "prior"),
		).toBe(true);
		const prior = getPiContentDecisions(db, "marker-session");
		db.exec("PRAGMA busy_timeout=1");
		blocker.exec("BEGIN IMMEDIATE");
		expect(
			freezePiContentDecision(db, "marker-session", "reminder-strip", "next"),
		).toBe(false);
		expect(getPiContentDecisions(db, "marker-session")).toEqual(prior);
		blocker.exec("ROLLBACK");
		expect(
			freezePiContentDecision(db, "marker-session", "reminder-strip", "next"),
		).toBe(true);
		expect(getPiContentDecisions(db, "marker-session")).not.toEqual(prior);
	} finally {
		blocker.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

it("Node Pi bootstrap retains its timeout and async admission waits out a short pending-op writer", async () => {
	const dir = createTestTempDirFromPath(join(tmpdir(), "pi-node-admission-"));
	const path = join(dir, "context.db");
	const db = createTestDb(path);
	const blocker = new Database(path);
	let child: ReturnType<typeof Bun.spawn> | undefined;
	try {
		insertTag(db, "node-wait", "message", "message", 3, 1);
		queuePendingOp(db, "node-wait", 1, "drop");
		const storage = new URL(
			"../../plugin/src/features/magic-context/storage-db.ts",
			import.meta.url,
		).pathname;
		const operations = new URL(
			"../../plugin/src/hooks/magic-context/apply-operations.ts",
			import.meta.url,
		).pathname;
		const entry = join(dir, "entry.ts");
		writeFileSync(
			entry,
			`
import { openDatabase } from ${JSON.stringify(storage)};
import { applyPendingOperations } from ${JSON.stringify(operations)};
import { withAsyncPrivilegedWriter } from ${JSON.stringify(new URL("../../plugin/src/shared/sqlite.ts", import.meta.url).pathname)};
const db = openDatabase(${JSON.stringify(path)});
process.stdout.write('READY ' + db.prepare('PRAGMA busy_timeout').get().timeout + '\\n');
await new Promise(resolve => process.stdin.once('data', resolve));
process.stdout.write('ADMITTING\\n');
const start = performance.now();
await withAsyncPrivilegedWriter(db, () => undefined);
const changed = applyPendingOperations('node-wait', db, new Map([[1, { setContent: () => true }]]), new Set());
process.stdout.write(JSON.stringify({ changed, elapsed: performance.now() - start }) + '\\n');
db.close();
process.stdin.destroy();
`,
		);
		const built = await Bun.build({
			entrypoints: [entry],
			outdir: dir,
			target: "node",
			format: "esm",
			splitting: true,
			external: ["node:sqlite", "bun:sqlite"],
		});
		expect(built.success).toBe(true);
		child = Bun.spawn(["node", join(dir, "entry.js")], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
		});
		const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		const ready = decoder.decode((await reader.read()).value);
		expect(
			ready,
			ready ? undefined : await new Response(child.stderr).text(),
		).toContain("READY 5000");
		blocker.exec("BEGIN IMMEDIATE");
		(child.stdin as { write(data: string): unknown }).write("go\n");
		expect(decoder.decode((await reader.read()).value)).toContain("ADMITTING");
		await new Promise((resolve) => setTimeout(resolve, 100));
		blocker.exec("ROLLBACK");
		let output = "";
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			output += decoder.decode(part.value);
		}
		const exit = await child.exited;
		const stderr = await new Response(
			child.stderr as ReadableStream<Uint8Array>,
		).text();
		expect({ exit, output: exit === 0 ? "" : stderr }).toEqual({
			exit: 0,
			output: "",
		});
		const result = JSON.parse(output.trim());
		expect(result.changed).toBe(true);
		expect(result.elapsed).toBeGreaterThanOrEqual(80);
		expect(getPendingOps(db, "node-wait")).toHaveLength(0);
	} finally {
		child?.kill();
		blocker.close();
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
}, 30000);

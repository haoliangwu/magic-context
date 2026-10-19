#!/usr/bin/env bun
/**
 * Two Pi processes serving one session from one shared context.db.
 *
 * The parent seeds the store, then drives two child processes, each with its
 * own SQLite connection and its own registerPiContextHandler. Every write one
 * child makes is a foreign write for the other, so their tag snapshots must
 * notice each other through `tag_revision:<session>`.
 *
 * First, in lockstep, the children take turns serving a growing transcript, with
 * seeded drops, flushes, model switches and direct tag edits from the parent's
 * connection between turns. The order is fixed, so the served-JSON SHA-256 and
 * persisted tag-row hash of every turn can be compared across two checkouts.
 *
 * Then, racing, both children serve the same transcript at the same time.
 * Interleavings vary between runs, so only invariants are checked: no failed
 * transform, every served §N§ number exists in the table, and no tag number
 * is stored twice.
 *
 *   bun scripts/experiments/perf/two-process-review.ts --seed 23 --output out.json
 *
 * All files live in a fresh $TMPDIR/magic-context/pi-two-process-review-*
 * root, which is removed at exit. No live store is opened.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { buildAccumulationPasses, generateSyntheticFixture } from "./fixtures";
import { canonicalHash } from "./instrumentation";

interface Command {
	point: number;
	model: string;
	usage: number;
}

interface Reply {
	wireHash: string;
	bytes: number;
	input: number;
	output: number;
	served: number[];
	error: string | null;
}

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
	const index = args.indexOf(name);
	return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const messages = Number(option("--messages", "700"));
const sessionId = "mc-pi-perf-synthetic";

function isolate(root: string) {
	process.env.MAGIC_CONTEXT_TEST_DATA_DIR = root;
	process.env.XDG_DATA_HOME = root;
	process.env.XDG_CONFIG_HOME = join(root, "config");
	process.env.XDG_STATE_HOME = join(root, "state");
	process.env.XDG_RUNTIME_DIR = join(root, "runtime");
	process.env.OPENCODE_DB = join(root, "opencode.db");
	process.env.MAGIC_CONTEXT_STORAGE_DIR = root;
	process.env.NODE_ENV = "test";
}

function seededRandom(seed: number): (limit: number) => number {
	let state = seed >>> 0;
	return (limit) => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
		return state % limit;
	};
}

function fakeContext(
	cwd: string,
	branchEntries: readonly SessionEntry[],
	command: Command,
): ExtensionContext {
	const byId = new Map(branchEntries.map((entry) => [entry.id, entry]));
	return {
		cwd,
		hasUI: false,
		signal: new AbortController().signal,
		ui: { notify: () => undefined },
		model: { provider: "anthropic", id: command.model, contextWindow: 400_000 },
		sessionManager: {
			getSessionId: () => sessionId,
			getLeafId: () => branchEntries.at(-1)?.id ?? null,
			getBranch: () => branchEntries as SessionEntry[],
			getEntry: (id: string) => byId.get(id),
		},
		getContextUsage: () => ({
			tokens: Math.round((400_000 * command.usage) / 100),
			percent: command.usage,
			contextWindow: 400_000,
		}),
	} as unknown as ExtensionContext;
}

async function child(root: string): Promise<void> {
	isolate(root);
	const [{ Database }, { initializeDatabase }, { setHarness }] =
		await Promise.all([
			import("@magic-context/core/shared/sqlite"),
			import("@magic-context/core/features/magic-context/storage-db"),
			import("@magic-context/core/shared/harness"),
		]);
	const { registerPiContextHandler, awaitInFlightHistorians } = await import(
		"../../../src/context-handler"
	);
	setHarness("pi");
	const db = new Database(join(root, "context.db"));
	initializeDatabase(db);
	const handlers = new Map<string, (...input: unknown[]) => unknown>();
	registerPiContextHandler(
		{
			on(event: string, handler: (...input: unknown[]) => unknown) {
				handlers.set(event, handler);
			},
		} as never,
		{
			db: db as never,
			protectedTags: 20,
			scheduler: { executeThresholdPercentage: 95 },
			heuristics: { caveman: { enabled: false, minChars: 2_000 } },
			injection: {
				memoryEnabled: false,
				injectDocs: false,
				injectionBudgetTokens: 4_000,
				temporalAwareness: false,
			},
		},
	);
	const handler = handlers.get("context");
	if (!handler) throw new Error("no context handler");
	const fixture = generateSyntheticFixture({ messages });
	const reply = (value: unknown) =>
		process.stdout.write(`@@${JSON.stringify(value)}\n`);
	reply({ ready: true });
	for await (const line of console) {
		if (line === "exit") break;
		const command = JSON.parse(line) as Command;
		const pass = buildAccumulationPasses(fixture, [command.point]).find(
			(candidate) => candidate.requestedMessages === command.point,
		);
		if (!pass) throw new Error(`no pass for ${command.point}`);
		const event = { messages: structuredClone(pass.messages) };
		const input = event.messages.length;
		const result = (await handler(
			event,
			fakeContext(fixture.cwd, pass.branchEntries, command),
		)) as { messages?: unknown[] } | undefined;
		const output = result?.messages ?? event.messages;
		const wire = JSON.stringify(output);
		await new Promise((done) => setTimeout(done, 150));
		await awaitInFlightHistorians();
		const error = (
			db
				.prepare(
					"SELECT last_transform_error AS error FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as { error?: string | null } | null
		)?.error;
		reply({
			wireHash: createHash("sha256").update(wire).digest("hex"),
			bytes: Buffer.byteLength(wire, "utf8"),
			input,
			output: output.length,
			served: [
				...new Set([...wire.matchAll(/§(\d+)§/g)].map((m) => Number(m[1]))),
			],
			error: error ?? null,
		} satisfies Reply);
	}
	db.close();
}

class ChildProcess {
	private buffer = "";
	private waiting: ((line: string) => void)[] = [];
	private lines: string[] = [];
	readonly process: ReturnType<typeof Bun.spawn>;
	constructor(root: string) {
		this.process = Bun.spawn(
			[
				"bun",
				import.meta.path,
				"--child",
				"--root",
				root,
				"--messages",
				String(messages),
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "inherit", env: process.env },
		);
		void this.pump();
	}
	private async pump() {
		const decoder = new TextDecoder();
		for await (const chunk of this.process
			.stdout as ReadableStream<Uint8Array>) {
			this.buffer += decoder.decode(chunk);
			let newline = this.buffer.indexOf("\n");
			while (newline >= 0) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				if (line.startsWith("@@")) {
					const waiter = this.waiting.shift();
					if (waiter) waiter(line.slice(2));
					else this.lines.push(line.slice(2));
				}
				newline = this.buffer.indexOf("\n");
			}
		}
	}
	next(): Promise<unknown> {
		const line = this.lines.shift();
		if (line !== undefined) return Promise.resolve(JSON.parse(line));
		return new Promise((done) =>
			this.waiting.push((value) => done(JSON.parse(value))),
		);
	}
	send(value: Command | "exit") {
		const stdin = this.process.stdin as import("bun").FileSink;
		stdin.write(
			`${typeof value === "string" ? value : JSON.stringify(value)}\n`,
		);
		stdin.flush();
	}
}

async function parent(): Promise<void> {
	const seed = Number(option("--seed", "23"));
	const start = Number(option("--start", "400"));
	const lockstep = Number(option("--passes", "60"));
	const race = Number(option("--race", "20"));
	const historical = Number(option("--historical", "3000"));
	const scratch = join(tmpdir(), "magic-context");
	mkdirSync(scratch, { recursive: true });
	const root = mkdtempSync(join(scratch, "pi-two-process-review-"));
	isolate(root);
	const [{ Database }, { initializeDatabase }, { runMigrations }] =
		await Promise.all([
			import("@magic-context/core/shared/sqlite"),
			import("@magic-context/core/features/magic-context/storage-db"),
			import("@magic-context/core/features/magic-context/migrations"),
		]);
	const db = new Database(join(root, "context.db"));
	initializeDatabase(db);
	runMigrations(db);
	db.exec("PRAGMA busy_timeout = 10000");
	// Old history the way a long session holds it: mostly tool tags with owners,
	// a third dropped and the rest compacted.
	const insert = db.prepare(
		`INSERT INTO tags (session_id, message_id, type, byte_size, reasoning_byte_size,
		   tag_number, harness, status, token_count, tool_name, tool_owner_message_id)
		 VALUES (?, ?, ?, ?, 0, ?, 'pi', ?, ?, ?, ?)`,
	);
	db.exec("BEGIN");
	for (let index = 0; index < historical; index += 1) {
		const tool = index % 3 !== 0;
		const owner = `historical-entry-${Math.floor(index / 3)}`;
		insert.run(
			sessionId,
			tool ? `historical-call-${index}` : `${owner}:p0`,
			tool ? "tool" : "message",
			tool ? 4_000 : 400,
			index + 1,
			index % 3 === 2 ? "dropped" : "compacted",
			tool ? 1_000 : 100,
			tool ? "read" : null,
			tool ? owner : null,
		);
	}
	db.exec("COMMIT");
	const rowsHash = () =>
		canonicalHash(
			db
				.prepare(
					`SELECT tag_number, message_id, type, status, drop_mode, tool_name,
					   input_byte_size, byte_size, reasoning_byte_size, caveman_depth,
					   tool_owner_message_id, entry_fingerprint, token_count,
					   input_token_count, reasoning_token_count, harness
					 FROM tags WHERE session_id = ? ORDER BY tag_number ASC, id ASC`,
				)
				.all(sessionId),
		);
	const numbers = () =>
		new Set(
			(
				db
					.prepare("SELECT tag_number AS n FROM tags WHERE session_id = ?")
					.all(sessionId) as { n: number }[]
			).map((row) => row.n),
		);
	const duplicates = () =>
		(
			db
				.prepare(
					"SELECT COUNT(*) AS n FROM (SELECT tag_number FROM tags WHERE session_id = ? GROUP BY tag_number HAVING COUNT(*) > 1)",
				)
				.get(sessionId) as { n: number }
		).n;
	const children = [new ChildProcess(root), new ChildProcess(root)];
	const random = seededRandom(seed);
	let model = "claude-sonnet-4-5";
	let point = start;
	const lockstepRows: unknown[] = [];
	const raceRows: unknown[] = [];
	const violations: string[] = [];
	const check = (label: string, reply: Reply) => {
		if (reply.error)
			violations.push(`${label}: transform error ${reply.error}`);
		const stored = numbers();
		const missing = reply.served.filter((number) => !stored.has(number));
		if (missing.length)
			violations.push(
				`${label}: served numbers not in table ${missing.join(",")}`,
			);
		const duplicated = duplicates();
		if (duplicated)
			violations.push(`${label}: ${duplicated} duplicated tag numbers`);
	};
	try {
		for (const worker of children) await worker.next();
		for (let step = 0; step < lockstep; step += 1) {
			// Fixed draw order keeps the schedule identical on every checkout.
			const roll = Array.from({ length: 4 }, () => random(100));
			const pick = random(1_000_000);
			point = Math.min(messages, point + random(4));
			const events: string[] = [];
			const active = (
				db
					.prepare(
						"SELECT tag_number AS n FROM tags WHERE session_id = ? AND status = 'active' ORDER BY tag_number",
					)
					.all(sessionId) as { n: number }[]
			).map((row) => row.n);
			if ((roll[0] ?? 100) < 20 && active.length) {
				const tag = active[pick % active.length];
				db.prepare(
					"INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', ?, 'pi')",
				).run(sessionId, tag, 1_750_000_000_000 + step);
				events.push(`drop:${tag}`);
			}
			const flush = (roll[1] ?? 100) < 10;
			if (flush) events.push("flush");
			if ((roll[2] ?? 100) < 8) {
				model =
					model === "claude-sonnet-4-5"
						? "claude-opus-4-1"
						: "claude-sonnet-4-5";
				events.push(`model:${model}`);
			}
			if ((roll[3] ?? 100) < 8 && active.length) {
				const tag = active[(pick >>> 3) % active.length];
				db.prepare(
					"UPDATE tags SET status = 'dropped' WHERE session_id = ? AND tag_number = ?",
				).run(sessionId, tag);
				events.push(`parent-drop:${tag}`);
			} else if ((roll[3] ?? 100) < 25) {
				const tag = 1 + (pick % historical);
				db.prepare(
					"UPDATE tags SET byte_size = byte_size + 1 WHERE session_id = ? AND tag_number = ?",
				).run(sessionId, tag);
				events.push(`parent-rewrite:${tag}`);
			}
			const which = step % 2;
			const worker = children[which];
			if (!worker) continue;
			worker.send({ point, model, usage: flush ? 96 : 0.25 });
			const reply = (await worker.next()) as Reply;
			check(`lockstep ${step} child ${which}`, reply);
			lockstepRows.push({
				step,
				child: which,
				point,
				events,
				wireHash: reply.wireHash,
				bytes: reply.bytes,
				input: reply.input,
				output: reply.output,
				rowsHash: rowsHash(),
			});
		}
		for (let step = 0; step < race; step += 1) {
			point = Math.min(messages, point + random(3));
			const command = { point, model, usage: 0.25 };
			for (const worker of children) worker.send(command);
			const replies = (await Promise.all(
				children.map((worker) => worker.next()),
			)) as Reply[];
			for (const [index, reply] of replies.entries())
				check(`race ${step} child ${index}`, reply);
			raceRows.push({
				step,
				point,
				wireHashes: replies.map((reply) => reply.wireHash),
				served: replies.map((reply) => reply.served.length),
			});
		}
	} finally {
		for (const worker of children) worker.send("exit");
		await Promise.all(children.map((worker) => worker.process.exited));
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
	const report = {
		seed,
		messages,
		start,
		lockstep: lockstepRows,
		race: raceRows,
		violations,
	};
	const output = option("--output", "");
	if (output)
		writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
	console.log(
		`seed ${seed}: ${lockstepRows.length} lockstep turns, ${raceRows.length} race rounds, ${violations.length} invariant violations`,
	);
	for (const violation of violations) console.log(`  ${violation}`);
}

if (args.includes("--child")) await child(option("--root", ""));
else await parent();

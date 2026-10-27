import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "../context-handler";
import { __setPiHarnessKindForTesting } from "../pi-harness-kind";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "../test-utils.test";

const root = process.env.PROBE_ROOT;
if (!root) throw new Error("PROBE_ROOT must be a throwaway directory");
mkdirSync(root, { recursive: true });
const mode = process.argv[2] ?? "lock";
if (mode === "lock") {
	const path = join(root, "probe.db");
	const db = createTestDb(path);
	db.exec("PRAGMA busy_timeout=5000");
	const fake = createFakePi();
	const entries: unknown[] = [];
	Object.assign(fake.pi, {
		getAllTools: () => [],
		appendEntry: (_: unknown, data: unknown) => entries.push(data),
	});
	registerPiContextHandler(fake.pi as never, { db, compactionOff: true });
	const holder = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); db.exec('BEGIN IMMEDIATE'); console.log('HELD'); setTimeout(() => {db.exec('COMMIT'); db.close();}, 32000);`,
			path,
		],
		{ stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
	);
	await new Promise<void>((resolve, reject) => {
		holder.stdout.on("data", (b) => {
			if (String(b).includes("HELD")) resolve();
		});
		holder.once("exit", () => reject(new Error("holder exited")));
	});
	const raw = [userMessage("held writer reproduction", 1)];
	let aborted = false;
	const ctx = Object.assign(fakeContext("probe", root, ["u"], raw), {
		abort: () => {
			aborted = true;
		},
	});
	const start = performance.now();
	try {
		const result = await (
			fake.handlers.get("context") as (
				event: unknown,
				ctx: unknown,
			) => Promise<unknown>
		)({ messages: raw }, ctx);
		console.log(
			JSON.stringify({
				runtime: process.version,
				mode,
				elapsedMs: performance.now() - start,
				aborted,
				entries,
				result,
			}),
		);
	} finally {
		holder.kill();
		db.close();
		clearContextHandlerSession("probe");
	}
} else if (mode === "parity") {
	const outputs: Record<string, unknown[]> = {};
	let seed = 770;
	const rand = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 2 ** 32;
	};
	for (const harness of ["pi", "omp"] as const) {
		__setPiHarnessKindForTesting(harness);
		outputs[harness] = [];
		const db = createTestDb();
		const fake = createFakePi();
		Object.assign(fake.pi, { getAllTools: () => [] });
		registerPiContextHandler(fake.pi as never, { db });
		let history: ReturnType<typeof userMessage>[] = [];
		for (let pass = 0; pass < 300; pass++) {
			const session = `${harness}-${Math.floor(pass / 3)}`;
			if (pass % 3 === 0)
				history = Array.from(
					{ length: 1 + Math.floor(rand() * 15) },
					(_, i) => {
						const text = Array.from(
							{ length: 1 + Math.floor(rand() * 60) },
							() => Math.floor(rand() * 36).toString(36),
						).join("");
						return i % 2
							? assistantMessage(text, i + 1)
							: userMessage(text, i + 1);
					},
				);
			if (pass % 3 === 1) {
				if (history.length % 2)
					history.push(assistantMessage(`reply ${rand()}`, history.length + 1));
				history.push(userMessage(`append ${rand()}`, history.length + 1));
			}
			const raw = structuredClone(history);
			const ctx = Object.assign(
				fakeContext(
					session,
					root,
					raw.map((_, i) => `e${i}`),
					raw,
				),
				{
					model: {
						provider: "openai",
						id: "gpt-5",
						api: "openai-responses",
						contextWindow: 100000,
						maxTokens: 10000,
					},
					getSystemPrompt: () => "fixed system",
				},
			);
			const result = await (
				fake.handlers.get("context") as (
					event: unknown,
					ctx: unknown,
				) => Promise<unknown>
			)({ messages: raw }, ctx);
			if (!JSON.stringify(result).includes("§"))
				throw new Error(`unmanaged parity pass ${session}`);
			outputs[harness].push(result);
			if (pass % 3 === 2) clearContextHandlerSession(session);
		}
		db.close();
	}
	const output = process.argv[3];
	if (!output) throw new Error("parity output path required");
	writeFileSync(output, JSON.stringify(outputs));
	console.log(
		`PARITY runtime=${process.version} pi=300 omp=300 output=${output}`,
	);
} else throw new Error(`unknown mode ${mode}`);

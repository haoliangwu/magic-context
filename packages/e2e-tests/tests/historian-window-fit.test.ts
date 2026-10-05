/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TestHarness } from "../src/harness";
import {
	buildMockHistorianPayload,
	findHistorianOrdinalRange,
} from "../src/mock-historian";

/**
 * The historian sizes its prompt to its own model's window on a real OpenCode
 * host.
 *
 * Before, the chunk budget was a share of the historian window with no room
 * reserved for the ~15k-token system prompt, the seed examples, recent
 * compartments or the project-memory block. On a small historian window every
 * prompt overflowed, admission refused it on every idle without counting a
 * failure, and each refused attempt opened one more hidden child session.
 *
 * - A 64k historian window keeps producing compartments with chunks sized to
 *   fit (the mock model is uncalibrated, so admission counts every token
 *   twice and the system prompt alone takes ~30k of it).
 * - A 32k historian window cannot hold the system prompt at all once the
 *   output reserve is taken: one counted failure, later triggers back off, no
 *   historian request reaches the provider, and no hidden child session is
 *   created. (OpenCode reports no window below 20k to the plugin, which then
 *   sends unguarded, so 32k is the small window that is actually enforced.)
 *
 * Opt in only from a throwaway root: $TMPDIR must be a directory named
 * `issue-595` under a `magic-context` directory (the opt-in marker),
 * with HOME and every storage and config path under it; the host process is
 * checked with lsof to hold only throwaway databases.
 */

const root = realpathSync(tmpdir());
const enabled = /\/magic-context\/issue-595(?:\/|$)/.test(root);
const ISOLATED_ENV = [
	"HOME",
	"XDG_DATA_HOME",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
	"OPENCODE_DB",
	"MAGIC_CONTEXT_STORAGE_DIR",
	// macOS system frameworks (the host's HTTP cache) resolve the home folder from
	// the account record, not HOME, unless this override is set.
	...(process.platform === "darwin" ? ["CFFIXED_USER_HOME"] : []),
];

/** The host inherits this process's environment; every store path must be throwaway. */
function assertIsolatedEnvironment(): void {
	for (const name of ISOLATED_ENV) {
		const value = process.env[name];
		expect(value, name).toBeTruthy();
		expect(
			resolve(value ?? "").startsWith(`${root}/`) ||
				resolve(value ?? "").startsWith(`${tmpdir()}/`),
			name,
		).toBe(true);
	}
}
const HISTORIAN_SYSTEM_MARKER =
	"the hippocampus of a long-running coding agent";

function isHistorianRequest(body: Record<string, unknown>): boolean {
	return JSON.stringify(body.system ?? "").includes(HISTORIAN_SYSTEM_MARKER);
}

function assertIsolatedProcess(pid: number): string[] {
	const opened = execFileSync("lsof", ["-Fn", "-p", String(pid)], {
		encoding: "utf8",
		windowsHide: true,
	});
	const dbPaths = opened
		.split("\n")
		.filter((line) => line.startsWith("n/") && /\.db(?:-wal|-shm)?$/.test(line))
		.map((line) => line.slice(1));
	console.log(
		`historian-window-fit lsof pid=${pid} db=${JSON.stringify(dbPaths)}`,
	);
	expect(dbPaths.length).toBeGreaterThan(0);
	for (const path of dbPaths)
		expect(resolve(path).startsWith(`${root}/`)).toBe(true);
	return dbPaths;
}

function pluginLog(h: TestHarness): string {
	const path = join(h.dataDir, "cortexkit", "magic-context-e2e.log");
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

async function listSessionIds(h: TestHarness): Promise<string[]> {
	const client = h.client as unknown as {
		session: {
			list: (opts: {
				query: { directory: string };
			}) => Promise<{ data?: Array<{ id: string }> }>;
		};
	};
	const listed = await client.session.list({ query: { directory: h.workdir } });
	return (listed.data ?? []).map((session) => session.id).sort();
}

function answerHistorianWithCompartment(h: TestHarness): void {
	h.mock.addMatcher((body) => {
		if (!isHistorianRequest(body)) return null;
		const range = findHistorianOrdinalRange(body);
		if (!range) return null;
		return {
			text: buildMockHistorianPayload({
				start: range.start,
				end: range.end,
				title: `Window fit ${range.start}-${range.end}`,
				body: "Turns driven by the issue 595 window-fit scenario.",
			}),
			usage: {
				input_tokens: 500,
				output_tokens: 200,
				cache_creation_input_tokens: 500,
				cache_read_input_tokens: 0,
			},
		};
	});
}

const highUsage = {
	text: "high usage",
	usage: {
		input_tokens: 90_000,
		output_tokens: 20,
		cache_creation_input_tokens: 90_000,
		cache_read_input_tokens: 0,
	},
};

(enabled ? test : test.skip)(
	"a 64k historian window keeps producing compartments with chunks sized to fit",
	async () => {
		assertIsolatedEnvironment();
		const h = await TestHarness.create({
			historianMockModel: { id: "mock-historian-64k", contextLimit: 64_000 },
			magicContextConfig: { execute_threshold_percentage: 40 },
		});
		try {
			answerHistorianWithCompartment(h);
			const sessionId = await h.createSession();
			for (let turn = 1; turn <= 10; turn += 1) {
				await h.sendPrompt(
					sessionId,
					`turn ${turn}: durable signal. ${h.ballast(3_000)}`,
				);
			}
			h.mock.setDefault(highUsage);
			// Keep usage over the execute threshold so every idle can start a run.
			for (let turn = 11; turn <= 18; turn += 1) {
				await h.sendPrompt(
					sessionId,
					`turn ${turn}: keep going. ${h.ballast(1_000)}`,
				);
				await h.waitForMockQuiescence({ quietMs: 500 });
				const count = h.countCompartments(sessionId);
				if (count >= 2) break;
			}
			await h.waitFor(() => h.countCompartments(sessionId) >= 2, {
				timeoutMs: 60_000,
				label: "two compartments from the 64k historian",
			});

			const compartments = h
				.contextDb()
				.prepare(
					"SELECT start_message, end_message FROM compartments WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as Array<{
				start_message: number;
				end_message: number;
			}>;
			const runs = h
				.contextDb()
				.prepare(
					"SELECT status, failure_reason, chunk_start_ordinal, chunk_end_ordinal FROM historian_runs WHERE session_id = ? ORDER BY id",
				)
				.all(sessionId) as Array<{
				status: string;
				failure_reason: string | null;
				chunk_start_ordinal: number | null;
				chunk_end_ordinal: number | null;
			}>;
			const historianRequests = h.mock
				.requests()
				.filter((r) => isHistorianRequest(r.body));
			const fitLines = pluginLog(h)
				.split("\n")
				.filter((line) => line.includes("historian prompt fit: sized to"));
			console.log(`compartments=${JSON.stringify(compartments)}`);
			console.log(`historian_runs=${JSON.stringify(runs)}`);
			console.log(`historian requests=${historianRequests.length}`);
			console.log(`fit log=${JSON.stringify(fitLines.slice(0, 3))}`);

			expect(compartments.length).toBeGreaterThanOrEqual(2);
			expect(historianRequests.length).toBeGreaterThanOrEqual(2);
			expect(
				runs.filter((run) => run.status === "success").length,
			).toBeGreaterThanOrEqual(2);
			expect(
				runs.some((run) => /producer_prompt/.test(run.failure_reason ?? "")),
			).toBe(false);
			// The chunk was cut down to fit the window rather than the 16k-token
			// share of the window the budget used to ask for.
			expect(fitLines.length).toBeGreaterThan(0);
			assertIsolatedProcess(h.opencode.pid);
		} finally {
			await h.dispose();
		}
	},
	600_000,
);

(enabled ? test : test.skip)(
	"a 32k historian window fails once, backs off, and opens no hidden child session",
	async () => {
		assertIsolatedEnvironment();
		const h = await TestHarness.create({
			historianMockModel: { id: "mock-historian-32k", contextLimit: 32_000 },
			magicContextConfig: { execute_threshold_percentage: 40 },
		});
		try {
			answerHistorianWithCompartment(h);
			const sessionId = await h.createSession();
			for (let turn = 1; turn <= 10; turn += 1) {
				await h.sendPrompt(
					sessionId,
					`turn ${turn}: durable signal. ${h.ballast(3_000)}`,
				);
			}
			const sessionsBefore = await listSessionIds(h);
			h.mock.setDefault(highUsage);
			for (let turn = 11; turn <= 18; turn += 1) {
				await h.sendPrompt(sessionId, `turn ${turn}: keep going.`);
				await h.waitForMockQuiescence({ quietMs: 500 });
			}
			await h.waitFor(
				() => {
					const meta = h
						.contextDb()
						.prepare(
							"SELECT compartment_in_progress FROM session_meta WHERE session_id = ?",
						)
						.get(sessionId) as { compartment_in_progress: number } | null;
					return (meta?.compartment_in_progress ?? 1) === 0;
				},
				{ timeoutMs: 30_000, label: "historian idle" },
			);
			const sessionsAfter = await listSessionIds(h);

			const runs = h
				.contextDb()
				.prepare(
					"SELECT status, failure_reason FROM historian_runs WHERE session_id = ? ORDER BY id",
				)
				.all(sessionId) as Array<{
				status: string;
				failure_reason: string | null;
			}>;
			const meta = h
				.contextDb()
				.prepare(
					"SELECT historian_failure_count, historian_last_error FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as {
				historian_failure_count: number;
				historian_last_error: string | null;
			} | null;
			const log = pluginLog(h);
			const childOpens = log
				.split("\n")
				.filter((line) =>
					line.includes("historian: creating child session"),
				).length;
			const backoffs = log
				.split("\n")
				.filter((line) =>
					line.includes("prompt still cannot fit the historian model"),
				).length;
			const historianRequests = h.mock
				.requests()
				.filter((r) => isHistorianRequest(r.body));
			console.log(`historian_runs=${JSON.stringify(runs)}`);
			console.log(`session_meta=${JSON.stringify(meta)}`);
			console.log(
				`sessions before=${JSON.stringify(sessionsBefore)} after=${JSON.stringify(sessionsAfter)}`,
			);
			console.log(
				`child opens=${childOpens} backoff no-ops=${backoffs} historian requests=${historianRequests.length}`,
			);

			const failed = runs.filter((run) => run.status === "failed");
			expect(failed).toHaveLength(1);
			expect(failed[0]?.failure_reason).toContain("producer_prompt_unfit");
			// Later triggers back off on the unchanged reason instead of failing again.
			expect(
				runs.filter(
					(run) =>
						run.status === "noop" &&
						run.failure_reason === failed[0]?.failure_reason,
				).length,
			).toBeGreaterThanOrEqual(1);
			expect(backoffs).toBeGreaterThanOrEqual(1);
			expect(meta?.historian_failure_count).toBe(1);
			expect(meta?.historian_last_error).toContain("producer_prompt_unfit");
			expect(historianRequests).toHaveLength(0);
			expect(childOpens).toBe(0);
			expect(sessionsAfter).toEqual(sessionsBefore);
			assertIsolatedProcess(h.opencode.pid);
		} finally {
			await h.dispose();
		}
	},
	600_000,
);

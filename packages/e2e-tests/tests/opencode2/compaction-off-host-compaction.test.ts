import { expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { gaDatabasePath } from "../../../plugin/src/v2/store-reader";
import { readPluginLog, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

/**
 * With Magic Context's compaction off, the host's own compaction must run for a
 * user session exactly as if Magic Context registered no compaction hook.
 *
 * Magic Context registers its compaction hook in every mode, because hidden
 * children need an answer even when compaction is off. For a user session in
 * compaction-off mode the hook leaves `result` unset. This pins that an unset
 * result is a clean decline on the real host: the host summarizes with the
 * model, stores a completed checkpoint, and the turn goes on to the provider
 * with that checkpoint, instead of recording `compaction.failed` and ending the
 * turn.
 */
const TEMPLATE_PROMPT = "You MUST use this format for your response";
const SUMMARY = "## Objective\n- keep the fixture conversation going\n\n## Next Move\n1. answer the next turn";
const WINDOW = 20_000;

test("with compaction off, the host's own compaction of a user session succeeds and the turn continues", async () => {
	const host = await spawnOpencode2({
		modelContextLimit: WINDOW,
		magicContextConfig: {
			compaction: { enabled: false },
			memory: { enabled: false },
			historian: { disable: true },
			dreamer: { disable: true },
		},
	});
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			title: "compaction off",
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.addMatcher((body) =>
			JSON.stringify(body).includes(TEMPLATE_PROMPT)
				? { text: SUMMARY, usage: { input_tokens: 400, output_tokens: 40 } }
				: null,
		);
		// The first reply reports a prompt just under the window, so the measured size
		// alone puts the next turn over the host's compaction threshold.
		host.mock.setDefault({
			text: "first reply",
			usage: { input_tokens: WINDOW - 600, output_tokens: 10 },
		});
		const turn = async (text: string) => {
			await client.session.prompt({ sessionID: session.id, text });
			await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(60_000) });
		};
		await turn("first turn");
		host.mock.setDefault({ text: "second reply", usage: { input_tokens: 600, output_tokens: 10 } });
		const before = host.mock.requests().length;
		await turn("second turn");

		const rows = (() => {
			const db = new Database(gaDatabasePath(host.env.XDG_DATA_HOME as string, "latest", host.env), {
				readonly: true,
			});
			try {
				return (
					db
						.prepare("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq")
						.all(session.id) as Array<{ type: string; data: string }>
				).map((row) => ({ type: row.type, data: JSON.parse(row.data) as Record<string, unknown> }));
			} finally {
				db.close();
			}
		})();
		const compactions = rows.filter((row) => row.type === "compaction");
		console.log(
			`[compaction-off] host=${process.env.MC_E2E_OPENCODE2_CLI ?? "pinned"} rows=${rows.map((row) => row.type).join(",")} compactions=${JSON.stringify(compactions.map((row) => ({ status: row.data.status, reason: row.data.reason, summary: String(row.data.summary).slice(0, 40) })))} requests=${host.mock.requests().length}`,
		);
		// The host's own model-written summary, stored as completed checkpoints: some
		// releases compact again once the first checkpoint's measured size is known,
		// so the count is the host's business, but every one must be the host's own
		// summary and none may have failed.
		expect(compactions.length).toBeGreaterThan(0);
		for (const compaction of compactions) {
			expect(compaction.data.status).toBe("completed");
			expect(String(compaction.data.summary)).toContain("## Objective");
		}
		const idle = rows.filter((row) => row.type === "idle").at(-1);
		expect(idle?.data.outcome).not.toBe("failed");

		const after = host.mock.requests().slice(before).map((request) => JSON.stringify(request.body));
		const summaryRequest = after.findIndex((body) => body.includes(TEMPLATE_PROMPT));
		expect(summaryRequest).toBeGreaterThanOrEqual(0);
		// The turn then reached the provider, opening with the host's checkpoint.
		const continued = after.slice(summaryRequest + 1);
		expect(continued.some((body) => body.includes("conversation-checkpoint") && body.includes("second turn"))).toBe(
			true,
		);
		expect(readPluginLog(host.env)).not.toContain("v2 compaction hook: fired");
	} catch (error) {
		console.error(host.stderr(), readPluginLog(host.env));
		throw error;
	} finally {
		await host.stop();
	}
}, 180_000);

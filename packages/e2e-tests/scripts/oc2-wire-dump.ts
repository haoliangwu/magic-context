// Boot the real GA OpenCode 2 host with Magic Context loaded, drive a few turns through
// the mock provider, and print what the model actually receives: the system prompt,
// the tag placement on every message, and the persisted assistant text bytes. Used to
// separate "the model echoes the tag" from "the host persists the tagged draft".
import { OpenCode } from "@opencode/client";
import { spawnOpencode2, waitForPluginActive } from "../src/opencode2-runner/spawn";

const host = await spawnOpencode2({
	magicContextConfig: {
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
		location: { directory: host.cwd },
		model: { providerID: "openai", id: "mock-model" },
	});
	await waitForPluginActive(client, host.cwd);
	// A reply that starts with a tag-shaped token, the way a model that echoes would answer.
	host.mock.setDefault({ text: "§7§ echo reply body", usage: { input_tokens: 100, output_tokens: 10 } });
	const turn = async (text: string) => {
		await client.session.prompt({ sessionID: session.id, text });
		await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20_000) });
	};
	await turn("first user turn");
	host.mock.setDefault({ text: "plain second reply", usage: { input_tokens: 100, output_tokens: 10 } });
	await turn("second user turn");
	await turn("third user turn");

	// OpenCode 2 talks to the openai provider over the Responses API: the transcript is
	// `input`, the system prompt is `instructions`.
	const requests = host.mock.requests().filter((r) => r.path.includes("responses"));
	const last = requests.at(-1)!;
	const body = last.body as Record<string, unknown>;
	const rawSys = body.instructions ?? body.system;
	const sys = Array.isArray(rawSys) ? rawSys : [rawSys];
	const input = (body.input ?? body.messages ?? []) as Array<{ role: string; content: unknown; type?: string }>;
	console.log("=== requests captured:", requests.length);
	console.log("=== system entries:", sys.length);
	for (const [i, s] of sys.entries()) {
		const text = typeof s === "string" ? s : JSON.stringify(s);
		console.log(`system[${i}] len=${text.length} hasGuidance=${text.includes("§N§")} head=${JSON.stringify(text.slice(0, 120))}`);
	}
	console.log("=== messages on the last request:");
	for (const [i, m] of input.entries()) {
		const c = m.content;
		const summary = Array.isArray(c)
			? c.map((p: any) => `${p.type}:${JSON.stringify(String(p.text ?? p.name ?? "").slice(0, 50))}`).join(" | ")
			: JSON.stringify(String(c).slice(0, 80));
		console.log(`[${i}] ${m.role ?? m.type} ${summary}`);
	}
	const guidanceAt = String(sys[0]).indexOf("§N§");
	console.log("=== guidance excerpt:", JSON.stringify(String(sys[0]).slice(Math.max(0, guidanceAt - 200), guidanceAt + 400)));
	console.log("=== persisted assistant rows (throwaway store):");
	const { readdirSync } = await import("node:fs");
	const { join } = await import("node:path");
	const dataDir = join(host.env.XDG_DATA_HOME!, "opencode");
	const dbs = readdirSync(dataDir).filter((f) => f.endsWith(".db"));
	console.log("store files:", dbs.join(", "));
	const { Database } = await import("bun:sqlite");
	for (const f of dbs) {
		const db = new Database(join(dataDir, f), { readonly: true });
		const tables = db.query("select name from sqlite_master where type='table'").all() as { name: string }[];
		console.log(f, "tables:", tables.map((t) => t.name).join(","));
		if (tables.some((t) => t.name === "session_message")) {
			const cols = db.query("pragma table_info(session_message)").all() as { name: string }[];
			console.log(" session_message columns:", cols.map((c) => c.name).join(","));
			const rows = db.query("select * from session_message order by rowid").all() as Record<string, unknown>[];
			for (const r of rows) {
				console.log(` row type=${r.type} seq=${r.seq} data=${JSON.stringify(String(r.data).slice(0, 220))}`);
			}
		}
		db.close();
	}
} finally {
	await host.stop();
}

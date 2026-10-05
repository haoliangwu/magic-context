import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MockProvider } from "../src/mock-provider/server";
import { PI_CLI, PI_PACKAGE_JSON } from "../src/pi-runner/spawn";

const host = process.argv[2] ?? "pi";
const base = join(tmpdir(), "magic-context/issue-581");
mkdirSync(base, { recursive: true });
const root = realpathSync(mkdtempSync(join(base, `${host}-`)));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
const env: Record<string, string> = {
	PATH: process.env.PATH!,
	HOME: root,
	PI_CODING_AGENT_DIR: agentDir,
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
};
for (const key of [
	"XDG_DATA_HOME",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"XDG_RUNTIME_DIR",
	"XDG_CACHE_HOME",
	"MAGIC_CONTEXT_STORAGE_DIR",
]) {
	env[key] = join(root, key);
	mkdirSync(env[key]);
}
env.OPENCODE_DB = join(root, "opencode.db");
env.TMPDIR = root;
const mock = new MockProvider();
const { baseURL } = await mock.start();
mock.setDefault({
	text: "PROBE_DONE_581",
	usage: { input_tokens: 100, output_tokens: 10 },
});
let asked = false;
mock.addMatcher((body) => {
	const name = host === "omp" ? "_ask" : "question";
	if (asked || !JSON.stringify(body.tools ?? []).includes(`"${name}"`))
		return null;
	asked = true;
	return {
		content: [
			{
				type: "tool_use",
				id: "answer581",
				name,
				input:
					host === "omp"
						? {
								questions: [
									{
										id: "q",
										question: "CHOOSE_581",
										options: [{ label: "ANSWER_581" }],
									},
								],
							}
						: { question: "CHOOSE_581", options: [{ label: "ANSWER_581" }] },
			},
		],
		stop_reason: "tool_use",
		usage: { input_tokens: 100, output_tokens: 10 },
	};
});
const provider = {
	api: "anthropic-messages",
	baseUrl: baseURL,
	apiKey: "mock-key",
	models: [
		{
			id: "mock-model",
			name: "Mock",
			reasoning: false,
			input: ["text"],
			contextWindow: 200000,
			maxTokens: 8192,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	],
};
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({ providers: { mock: provider } }),
);
writeFileSync(
	join(agentDir, host === "omp" ? "config.yml" : "settings.json"),
	JSON.stringify({
		defaultProvider: "mock",
		defaultModel: "mock-model",
		compaction: { enabled: false },
		tools: { xdev: false, intentTracing: false },
		enableInstallTelemetry: false,
	}),
);
const cli = host === "omp" ? process.env.ISSUE_581_OMP_CLI! : PI_CLI;
const args = [
	process.execPath,
	cli,
	"--provider",
	"mock",
	"--model",
	"mock-model",
	"--session",
	join(root, "session.jsonl"),
];
if (host !== "omp")
	args.push(
		"-e",
		join(dirname(PI_PACKAGE_JSON), "examples/extensions/question.ts"),
	);
args.push("PROBE_581");
let output = "";
const terminal = new Bun.Terminal({
	cols: 100,
	rows: 30,
	data(_terminal, data) {
		output += Buffer.from(data).toString();
	},
});
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
	child = Bun.spawn(args, { cwd: root, env, terminal });
	await Bun.sleep(1500);
	const lsof = Bun.spawnSync([
		"lsof",
		"-p",
		String(child.pid),
	]).stdout.toString();
	writeFileSync(join(root, "lsof.txt"), lsof);
	if (
		!lsof ||
		/\/Users\/[^\s]+\/(?:\.config\/(?:opencode|cortexkit)|\.local\/share\/(?:opencode|cortexkit\/magic-context))/.test(
			lsof,
		)
	)
		throw new Error("live store isolation failed");
	for (let n = 0; n < 20; n++) {
		if (output.includes("CHOOSE_581")) terminal.write("\r");
		if (
			mock
				.requests()
				.some(
					(request) =>
						JSON.stringify(request.body.messages).includes("ANSWER_581") &&
						request.body.messages?.some((message) =>
							JSON.stringify(message.content).includes("tool_result"),
						),
				)
		)
			break;
		await Bun.sleep(1000);
	}
	terminal.write("\u0003\u0003");
	await Bun.sleep(500);
	child.kill();
	await child.exited;
	writeFileSync(join(root, "terminal.txt"), output);
	writeFileSync(
		join(root, "requests.json"),
		JSON.stringify(mock.requests(), null, 2),
	);
	const transcript = readFileSync(join(root, "session.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const results = transcript.filter(
		(entry) => entry.message?.role === "toolResult",
	);
	console.log(JSON.stringify({ root, host, results }, null, 2));
	if (
		!results.some(
			(entry) =>
				!entry.message.isError &&
				JSON.stringify(entry.message.details).includes("ANSWER_581"),
		)
	)
		throw new Error("real host answer not captured");
} finally {
	child?.kill();
	terminal.close();
	await mock.stop();
}

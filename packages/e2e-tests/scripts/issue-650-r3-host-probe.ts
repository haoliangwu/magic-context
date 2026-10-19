import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { PiTestHarness } from "../src/pi-harness";

const root = process.env.ISSUE_650_R3_ROOT;
const install = process.env.ISSUE_650_R3_INSTALL_ROOT;
const host = process.env.ISSUE_650_R3_HOST;
if (
	!root ||
	!install ||
	!isAbsolute(root) ||
	!isAbsolute(install) ||
	!["pi", "omp"].includes(host ?? "")
) {
	throw new Error(
		"Set absolute ISSUE_650_R3_ROOT, ISSUE_650_R3_INSTALL_ROOT and ISSUE_650_R3_HOST=pi|omp",
	);
}
mkdirSync(root, { recursive: true });
const taskRoot = realpathSync(root);
if (!taskRoot.includes(`${sep}magic-context${sep}issue-650-r3`))
	throw new Error("Not a task-isolated root");
process.env.TMPDIR = taskRoot;
const version = host === "pi" ? "1.1.0" : "18.8.7";
const packageName =
	host === "pi"
		? "@earendil-works/pi-coding-agent"
		: "@oh-my-pi/pi-coding-agent";
const packageJson = join(
	install,
	`${host}-${version}`,
	"node_modules",
	packageName,
	"package.json",
);
if (JSON.parse(readFileSync(packageJson, "utf8")).version !== version)
	throw new Error("Wrong host version");
process.env[
	host === "pi" ? "MC_E2E_PI_PACKAGE_JSON" : "MC_E2E_OMP_PACKAGE_JSON"
] = packageJson;
const evidence = join(taskRoot, `${host}-context.jsonl`);
writeFileSync(evidence, "");
const extension = join(taskRoot, `${host}-shape.ts`);
writeFileSync(
	extension,
	`
import { appendFileSync } from "node:fs";
export default function shape(pi) {
 let armed = false, phase = 0, anchor;
 const notes = [0,1,2].map(n => ({role:"user",content:"unsaved host context note " + n,timestamp:1000+n}));
 pi.registerCommand("r3-arm", {description:"Enable isolated reporter fixture",handler:async (_args,ctx) => { armed=true; anchor=ctx.sessionManager.getLeafId(); }});
 pi.registerCommand("r3-rewind", {description:"Return to the fixture branch anchor",handler:async (_args,ctx) => { await ctx.navigateTree(anchor,{summarize:false}); }});
 pi.on("context", (event,ctx) => {
  if (!armed) return;
  const messages=structuredClone(event.messages);
  if (${JSON.stringify(host)} === "pi") {
   for (const m of messages) if (m.role === "toolResult") for (const p of m.content) if(p.type === "text") p.text="compacted output: probe650";
  } else {
   const at=phase++ % 2 === 0 ? 0 : Math.floor(messages.length/2);
   messages.splice(at,0,...structuredClone(notes));
  }
  appendFileSync(${JSON.stringify(evidence)},JSON.stringify({stage:"input",count:messages.length,unsaved:${host === "omp" ? 3 : 0},branch:ctx.sessionManager.getBranch().length})+"\\n");
  return {messages};
 });
}
`,
);
const rewind = join(
	install,
	"omp-18.8.7",
	"node_modules/pi-rewind/src/index.ts",
);
const harness = await PiTestHarness.create({
	host: host as "pi" | "omp",
	workdirIsHome: true,
	magicContextConfig: {
		memory: { enabled: false },
		embedding: { provider: "off" },
	},
	extensionsBeforeMagicContext: [
		extension,
		...(host === "omp" ? [rewind] : []),
	],
});
const base = realpathSync(dirname(harness.dataDir));
function audit(label: string) {
	const pid = harness.hostPid;
	if (!pid) throw new Error("Missing host pid");
	const result = Bun.spawnSync(["lsof", "-p", String(pid)]);
	const text = result.stdout.toString();
	writeFileSync(join(taskRoot, `${host}-${label}-lsof.txt`), text);
	const paths = text
		.split("\n")
		.filter((line) => /\.db(?:-(?:wal|shm))?$/.test(line))
		.map((line) => line.trim().split(/\s+/).slice(8).join(" "));
	if (
		result.exitCode !== 0 ||
		(!paths.length && label !== "startup") ||
		paths.some((path) => !resolve(path).startsWith(base + sep))
	)
		throw new Error(
			`Database isolation failed for pid ${pid}: ${JSON.stringify(paths)}`,
		);
	return { pid, paths };
}
try {
	const startup = audit("startup");
	if (host === "omp") {
		for (let n = 0; n < 17; n++)
			await harness.sendPrompt(`warmup ${n}`, { timeoutMs: 30000 });
	}
	await harness.invokeExtensionCommand("r3-arm");
	if (host === "pi")
		harness.mock.enqueue({
			content: [
				{
					type: "tool_use",
					id: "call650",
					name: "bash",
					input: { command: "printf probe650" },
				},
			],
			stop_reason: "tool_use",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
	await harness.sendPrompt("reporter shape first", { timeoutMs: 30000 });
	await harness.sendPrompt("reporter shape shifted", { timeoutMs: 30000 });
	if (host === "omp") await harness.invokeExtensionCommand("r3-rewind");
	await harness.sendPrompt("reporter shape final", { timeoutMs: 30000 });
	const final = audit("final");
	const requests = harness.requests();
	writeFileSync(
		join(taskRoot, `${host}-requests.json`),
		JSON.stringify(requests, null, 2),
	);
	const messages = readFileSync(evidence, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const state = await harness.getState();
	if (!state.sessionId) throw new Error("Host did not report a session id");
	const db = harness.contextDb();
	const tags = db
		.prepare(
			"SELECT tag_number,message_id,tool_owner_message_id FROM tags WHERE session_id = ?",
		)
		.all(state.sessionId) as Array<{
		tag_number: number;
		message_id: string;
		tool_owner_message_id: string | null;
	}>;
	const tools = tags.filter((row) => row.message_id === "call650");
	if (host === "pi" && tools.length !== 1)
		throw new Error(`One tool identity expected: ${JSON.stringify(tools)}`);
	if (
		host === "omp" &&
		!messages.some(
			(frame) =>
				frame.unsaved / frame.count >= 0.07 &&
				frame.unsaved / frame.count <= 0.08,
		)
	)
		throw new Error("Fixture did not reach 7–8% unsaved slots");
	const shapeRequests = requests.slice(-3);
	let noteNumbers: number[][] = [];
	if (
		host === "pi" &&
		!shapeRequests.some((request) =>
			JSON.stringify(request.body).includes("compacted output: probe650"),
		)
	)
		throw new Error("Rewritten output never reached the provider");
	if (host === "omp") {
		noteNumbers = shapeRequests.map((request) => {
			const matches = [
				...JSON.stringify(request.body).matchAll(
					/§(\d+)§ unsaved host context note (\d)/g,
				),
			];
			if (matches.length !== 3)
				throw new Error("Provider did not receive all three tagged notes");
			return matches
				.sort((a, b) => Number(a[2]) - Number(b[2]))
				.map((match) => Number(match[1]));
		});
		if (
			noteNumbers.some(
				(numbers) => JSON.stringify(numbers) !== JSON.stringify(noteNumbers[0]),
			)
		)
			throw new Error("Note tag numbers changed after moving or rewinding");
	}
	const result = {
		host,
		version,
		startup,
		final,
		servedShapeTurns: 3,
		requests: requests.length,
		frames: messages,
		tools,
		noteNumbers,
		diagnostics: harness.diagnostics(),
	};
	writeFileSync(
		join(taskRoot, `${host}-result.json`),
		JSON.stringify(result, null, 2),
	);
	console.log(JSON.stringify(result, null, 2));
} finally {
	await harness.dispose();
}

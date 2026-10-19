import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MockProvider } from "../src/mock-provider/server";

const base = join(tmpdir(), "magic-context/issue-650");
mkdirSync(base, { recursive: true });
const root = realpathSync(mkdtempSync(join(base, "host-")));
const env: Record<string, string> = {
	PATH: process.env.PATH!,
	HOME: root,
	TMPDIR: root,
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
	ISSUE_650_HOST: process.env.ISSUE_650_HOST!,
	ISSUE_650_CODEMODE: process.env.ISSUE_650_CODEMODE ?? "0",
	ISSUE_650_MESSAGE: process.env.ISSUE_650_MESSAGE ?? "0",
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
const mock = new MockProvider();
const { baseURL } = await mock.start();
env.ISSUE_650_MOCK = baseURL;
if (env.ISSUE_650_MESSAGE !== "1")
	mock.enqueue({
		content: [
			{
				type: "tool_use",
				id: "call650",
				name: env.ISSUE_650_CODEMODE === "1" ? "codemode" : "bash",
				input:
					env.ISSUE_650_CODEMODE === "1"
						? {
								code: 'console.log(await tools.bash({command: "printf probe650"}))',
							}
						: { command: "printf probe650" },
			},
		],
		stop_reason: "tool_use",
		usage: { input_tokens: 100, output_tokens: 10 },
	});
mock.setDefault({
	text: "done",
	usage: {
		input_tokens: env.ISSUE_650_MESSAGE === "1" ? 178473 : 100,
		output_tokens: 10,
	},
});
const child = Bun.spawn(["node", resolve(process.argv[2]!)], {
	cwd: root,
	env,
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
});
let stdout = "";
const timeout = setTimeout(() => child.kill(), 30000);
function auditIsolation(file: string): void {
	const audit = Bun.spawnSync([
		"lsof",
		"-p",
		String(child.pid),
	]).stdout.toString();
	writeFileSync(join(root, file), audit);
	const dbLines = audit.split("\n").filter((line) => /\.db(?:\b|-)/.test(line));
	if (
		!dbLines.length ||
		dbLines.some((line) => !line.includes(root)) ||
		/\/Users\/[^\s]+\/(?:\.config\/(?:opencode|cortexkit)|\.local\/share\/(?:opencode|cortexkit\/magic-context))/.test(
			audit,
		)
	) {
		child.kill();
		throw new Error("live-store isolation failed");
	}
}
const reader = (async () => {
	for await (const chunk of child.stdout) {
		stdout += Buffer.from(chunk).toString();
		console.log(Buffer.from(chunk).toString());
		if (stdout.includes("READY") && !stdout.includes("ISOLATION_CHECKED")) {
			auditIsolation("lsof.txt");
			stdout += "\nISOLATION_CHECKED\n";
			child.stdin.write("start\n");
			child.stdin.flush();
		}
		if (
			stdout.includes("AUDIT_COMPLETE") &&
			!stdout.includes("FINAL_ISOLATION_CHECKED")
		) {
			auditIsolation("lsof-final.txt");
			stdout += "\nFINAL_ISOLATION_CHECKED\n";
			child.stdin.write("audited\n");
			child.stdin.flush();
		}
	}
})();
try {
	const stderr = await new Response(child.stderr).text();
	await reader;
	const exitCode = await child.exited;
	writeFileSync(join(root, "stdout.txt"), stdout);
	writeFileSync(join(root, "stderr.txt"), stderr);
	writeFileSync(
		join(root, "requests.json"),
		JSON.stringify(mock.requests(), null, 2),
	);
	console.log(
		JSON.stringify({
			root,
			exitCode,
			requests: mock.requests().length,
			stdout,
			stderr,
		}),
	);
	if (exitCode !== 0) process.exitCode = 1;
} finally {
	clearTimeout(timeout);
	child.kill();
	await mock.stop();
}

/**
 * Runs the real OpenCode 2 TUI on a pseudo-terminal and captures what it paints.
 *
 * The TUI only renders when stdout is a terminal, so the host is started under
 * `script`, which allocates a PTY and mirrors every byte the program writes into
 * a typescript file. `stty` inside that PTY fixes the window size, because what
 * the sidebar can fit depends on how much width it is given.
 *
 * The two `script` implementations take their arguments differently and neither
 * accepts the other's form, so the invocation is chosen per platform:
 *   - BSD/macOS: `script [-q] file command ...`
 *   - util-linux: `script -qefc "command" file`
 * BSD `script` also refuses to start when its own stdin is a socket
 * ("tcgetattr/ioctl: Operation not supported on socket"), which is what a piped
 * stdin is under Bun, so stdin is /dev/null.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertOpenPaths, CLI } from "./spawn";

/** Control sequences OpenTUI emits around the cells the assertions read. */
const ANSI =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal control sequences is the point
	/\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B[()][A-Za-z0-9]|\u001B[=>]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

export function stripAnsi(value: string): string {
	return value.replace(ANSI, "");
}

/**
 * The `script` process and everything below it. Descendants are collected by
 * parent, not by process group: BSD `script` puts the program it runs in a new
 * session, so a pgid sweep sees only `script` itself and would report an empty
 * fd table for the host — a live-store check that can never fail.
 */
export function processTreePids(pid: number): number[] {
	const ps = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
	if (ps.status !== 0) throw new Error("Cannot inspect the TUI process tree");
	const children = new Map<number, number[]>();
	for (const line of ps.stdout.trim().split("\n")) {
		const [child, parent] = line.trim().split(/\s+/).map(Number);
		if (child === undefined || parent === undefined) continue;
		children.set(parent, [...(children.get(parent) ?? []), child]);
	}
	const found: number[] = [];
	const queue = [pid];
	while (queue.length > 0) {
		const current = queue.shift() as number;
		if (found.includes(current)) continue;
		found.push(current);
		queue.push(...(children.get(current) ?? []));
	}
	return found;
}

/** Every filesystem path the TUI process tree has open, via lsof. */
function treeOpenPaths(pid: number): { paths: string[]; writable: string[] } {
	const pids = processTreePids(pid).map(String);
	if (!pids.length) return { paths: [], writable: [] };
	const result = spawnSync("lsof", ["-p", pids.join(","), "-Ffn"], {
		encoding: "utf8",
	});
	// lsof exits non-zero when some sampled pid has already gone; its output for
	// the surviving ones is still complete and is what the guard reads.
	const paths: string[] = [];
	const writable: string[] = [];
	let fd = "";
	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("f")) fd = line.slice(1);
		if (!line.startsWith("n")) continue;
		const path = line.slice(1);
		paths.push(path);
		if (/[0-9]+[wu]$/.test(fd)) writable.push(path);
	}
	return { paths, writable };
}

/**
 * The live-store rule for this lane: the TUI process group may hold open only
 * databases inside its throwaway root. `assertOpenPaths` already refuses the
 * operator's `~/.local/share/opencode` tree; this adds the stricter statement
 * the rule asks for, so a store opened anywhere else outside the root — a
 * different XDG base, a stray absolute path in config — also fails.
 */
function assertOnlyThrowawayDatabases(paths: string[], root: string): string[] {
	const databases = paths.filter((path) => path.endsWith(".db"));
	const escaped = databases.filter(
		(path) => path !== root && !path.startsWith(`${root}/`),
	);
	if (escaped.length > 0)
		throw new Error(`TUI opened a database outside its throwaway root: ${escaped.join(", ")}`);
	return databases;
}

export interface TuiCaptureOptions {
	/** Throwaway roots from `isolation()`; the TUI boots entirely inside them. */
	readonly env: NodeJS.ProcessEnv;
	readonly root: string;
	readonly cwd: string;
	readonly sessionID: string;
	/**
	 * Keystrokes typed into the TUI once it has booted, in order, with a pause
	 * between them. Anything a user reaches by typing — a slash command, a dialog
	 * — needs these: `script` gives the TUI a PTY but no keyboard, because its own
	 * stdin must be /dev/null (see above). A capture that asks for keys is driven
	 * by `expect`, which owns both the PTY and its input.
	 */
	readonly keys?: readonly string[];
	/**
	 * Text that says the TUI has finished booting, waited for before the first
	 * keystroke. Defaults to the footer hint an OpenCode 2 TUI paints once it is
	 * interactive.
	 */
	readonly readyMarker?: string;
	/** Seconds to keep reading after `readyMarker` before the first keystroke. */
	readonly settleSeconds?: number;
	/** Capture stops as soon as every marker is present in the stripped text. */
	readonly markers: readonly (string | RegExp)[];
	readonly timeoutMs?: number;
	readonly rows?: number;
	readonly cols?: number;
}

export interface TuiCapture {
	/** Everything the TUI wrote, with control sequences removed. */
	readonly text: string;
	readonly raw: string;
	readonly matched: boolean;
	readonly missing: string[];
	readonly elapsedMs: number;
	/** Whether the fd table was sampled while the TUI was alive. */
	readonly sampled: boolean;
	/** Databases the TUI process group held open; all inside the throwaway root. */
	readonly openDatabases: string[];
	/** Every path the TUI process group held open at the last sample. */
	readonly openPaths: string[];
}

function hasMarker(text: string, marker: string | RegExp): boolean {
	return typeof marker === "string" ? text.includes(marker) : marker.test(text);
}

function scriptArguments(command: string, logPath: string): string[] {
	return process.platform === "darwin"
		? ["-q", logPath, "/bin/sh", "-c", command]
		: ["-qefc", command, logPath];
}

/** `script` is what allocates the PTY; without it there is no terminal to capture. */
export function ptyCaptureAvailable(): boolean {
	return existsSync("/usr/bin/script") || existsSync("/bin/script");
}

const EXPECT_BINARIES = ["/usr/bin/expect", "/bin/expect", "/usr/local/bin/expect"];

/** `expect` is what types into the PTY; without it a keyed capture cannot run. */
export function ptyInputAvailable(): boolean {
	return EXPECT_BINARIES.some((path) => existsSync(path));
}

/**
 * A Tcl quoted word. Besides `\`, `"`, `$` and brackets, control characters
 * have to be written as escapes rather than embedded raw: a carriage return
 * inside the quoted string is read as a line ending, which silently truncates
 * the command instead of sending Enter to the TUI.
 */
function tclQuote(value: string): string {
	const escaped = value.replace(/[\\"$[\]]|[\u0000-\u001f]/g, (character) => {
		if (character === "\r") return "\\r";
		if (character === "\n") return "\\n";
		if (character === "\t") return "\\t";
		const code = character.charCodeAt(0);
		return code < 0x20
			? `\\x${code.toString(16).padStart(2, "0")}`
			: `\\${character}`;
	});
	return `"${escaped}"`;
}

/**
 * An expect program that boots the TUI on its own PTY, waits for the host to
 * finish painting, then types each key with a pause so the TUI can react to it.
 * `expect` only reads the child's output while it is waiting for a pattern, and
 * that is also when it writes the log file — so every pause is written as a
 * pattern that cannot match: it reads for the whole timeout, then continues.
 */
function expectProgram(
	options: TuiCaptureOptions,
	logPath: string,
	command: string,
): string {
	const never = "__opencode2_tui_capture_never_matches__";
	const pause = (seconds: number) => [
		`set timeout ${seconds}`,
		`expect ${tclQuote(never)}`,
	];
	return [
		`log_file -a ${tclQuote(logPath)}`,
		`spawn /bin/sh -c ${tclQuote(command)}`,
		"set timeout 90",
		`expect ${tclQuote(options.readyMarker ?? "ctrl+p")}`,
		// The footer appears before the session and the plugins have finished
		// loading, and a keystroke typed into a TUI that is still starting is
		// dropped. This settle is what makes the first key land.
		...pause(options.settleSeconds ?? 12),
		...(options.keys ?? []).flatMap((key) => [
			`send -- ${tclQuote(key)}`,
			...pause(4),
		]),
		...pause(10),
		"exit 0",
		"",
	].join("\n");
}

export async function captureTui(options: TuiCaptureOptions): Promise<TuiCapture> {
	const rows = options.rows ?? 48;
	const cols = options.cols ?? 200;
	const logPath = join(options.root, "opencode2-tui.typescript");
	const command = [
		`stty rows ${rows} cols ${cols}`,
		`exec ${JSON.stringify(CLI)} --standalone --print-logs --session ${JSON.stringify(options.sessionID)}`,
	].join("; ");
	const driven = (options.keys?.length ?? 0) > 0;
	if (driven && !ptyInputAvailable())
		throw new Error("Cannot type into the TUI: expect is not installed");
	const programPath = join(options.root, "opencode2-tui.exp");
	if (driven) writeFileSync(programPath, expectProgram(options, logPath, command));
	const child = driven
		? spawn(
				EXPECT_BINARIES.find((path) => existsSync(path)) as string,
				["-f", programPath],
				{
					cwd: options.cwd,
					env: options.env,
					detached: true,
					stdio: ["ignore", "pipe", "pipe"],
				},
			)
		: spawn("script", scriptArguments(command, logPath), {
				cwd: options.cwd,
				env: options.env,
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
	let stdout = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk) => {
		stdout += chunk.toString();
	});
	const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));

	const started = Date.now();
	const deadline = started + (options.timeoutMs ?? 120_000);
	let openDatabases: string[] = [];
	let openPaths: string[] = [];
	let sampled = false;
	let text = "";
	let raw = "";
	let missing = options.markers.map(String);
	const read = () => {
		raw = existsSync(logPath) ? readFileSync(logPath, "utf8") : raw;
		text = `${stripAnsi(raw)}\n${stripAnsi(stdout)}`;
		missing = options.markers.filter((marker) => !hasMarker(text, marker)).map(String);
	};
	try {
		while (Date.now() < deadline) {
			read();
			const alive = child.exitCode === null && child.signalCode === null;
			if (alive && child.pid) {
				const { paths, writable } = treeOpenPaths(child.pid);
				if (paths.length > 0) {
					assertOpenPaths(paths, options.root, [], writable);
					const databases = assertOnlyThrowawayDatabases(paths, options.root);
					// Keep the sample that actually shows the host holding stores
					// open: an fd table taken before it reaches its database proves
					// nothing about which database it reaches.
					if (databases.length >= openDatabases.length) {
						openDatabases = databases;
						openPaths = paths;
					}
					sampled = true;
				}
			}
			if ((missing.length === 0 && openDatabases.length > 0) || !alive) break;
			await Bun.sleep(250);
		}
	} finally {
		if (child.pid) {
			// Kill the descendants first, for the same reason the fd sample walks
			// them: the host is not in `script`'s process group, so a group kill
			// would leave a real OpenCode host running against the throwaway root.
			for (const target of processTreePids(child.pid).reverse()) {
				try {
					process.kill(target, "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
		}
		await Promise.race([exited, Bun.sleep(5_000)]);
	}
	read();
	return {
		text,
		raw,
		matched: missing.length === 0,
		missing,
		elapsedMs: Date.now() - started,
		sampled,
		openDatabases,
		openPaths,
	};
}

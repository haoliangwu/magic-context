import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { log } from "./logger";
import { PI_IMAGE_NAMES, piHarnessKindFromExecutable } from "./pi-executable";
import { canonicalProjectDirectory } from "./project-directory-key";

export type ProcessKind = "OpenCode server" | "OpenCode instance (TUI/CLI)" | "Pi" | "process";

/** Best-effort process details captured while validating a migration blocker. */
export interface ProcessProbeEvidence {
    /** Epoch milliseconds, or null when the platform/probe cannot provide it. */
    startTime: number | null;
    /** The raw command line, or null when the platform/probe cannot provide it. */
    commandLine: string | null;
    /**
     * The executable image name when the process list reports it separately
     * from the command line (Windows CIM and tasklist), otherwise absent.
     */
    imageName?: string | null;
}

export interface RpcPortFileRecord {
    port: number;
    pid: number;
    started_at: number;
    /** Optional producer-provided kind; older records omit it. */
    kind?: string;
    /** Compatibility with discovery records that used the harness name. */
    harness?: string;
    /**
     * Per-process bearer token. The server requires it on all non-health RPC
     * calls so a random local process or browser-origin script that merely
     * discovers/guesses the port cannot drive side-effecting endpoints
     * (recomp/upgrade/dismiss). Optional in the type for forward/backward
     * compatibility with port files written by older builds (treated as "no
     * auth required" only when the server itself didn't set one).
     */
    token?: string;
    /** Per-server filename nonce; prevents same-process instances from sharing one file. */
    instance_id?: string;
}

/**
 * RPC server instances started by this process. The storage migration guard reads
 * the same discovery files to find live hosts that may still run an older build;
 * a server this process started runs this process's own build, so its discovery
 * file must never count as such a host. Without this, a process that was refused
 * once and retries after its own RPC server has started would find itself as the
 * blocker and refuse forever.
 */
const ownRpcServerInstanceIds = new Set<string>();

export function registerOwnRpcServerInstance(instanceId: string): () => void {
    ownRpcServerInstanceIds.add(instanceId);
    return () => {
        ownRpcServerInstanceIds.delete(instanceId);
    };
}

/** Whether a discovery record belongs to an RPC server started by this process. */
export function isOwnRpcServerRecord(
    record: Pick<RpcPortFileRecord, "pid" | "instance_id">,
): boolean {
    return (
        record.pid === process.pid &&
        record.instance_id !== undefined &&
        ownRpcServerInstanceIds.has(record.instance_id)
    );
}

/**
 * Stable hash for a project directory — scopes RPC port files per-project
 * so multiple OpenCode instances don't collide.
 *
 * The server that writes a discovery file and the TUI that looks it up often
 * receive the same directory spelled differently (macOS `/var` vs
 * `/private/var`; on Windows drive-letter case, separators, a trailing
 * separator, `\\?\` prefixes, 8.3 short names). Both hash the one canonical
 * spelling from `canonicalProjectDirectory`, so any of those spellings finds the
 * same file.
 */
export function projectHash(directory: string): string {
    return createHash("sha256")
        .update(canonicalProjectDirectory(directory))
        .digest("hex")
        .slice(0, 16);
}

/**
 * The hash builds up to 0.44.4 used: the spelling as given, minus trailing
 * slashes. Lookups also read that directory so a TUI can still find an older
 * server (and tell the user it is older).
 */
export function legacyProjectHash(directory: string): string {
    const normalized = directory.replace(/\/+$/, "");
    return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** Directory containing per-process RPC discovery files for a project. */
export function rpcPortDir(storageDir: string, directory: string): string {
    return join(storageDir, "rpc", projectHash(directory));
}

/**
 * Every directory a lookup reads for this project: the canonical one servers
 * write now, and the pre-canonical one older servers wrote.
 */
export function rpcPortDirsForLookup(storageDir: string, directory: string): string[] {
    const canonical = rpcPortDir(storageDir, directory);
    const legacy = join(storageDir, "rpc", legacyProjectHash(directory));
    return legacy === canonical ? [canonical] : [canonical, legacy];
}

/** Per-process RPC port file path. */
export function rpcPortFilePath(
    storageDir: string,
    directory: string,
    pid = process.pid,
    instanceId?: string,
): string {
    const suffix = instanceId ? `-${instanceId}` : "";
    return join(rpcPortDir(storageDir, directory), `port-${pid}${suffix}.json`);
}

/** Legacy single-port file used by v0.18.0 and earlier. */
export function legacyRpcPortFilePath(storageDir: string, directory: string): string {
    return join(storageDir, "rpc", legacyProjectHash(directory), "port");
}

export type PidLiveness = "alive" | "dead" | "inconclusive";

/**
 * Check whether the platform confirms a PID is live without treating a denied
 * probe as confirmation. Windows uses tasklist because MSYS2/Cygwin ps does not
 * support the options used by the Unix probe. Sandboxes commonly reject
 * `kill(pid, 0)` with EPERM even when the PID does not exist outside their view.
 */
export function isPidAlive(pid: number): PidLiveness {
    if (!Number.isInteger(pid) || pid <= 0) return "dead";
    if (rpcIdentityPlatform === "win32") return readWindowsProcess(pid).state;
    try {
        rpcIdentityProcessKill(pid, 0);
        return "alive";
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "inconclusive";
    }
}

const RPC_IDENTITY_SKEW_TOLERANCE_MS = 120_000;
const LINUX_CLOCK_TICKS_PER_SECOND = 100;
const PS_PROBE_TIMEOUT_MS = 1_000;
const WINDOWS_CIM_PROBE_TIMEOUT_MS = 5_000;
const WINDOWS_PROCESS_SNAPSHOT_TTL_MS = 2_000;
const MAX_ANCESTOR_WALK_DEPTH = 16;
const OPEN_CODE_COMMAND_MARKERS = ["opencode", "node", "bun", "electron"];
// CreationDate is formatted in the query as an ISO-8601 UTC string. Left as a
// DateTime, ConvertTo-Json's output depends on the PowerShell edition (Windows
// PowerShell 5.1 can emit `\/Date(ms)\/` or an object wrapping it; PowerShell 7
// emits a local-offset string), and a start time the parser cannot read turns
// every live RPC holder's identity check inconclusive.
const WINDOWS_CIM_COMMAND =
    "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{Name='CreationDate';Expression={if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }}} | ConvertTo-Json -Compress";
/**
 * Output limit for process-list commands. A full Win32_Process listing with
 * command lines routinely exceeds the 1 MiB `execFileSync` default (browser and
 * editor processes carry very long command lines); past the limit the call
 * throws ENOBUFS and the probe falls back to tasklist, which reports no start
 * times.
 */
const PROCESS_LIST_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const PI_HARNESS_ARC_MARKERS = [
    "pi-coding-agent",
    "oh-my-pi",
    "@oh-my-pi",
    "cljs/dist",
    "dist/bundle/cli",
];
let rpcIdentityReadFileSync: typeof readFileSync = readFileSync;
let rpcIdentityExecFileSync: typeof execFileSync = execFileSync;
let rpcIdentityProcessKill: typeof process.kill = process.kill;
let rpcProcessListExecFileSync: typeof execFileSync = execFileSync;
let rpcProcessListTestOverride = false;
let rpcIdentityPlatform: NodeJS.Platform = process.platform;
let rpcIdentityNowMs: () => number = () => Date.now();

function parseLinuxProcessStartTime(statContent: string, uptimeContent: string): number | null {
    const closingCommandName = statContent.lastIndexOf(")");
    if (closingCommandName < 0) return null;

    // The fields after the command name begin at field 3 (`state`), so field 22
    // (`starttime`) is index 19 in this suffix. The command name can contain ')',
    // hence the last closing parenthesis rather than the first one is significant.
    const statFields = statContent
        .slice(closingCommandName + 1)
        .trim()
        .split(/\s+/);
    const startTimeTicks = Number(statFields[19]);
    const uptimeSeconds = Number(uptimeContent.trim().split(/\s+/)[0]);
    if (
        !Number.isFinite(startTimeTicks) ||
        startTimeTicks < 0 ||
        !Number.isFinite(uptimeSeconds) ||
        uptimeSeconds < 0
    ) {
        return null;
    }

    const processStartTime =
        rpcIdentityNowMs() -
        uptimeSeconds * 1_000 +
        (startTimeTicks / LINUX_CLOCK_TICKS_PER_SECOND) * 1_000;
    return Number.isFinite(processStartTime) ? processStartTime : null;
}

function readLinuxProcessStartTime(pid: number): number | null {
    try {
        const statContent = String(rpcIdentityReadFileSync(`/proc/${pid}/stat`, "utf8"));
        const uptimeContent = String(rpcIdentityReadFileSync("/proc/uptime", "utf8"));
        return parseLinuxProcessStartTime(statContent, uptimeContent);
    } catch {
        return null;
    }
}

function readPsProcessStartTime(pid: number): number | null {
    try {
        const output = rpcIdentityExecFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
            encoding: "utf8",
            timeout: PS_PROBE_TIMEOUT_MS,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        const processStartTime = Date.parse(String(output).trim());
        return Number.isFinite(processStartTime) ? processStartTime : null;
    } catch {
        return null;
    }
}

/** Read a process start time without changing the guard's liveness decision. */
export function readProcessStartTime(pid: number): number | null {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return rpcIdentityPlatform === "linux"
        ? readLinuxProcessStartTime(pid)
        : rpcIdentityPlatform === "win32"
          ? readWindowsProcessStartTime(pid)
          : readPsProcessStartTime(pid);
}

/** Capture the command and start-time probes used to explain a blocker. */
export function readProcessProbeEvidence(pid: number): ProcessProbeEvidence {
    return {
        startTime: readProcessStartTime(pid),
        commandLine: readProcessCommand(pid),
    };
}

function readCachedWindowsImageName(pid: number): string | null {
    return rpcIdentityPlatform === "win32"
        ? (windowsProcessFactsCache?.get(pid)?.imageName ?? null)
        : null;
}

interface ProcessListEntry {
    pid: number;
    command: string;
}

interface ProcessFacts {
    pid: number;
    parentPid: number | null;
    commandLine: string | null;
    imageName: string | null;
    startTime: number | null;
}

type ProcessSnapshotSource = "cim" | "tasklist" | "ps";

interface ProcessSnapshot {
    facts: ProcessFacts[];
    parentByPid: Map<number, number>;
    source: ProcessSnapshotSource;
}

let windowsProcessFactsCache: Map<number, ProcessFacts> | null = null;
let windowsProcessSnapshotCache: { snapshot: ProcessSnapshot; at: number } | null = null;

function rememberWindowsProcessFacts(facts: ProcessFacts[]): void {
    windowsProcessFactsCache = new Map(facts.map((fact) => [fact.pid, fact]));
}

function clearWindowsProcessFactsCache(): void {
    windowsProcessFactsCache = null;
    windowsProcessSnapshotCache = null;
}

function parseCsvLine(line: string): string[] | null {
    const fields: string[] = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '"') {
            if (quoted && line[index + 1] === '"') {
                field += '"';
                index += 1;
            } else {
                quoted = !quoted;
            }
        } else if (character === "," && !quoted) {
            fields.push(field);
            field = "";
        } else {
            field += character;
        }
    }
    if (quoted) return null;
    fields.push(field);
    return fields;
}

export function parseTasklistOutput(output: string): ProcessListEntry[] | null {
    const entries: ProcessListEntry[] = [];

    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        const fields = parseCsvLine(line);
        if (!fields) continue;
        if (fields[1]?.trim().toLowerCase() === "pid") {
            continue;
        }
        const pid = Number(fields[1]);
        if (!Number.isInteger(pid) || pid <= 0 || !fields[0]) continue;
        entries.push({ pid, command: fields[0] });
    }
    // Successful tasklist commands return localized prose when no PID matches.
    // Only CSV PID fields are evidence of a live process; failures are caught by the caller.
    return entries;
}

function readWindowsProcess(pid: number): { state: PidLiveness; command?: string } {
    try {
        const output = rpcIdentityExecFileSync(
            "tasklist",
            ["/FO", "CSV", "/NH", "/FI", `PID eq ${pid}`],
            {
                encoding: "utf8",
                timeout: PS_PROBE_TIMEOUT_MS,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            },
        );
        const entries = parseTasklistOutput(String(output));
        if (entries === null) return { state: "inconclusive" };
        const process = entries.find((entry) => entry.pid === pid);
        return process ? { state: "alive", command: process.command } : { state: "dead" };
    } catch {
        return { state: "inconclusive" };
    }
}

function readWindowsProcessStartTime(pid: number): number | null {
    const cached = windowsProcessFactsCache?.get(pid);
    if (cached) return cached.startTime;
    const snapshot = tryReadWindowsCimSnapshot(rpcIdentityExecFileSync);
    if (!snapshot) return null;
    rememberWindowsProcessFacts(snapshot.facts);
    return windowsProcessFactsCache?.get(pid)?.startTime ?? null;
}

function readLinuxProcessCommand(pid: number): string | null {
    try {
        return String(rpcIdentityReadFileSync(`/proc/${pid}/cmdline`, "utf8"));
    } catch {
        return null;
    }
}

function readPsProcessCommand(pid: number): string | null {
    try {
        const output = rpcIdentityExecFileSync("ps", ["-p", String(pid), "-o", "command="], {
            encoding: "utf8",
            timeout: PS_PROBE_TIMEOUT_MS,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        return String(output);
    } catch {
        return null;
    }
}

/** Reuse the platform-gated command probes used by PID identity checks. */
export function readProcessCommand(pid: number): string | null {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (rpcIdentityPlatform === "linux") return readLinuxProcessCommand(pid);
    if (rpcIdentityPlatform === "win32") {
        const cached = windowsProcessFactsCache?.get(pid);
        if (cached?.commandLine) return cached.commandLine;
        return readWindowsProcess(pid).command ?? null;
    }
    return readPsProcessCommand(pid);
}

function executableName(token: string | undefined): string {
    return (
        (token ?? "")
            .replace(/^['"]|['"]$/g, "")
            .split("/")
            .at(-1) ?? ""
    );
}

function commandTokens(command: string): string[] {
    return command
        .toLowerCase()
        .replaceAll("\\", "/")
        .replaceAll("\u0000", " ")
        .split(/\s+/)
        .map((token) => token.replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
}

function commandHasOpenCodeExecutable(tokens: readonly string[]): number {
    return tokens.findIndex((token) => {
        const executable = executableName(token).replace(/\.(?:exe|cmd)$/, "");
        return executable === "opencode" || executable.endsWith("/opencode");
    });
}

function commandHasPiExecutable(tokens: readonly string[]): boolean {
    for (let index = 0; index < tokens.length; index += 1) {
        const executable = executableName(tokens[index]).replace(/\.(?:exe|cmd)$/, "");
        if (piHarnessKindFromExecutable(executable) !== undefined) return true;
        if (["node", "bun", "deno"].includes(executable)) {
            const script = executableName(tokens[index + 1]).replace(/\.(?:exe|cmd)$/, "");
            if (
                ["pi", "pi.js", "pi.mjs", "pi.cjs"].includes(script) ||
                tokens[index + 1]?.includes("pi-coding-agent")
            ) {
                return true;
            }
        }
    }
    return false;
}

/** Classify a process command without changing the liveness decision. */
export function classifyProcessKind(command: string | null | undefined): ProcessKind {
    if (!command) return "process";
    const tokens = commandTokens(command);
    const openCodeIndex = commandHasOpenCodeExecutable(tokens);
    if (openCodeIndex >= 0) {
        const args = tokens.slice(openCodeIndex + 1);
        if (
            args.some(
                (token) => token === "serve" || token === "--serve" || token.startsWith("--serve="),
            )
        ) {
            return "OpenCode server";
        }
        return "OpenCode instance (TUI/CLI)";
    }
    return commandHasPiExecutable(tokens) ? "Pi" : "process";
}

function commandLooksLikeOpenCode(command: string): boolean {
    const normalized = command.toLowerCase();
    return OPEN_CODE_COMMAND_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Text found in the image name or command line of every process that can write
 * an RPC discovery record: OpenCode (CLI, server, desktop app, the CLI bundled
 * in OpenChamber), Pi and Oh My Pi, ck-mc, and the runtimes they run on. These
 * are matched as substrings, so a renamed or wrapped launch still counts as a
 * possible host. A false match only keeps a record, never deletes one.
 */
const RPC_HOST_PROCESS_MARKERS = [
    "opencode",
    "openchamber",
    "ck-mc",
    "magic-context",
    "cortexkit",
    "electron",
    "node",
    "bun",
    "deno",
    "pi-coding-agent",
    "oh-my-pi",
];

/**
 * Whether the process's image name or command line proves it cannot be a Magic
 * Context host. Pi's image names (`pi`, `omp`) are too short to match as
 * substrings, so they are compared as whole executable names. Missing evidence
 * is never proof: with neither field readable this returns false.
 */
export function processCannotBeRpcHost(
    evidence: Pick<ProcessProbeEvidence, "commandLine" | "imageName">,
): boolean {
    const texts = [evidence.imageName, evidence.commandLine].filter(
        (text): text is string => typeof text === "string" && text.trim().length > 0,
    );
    if (texts.length === 0) return false;
    for (const text of texts) {
        const normalized = text.toLowerCase();
        if (RPC_HOST_PROCESS_MARKERS.some((marker) => normalized.includes(marker))) return false;
        const tokens = commandTokens(text);
        if (commandHasPiExecutable(tokens)) return false;
        if (tokens.some((token) => piHarnessKindFromExecutable(token) !== undefined)) return false;
    }
    return true;
}

/**
 * Verify that a live PID still belongs to the process that wrote a port record.
 *
 * A PID can be reused after its original process exits. On Linux, procfs gives
 * us a process start time without spawning a helper; macOS and other Unix-like
 * platforms use `ps`, while Windows uses `tasklist`, only on this cold
 * database-open guard path. Legacy records without a start time use a weaker
 * command-name check. A failed filesystem or process probe is inconclusive,
 * not proof that this port record still belongs to OpenCode.
 *
 * "implausible" is returned only with proof that the live process did not write
 * the record: it started after the record's `started_at`, or its image cannot
 * be any Magic Context host. Callers may delete such a record on every platform.
 */
export type PidIdentityPlausibility = "plausible" | "implausible" | "inconclusive";

export function isPidIdentityPlausible(
    record: RpcPortFileRecord,
    evidence?: ProcessProbeEvidence,
): PidIdentityPlausibility {
    if (!Number.isInteger(record.pid) || record.pid <= 0) return "implausible";

    if (Number.isFinite(record.started_at) && record.started_at > 0) {
        const processStartTime = evidence ? evidence.startTime : readProcessStartTime(record.pid);
        if (processStartTime !== null) {
            // A host writes `started_at` after it starts, so a process that started
            // later than the record (beyond clock skew) cannot have written it: the
            // PID was reused and the record is stale.
            return processStartTime <= record.started_at + RPC_IDENTITY_SKEW_TOLERANCE_MS
                ? "plausible"
                : "implausible";
        }
        // Some start times cannot be read at all (Windows service hosts such as
        // svchost, when the query is not elevated). Then only an image that no host
        // can run proves the PID was reused; anything else stays unknown.
        const identity = evidence ?? {
            commandLine: readProcessCommand(record.pid),
            imageName: readCachedWindowsImageName(record.pid),
        };
        return processCannotBeRpcHost(identity) ? "implausible" : "inconclusive";
    }

    const command = evidence
        ? evidence.commandLine
        : rpcIdentityPlatform === "linux"
          ? readLinuxProcessCommand(record.pid)
          : rpcIdentityPlatform === "win32"
            ? (readWindowsProcess(record.pid).command ?? null)
            : readPsProcessCommand(record.pid);
    if (command === null) return "inconclusive";
    if (commandLooksLikeOpenCode(command)) return "plausible";
    // A record without a start time carries only a PID. Its process is proven
    // unrelated only when its image cannot be a host (Pi and OpenChamber, for
    // example, do not match the OpenCode markers above).
    return processCannotBeRpcHost({ commandLine: command, imageName: evidence?.imageName })
        ? "implausible"
        : "inconclusive";
}

export function __setRpcIdentityTestHooks(hooks: {
    readFileSync?: typeof readFileSync;
    execFileSync?: typeof execFileSync;
    processKill?: typeof process.kill;
    processListExecFileSync?: typeof execFileSync;
    platform?: NodeJS.Platform;
    nowMs?: () => number;
}): void {
    clearWindowsProcessFactsCache();
    rpcIdentityReadFileSync = hooks.readFileSync ?? readFileSync;
    rpcIdentityExecFileSync = hooks.execFileSync ?? execFileSync;
    rpcIdentityProcessKill = hooks.processKill ?? process.kill;
    rpcProcessListExecFileSync = hooks.processListExecFileSync ?? execFileSync;
    rpcProcessListTestOverride = hooks.processListExecFileSync !== undefined;
    rpcIdentityPlatform = hooks.platform ?? process.platform;
    rpcIdentityNowMs = hooks.nowMs ?? (() => Date.now());
}

export function __resetRpcIdentityTestHooks(): void {
    clearWindowsProcessFactsCache();
    rpcIdentityReadFileSync = readFileSync;
    rpcIdentityExecFileSync = execFileSync;
    rpcIdentityProcessKill = process.kill;
    rpcProcessListExecFileSync = execFileSync;
    rpcProcessListTestOverride = false;
    rpcIdentityPlatform = process.platform;
    rpcIdentityNowMs = () => Date.now();
}

function commandLooksLikePiImage(command: string): boolean {
    const tokens = commandTokens(command);
    const first = executableName(tokens[0]).replace(/\.(?:exe|cmd)$/, "");
    return PI_IMAGE_NAMES.has(first);
}

/**
 * A process is a verified Pi/OMP harness only when its command line names a
 * known package entry (pi-coding-agent, oh-my-pi, the bun/node cli shim).
 * Bare `omp.exe` / `pi.exe` image names are not enough: Windows tasklist
 * reports only the image, and that matches the session's own launcher shim.
 */
function commandHasPiHarnessArc(command: string): boolean {
    const normalized = command.trim().toLowerCase().replaceAll("\\", "/").replaceAll("\u0000", " ");
    if (!normalized) return false;
    const tokens = commandTokens(command);
    if (tokens.length === 0) return false;
    const hasArc = PI_HARNESS_ARC_MARKERS.some((marker) => normalized.includes(marker));
    const first = executableName(tokens[0]).replace(/\.(?:exe|cmd)$/, "");
    if (hasArc && ["pi", "omp", "oh-my-pi", "node", "bun", "deno", "cmd"].includes(first)) {
        return true;
    }
    if (hasArc && PI_HARNESS_ARC_MARKERS.some((marker) => tokens[0].includes(marker))) {
        return true;
    }
    if (["node", "bun", "deno"].includes(first)) {
        const script = executableName(tokens[1]).replace(/\.(?:exe|cmd)$/, "");
        if (["pi", "pi.js", "pi.mjs", "pi.cjs"].includes(script)) return true;
        if (hasArc) return true;
    }
    return false;
}

function execProcessList(
    exec: typeof execFileSync,
    file: string,
    args: readonly string[],
    timeout = PS_PROBE_TIMEOUT_MS,
): string {
    return String(
        exec(file, [...args], {
            encoding: "utf8",
            timeout,
            maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        }),
    );
}

function parseWindowsCreationDate(value: unknown): number | null {
    // Windows PowerShell 5.1 can serialize a DateTime carrying extended
    // properties as { value: "\/Date(ms)\/", DisplayHint, DateTime }.
    if (value !== null && typeof value === "object" && "value" in value) {
        return parseWindowsCreationDate((value as { value: unknown }).value);
    }
    if (typeof value === "number" && Number.isFinite(value)) {
        return value > 1e12 ? value : value * 1_000;
    }
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const wmi = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/.exec(trimmed);
    if (wmi) {
        const utcMs = Date.UTC(
            Number(wmi[1]),
            Number(wmi[2]) - 1,
            Number(wmi[3]),
            Number(wmi[4]),
            Number(wmi[5]),
            Number(wmi[6]),
            Number(wmi[7]) / 1_000,
        );
        if (!Number.isFinite(utcMs)) return null;
        const offsetMinutes = Number(wmi[9]);
        const sign = wmi[8] === "+" ? 1 : -1;
        return utcMs - sign * offsetMinutes * 60_000;
    }
    const dotNet = /^\/Date\((-?\d+)\)\/$/.exec(trimmed);
    if (dotNet) {
        const milliseconds = Number(dotNet[1]);
        return Number.isFinite(milliseconds) ? milliseconds : null;
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseWindowsCimOutput(output: string): ProcessFacts[] | null {
    const trimmed = output.trim();
    if (!trimmed) return null;
    const bracket = trimmed.indexOf("[");
    const brace = trimmed.indexOf("{");
    const start = Math.min(
        bracket === -1 ? Number.POSITIVE_INFINITY : bracket,
        brace === -1 ? Number.POSITIVE_INFINITY : brace,
    );
    if (!Number.isFinite(start)) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed.slice(start));
    } catch {
        return null;
    }
    if (parsed == null) return null;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const facts: ProcessFacts[] = [];
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const record = row as Record<string, unknown>;
        const pid = Number(record.ProcessId);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const parentRaw = record.ParentProcessId;
        const parentPid = parentRaw == null || parentRaw === "" ? Number.NaN : Number(parentRaw);
        const commandLine = typeof record.CommandLine === "string" ? record.CommandLine : null;
        facts.push({
            pid,
            parentPid: Number.isInteger(parentPid) && parentPid > 0 ? parentPid : null,
            commandLine,
            imageName:
                typeof record.Name === "string"
                    ? record.Name
                    : commandLine
                      ? executableName(commandTokens(commandLine)[0])
                      : null,
            startTime: parseWindowsCreationDate(record.CreationDate),
        });
    }
    return facts.length > 0 ? facts : null;
}

function snapshotFromFacts(facts: ProcessFacts[], source: ProcessSnapshotSource): ProcessSnapshot {
    const parentByPid = new Map<number, number>();
    for (const fact of facts) {
        if (fact.parentPid != null) parentByPid.set(fact.pid, fact.parentPid);
    }
    return { facts, parentByPid, source };
}

function tryReadWindowsCimSnapshot(exec: typeof execFileSync): ProcessSnapshot | null {
    try {
        const output = execProcessList(
            exec,
            "powershell",
            ["-NoProfile", "-Command", WINDOWS_CIM_COMMAND],
            WINDOWS_CIM_PROBE_TIMEOUT_MS,
        );
        const facts = parseWindowsCimOutput(output);
        return facts ? snapshotFromFacts(facts, "cim") : null;
    } catch {
        return null;
    }
}

function tryReadWindowsTasklistSnapshot(): ProcessSnapshot | null {
    try {
        const output = execProcessList(rpcProcessListExecFileSync, "tasklist", [
            "/FO",
            "CSV",
            "/NH",
        ]);
        const entries = parseTasklistOutput(output);
        if (entries === null) return null;
        const facts = entries.map((entry) => ({
            pid: entry.pid,
            parentPid: null,
            commandLine: null,
            imageName: entry.command,
            startTime: null,
        }));
        return snapshotFromFacts(facts, "tasklist");
    } catch {
        return null;
    }
}

function readPosixProcessSnapshot(): ProcessSnapshot {
    const output = execProcessList(rpcProcessListExecFileSync, "ps", ["-axo", "pid=,command="]);
    const facts: ProcessFacts[] = [];
    for (const line of output.split(/\r?\n/)) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!match) continue;
        const pid = Number(match[1]);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        facts.push({
            pid,
            parentPid: null,
            commandLine: match[2],
            imageName: executableName(commandTokens(match[2])[0]),
            startTime: null,
        });
    }
    return snapshotFromFacts(facts, "ps");
}

function readPosixParentPid(pid: number): number | null {
    try {
        const output = execProcessList(rpcProcessListExecFileSync, "ps", [
            "-o",
            "ppid=",
            "-p",
            String(pid),
        ]);
        const match = /^\s*(\d+)\s*$/.exec(output);
        if (!match) return null;
        const ppid = Number(match[1]);
        return Number.isInteger(ppid) && ppid > 0 ? ppid : null;
    } catch {
        return null;
    }
}

/**
 * Walk toward init from `selfPid` so the session's own launcher cannot be
 * treated as a foreign blocker. On Windows, OMP/Pi is two processes: a
 * long-lived `omp.exe`/`pi.exe` shim and the bun/node child where this
 * plugin runs. Bound the walk and stop on cycles so a broken parent map
 * cannot loop.
 */
function collectAncestorPids(
    selfPid: number,
    parentByPid: Map<number, number>,
    probeParents = true,
): Set<number> {
    const ancestors = new Set<number>();
    let current = selfPid;
    for (let depth = 0; depth < MAX_ANCESTOR_WALK_DEPTH; depth += 1) {
        let ppid: number | null = null;
        if (parentByPid.has(current)) {
            ppid = parentByPid.get(current) ?? null;
        } else if (rpcIdentityPlatform !== "win32" && probeParents) {
            ppid = readPosixParentPid(current);
            if (ppid == null && current === process.pid && process.ppid > 0) {
                ppid = process.ppid;
            }
        } else if (current === process.pid && process.ppid > 0) {
            ppid = process.ppid;
        } else {
            break;
        }
        if (ppid == null || ppid <= 0 || ppid === current || ancestors.has(ppid)) break;
        ancestors.add(ppid);
        current = ppid;
    }
    return ancestors;
}

function classifyLivePiSnapshot(
    snapshot: ProcessSnapshot,
    probeParents = true,
): PiProcessDiscovery {
    const ancestors = collectAncestorPids(process.pid, snapshot.parentByPid, probeParents);
    const processIds = new Set<number>();
    const inconclusivePids = new Set<number>();
    const skippedAncestorPids: number[] = [];
    for (const fact of snapshot.facts) {
        if (fact.pid === process.pid) continue;
        const command = fact.commandLine ?? fact.imageName ?? "";
        const looksLikeHarness =
            commandHasPiHarnessArc(command) || commandLooksLikePiImage(command);
        if (!looksLikeHarness) continue;
        if (ancestors.has(fact.pid)) {
            skippedAncestorPids.push(fact.pid);
            log(
                `[magic-context] Pi process scan: skipping ancestor PID ${fact.pid} (session launcher shim)`,
            );
            continue;
        }
        if (commandHasPiHarnessArc(command)) {
            processIds.add(fact.pid);
            continue;
        }
        inconclusivePids.add(fact.pid);
        log(
            `[magic-context] Pi process scan: PID ${fact.pid} command line is ambiguous (image-name or missing Pi/OMP arc); treating as inconclusive`,
        );
    }
    skippedAncestorPids.sort((left, right) => left - right);
    const verified = [...processIds].sort((left, right) => left - right);
    const inconclusive = [...inconclusivePids].sort((left, right) => left - right);
    if (verified.length === 0 && inconclusive.length > 0) {
        return {
            state: "inconclusive",
            processIds: [],
            inconclusivePids: inconclusive,
            ...(skippedAncestorPids.length > 0 ? { skippedAncestorPids } : {}),
        };
    }
    return {
        state: "known",
        processIds: verified,
        ...(inconclusive.length > 0 ? { inconclusivePids: inconclusive } : {}),
        ...(skippedAncestorPids.length > 0 ? { skippedAncestorPids } : {}),
    };
}

/** Result of checking whether Pi/OMP processes may currently hold the shared database. */
export interface PiProcessDiscovery {
    state: "known" | "unreadable" | "inconclusive";
    processIds: number[];
    inconclusivePids?: number[];
    skippedAncestorPids?: number[];
    error?: string;
}

/**
 * Inspect Pi/OMP processes without converting a failed process-list probe into
 * false evidence that no harness is running. Callers choose their own policy
 * for the unreadable state: destructive maintenance can fail closed, while a
 * migration guard can proceed after reporting that no live Pi process was confirmed.
 */
export function inspectLivePiProcesses(): PiProcessDiscovery {
    if (process.env.NODE_ENV === "test" && !rpcProcessListTestOverride) {
        return { state: "known", processIds: [] };
    }
    try {
        if (rpcIdentityPlatform === "win32") {
            // Prefer one CIM query (pid, parent, command line, start time).
            // tasklist is image-name-only, so it is a fallback and never a
            // verified live-harness source.
            const now = rpcIdentityNowMs();
            const cached = windowsProcessSnapshotCache;
            // A brief reuse avoids spawning PowerShell on every blocker scan.
            const snapshot =
                cached && now >= cached.at && now - cached.at < WINDOWS_PROCESS_SNAPSHOT_TTL_MS
                    ? cached.snapshot
                    : (tryReadWindowsCimSnapshot(rpcProcessListExecFileSync) ??
                      tryReadWindowsTasklistSnapshot());
            if (!snapshot) {
                return {
                    state: "unreadable",
                    processIds: [],
                    error: "process list unavailable",
                };
            }
            if (snapshot !== cached?.snapshot) windowsProcessSnapshotCache = { snapshot, at: now };
            rememberWindowsProcessFacts(snapshot.facts);
            return classifyLivePiSnapshot(snapshot);
        }
        return classifyLivePiSnapshot(readPosixProcessSnapshot());
    } catch (error) {
        return {
            state: "unreadable",
            processIds: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Enumerate live Pi/OMP harness processes before deciding whether migration can proceed. */
export function discoverLivePiProcessIds(): number[] {
    return inspectLivePiProcesses().processIds;
}

export function parseRpcPortFile(content: string, fallbackPid = 0): RpcPortFileRecord | null {
    const trimmed = content.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith("{")) {
        try {
            const parsed = JSON.parse(trimmed) as Partial<RpcPortFileRecord>;
            const port = Number(parsed.port);
            const pid = Number(parsed.pid);
            const startedAt = Number(parsed.started_at);
            if (!isValidPort(port) || !Number.isInteger(pid) || pid <= 0) return null;
            return {
                port,
                pid,
                started_at: Number.isFinite(startedAt) ? startedAt : 0,
                kind: typeof parsed.kind === "string" ? parsed.kind : undefined,
                harness: typeof parsed.harness === "string" ? parsed.harness : undefined,
                token: typeof parsed.token === "string" ? parsed.token : undefined,
                instance_id:
                    typeof parsed.instance_id === "string" ? parsed.instance_id : undefined,
            };
        } catch {
            return null;
        }
    }

    const port = Number.parseInt(trimmed, 10);
    if (!isValidPort(port)) return null;
    return { port, pid: fallbackPid, started_at: 0 };
}

function isValidPort(port: number): boolean {
    return Number.isInteger(port) && port > 0 && port <= 65535;
}

/** One bounded, shared process scan for asynchronous storage opens. */
export interface AsyncProcessInspection {
    pi: PiProcessDiscovery;
    /** Includes process names and commands so offline maintenance can rule out live store users. */
    processSnapshot?: {
        source: ProcessSnapshotSource;
        facts: Array<{ pid: number; imageName: string | null; commandLine: string | null }>;
    };
    evidence(pid: number): ProcessProbeEvidence;
    liveness(pid: number): PidLiveness;
}

/** Process evidence from one snapshot row; the image name is included only when known. */
function snapshotEvidence(fact: ProcessFacts | undefined): ProcessProbeEvidence {
    return {
        startTime: fact?.startTime ?? null,
        commandLine: fact?.commandLine ?? fact?.imageName ?? null,
        ...(fact?.imageName ? { imageName: fact.imageName } : {}),
    };
}

function execProcessListAsync(file: string, args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(
            file,
            args,
            { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
            (error, stdout) => {
                if (error) reject(error);
                else resolve(stdout);
            },
        );
    });
}

let asyncProcessExec = execProcessListAsync;
let asyncInspection: Promise<AsyncProcessInspection> | undefined;
let asyncInspectionExpires = 0;
let lastAsyncSnapshot: ProcessSnapshot | null = null;

/** Inject only the asynchronous transport; legacy synchronous probes stay isolated. */
export function __setAsyncProcessProbeForTests(probe?: typeof execProcessListAsync): void {
    asyncProcessExec = probe ?? execProcessListAsync;
    asyncInspection = undefined;
    asyncInspectionExpires = 0;
    lastAsyncSnapshot = null;
}

export function inspectProcessesAsync(forceFresh = false): Promise<AsyncProcessInspection> {
    if (!forceFresh && asyncInspection && rpcIdentityNowMs() < asyncInspectionExpires)
        return asyncInspection;
    asyncInspectionExpires = Number.POSITIVE_INFINITY;
    asyncInspection = (async () => {
        let snapshot: ProcessSnapshot | null = null;
        try {
            if (rpcIdentityPlatform === "win32") {
                try {
                    const output = await asyncProcessExec(
                        "powershell",
                        ["-NoProfile", "-Command", WINDOWS_CIM_COMMAND],
                        WINDOWS_CIM_PROBE_TIMEOUT_MS,
                    );
                    const facts = parseWindowsCimOutput(output);
                    if (facts) snapshot = snapshotFromFacts(facts, "cim");
                } catch {
                    /* tasklist is the bounded fallback when CIM is unavailable. */
                }
                if (!snapshot) {
                    const entries = parseTasklistOutput(
                        await asyncProcessExec(
                            "tasklist",
                            ["/FO", "CSV", "/NH"],
                            PS_PROBE_TIMEOUT_MS,
                        ),
                    );
                    if (entries)
                        snapshot = snapshotFromFacts(
                            entries.map(({ pid, command }) => ({
                                pid,
                                parentPid: null,
                                commandLine: null,
                                imageName: command,
                                startTime: null,
                            })),
                            "tasklist",
                        );
                }
            } else {
                const output = await asyncProcessExec(
                    "ps",
                    ["-axo", "pid=,ppid=,lstart=,command="],
                    PS_PROBE_TIMEOUT_MS,
                );
                const facts: ProcessFacts[] = [];
                for (const line of output.split(/\r?\n/)) {
                    const match =
                        /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/.exec(
                            line,
                        );
                    if (!match) continue;
                    const startTime = Date.parse(match[3]);
                    facts.push({
                        pid: Number(match[1]),
                        parentPid: Number(match[2]),
                        commandLine: match[4],
                        imageName: null,
                        startTime: Number.isFinite(startTime) ? startTime : null,
                    });
                }
                snapshot = facts.length > 0 ? snapshotFromFacts(facts, "ps") : null;
            }
        } catch {
            /* Missing process evidence is inconclusive, never proof of death. */
        }
        // A timed-out refresh cannot prove that a process blocking migration has
        // exited. Keep its evidence until a successful scan can establish death.
        const fresh = snapshot !== null;
        if (snapshot) lastAsyncSnapshot = snapshot;
        else snapshot = lastAsyncSnapshot;
        const byPid = new Map(snapshot?.facts.map((fact) => [fact.pid, fact]));
        return {
            pi: snapshot
                ? classifyLivePiSnapshot(snapshot, false)
                : { state: "unreadable", processIds: [] },
            ...(fresh && snapshot
                ? { processSnapshot: { source: snapshot.source, facts: snapshot.facts } }
                : {}),
            evidence: (pid: number) => snapshotEvidence(byPid.get(pid)),
            liveness: (pid: number) => (byPid.has(pid) ? "alive" : fresh ? "dead" : "inconclusive"),
        } satisfies AsyncProcessInspection;
    })().finally(() => {
        asyncInspectionExpires = rpcIdentityNowMs() + WINDOWS_PROCESS_SNAPSHOT_TTL_MS;
    });
    return asyncInspection;
}

/** Take one fresh Windows process snapshot with command time limits for synchronous callers. */
export function inspectWindowsProcessesSync(): AsyncProcessInspection {
    const snapshot =
        tryReadWindowsCimSnapshot(rpcProcessListExecFileSync) ?? tryReadWindowsTasklistSnapshot();
    const byPid = new Map(snapshot?.facts.map((fact) => [fact.pid, fact]));
    return {
        pi: snapshot ? classifyLivePiSnapshot(snapshot) : { state: "unreadable", processIds: [] },
        ...(snapshot
            ? { processSnapshot: { source: snapshot.source, facts: snapshot.facts } }
            : {}),
        evidence: (pid) => snapshotEvidence(byPid.get(pid)),
        liveness: (pid) => (byPid.has(pid) ? "alive" : snapshot ? "dead" : "inconclusive"),
    };
}

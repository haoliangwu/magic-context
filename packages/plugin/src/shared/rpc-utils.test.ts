/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import type { execFileSync } from "node:child_process";
import type { readFileSync } from "node:fs";

import {
    __resetRpcIdentityTestHooks,
    __setRpcIdentityTestHooks,
    classifyProcessKind,
    discoverLivePiProcessIds,
    inspectLivePiProcesses,
    inspectWindowsProcessesSync,
    isPidAlive,
    isPidIdentityPlausible,
    parseTasklistOutput,
    processCannotBeRpcHost,
    type RpcPortFileRecord,
    readProcessProbeEvidence,
} from "./rpc-utils";

const PID = 1234;
const NOW_MS = 2_000_000;
const UPTIME_SECONDS = 1_000;

function record(startedAt: number): RpcPortFileRecord {
    return { port: 43123, pid: PID, started_at: startedAt };
}

function procStat(startTimeTicks: number): string {
    // After the closing command-name parenthesis, field 3 is `state` and field
    // 22 is the twentieth value in the suffix.
    return `${PID} (opencode) S ${Array.from({ length: 18 }, () => "0").join(" ")} ${startTimeTicks}`;
}

function linuxFiles(files: Record<string, string | Error>): typeof readFileSync {
    return ((path: string | URL) => {
        const value = files[String(path)];
        if (value instanceof Error) throw value;
        if (value === undefined) throw new Error(`unexpected read: ${String(path)}`);
        return value;
    }) as typeof readFileSync;
}

function psOutput(output: string | Error): typeof execFileSync {
    return (() => {
        if (output instanceof Error) throw output;
        return output;
    }) as typeof execFileSync;
}

function tasklistOutput(entries: Array<[number, string]>): string {
    return [
        '"Image Name","PID","Session Name","Session#","Mem Usage"',
        ...entries.map(([pid, command]) => `"${command}","${pid}","Console","1","10,000 K"`),
    ].join("\r\n");
}

const WINDOWS_LAUNCHER_PID = 42424;
const WINDOWS_FOREIGN_PID = 41001;
const PLUGIN_BUILD_MS = 1_700_000_000_000;
const OLDER_THAN_PLUGIN_MS = PLUGIN_BUILD_MS - 60_000;
const OMP_PI_ARC_COMMAND =
    "C:\\Users\\qiiks\\.bun\\bin\\omp.exe C:\\Users\\qiiks\\AppData\\Roaming\\npm\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js";
const BUN_PI_CHILD_COMMAND =
    "C:\\Users\\qiiks\\.bun\\bin\\bun.exe C:\\Users\\qiiks\\AppData\\Roaming\\npm\\node_modules\\@oh-my-pi\\pi-coding-agent\\dist\\cli.js";
const BARE_OMP_COMMAND = "C:\\Users\\qiiks\\.bun\\bin\\omp.exe";

function padWmi(value: number, width = 2): string {
    return String(value).padStart(width, "0");
}

/** Format an epoch millisecond timestamp as a WMI CreationDate string. */
function wmiCreationDate(ms: number, offsetMinutes = 0): string {
    const shifted = new Date(ms + offsetMinutes * 60_000);
    const sign = offsetMinutes >= 0 ? "+" : "-";
    return `${shifted.getUTCFullYear()}${padWmi(shifted.getUTCMonth() + 1)}${padWmi(shifted.getUTCDate())}${padWmi(shifted.getUTCHours())}${padWmi(shifted.getUTCMinutes())}${padWmi(shifted.getUTCSeconds())}.000000${sign}${padWmi(Math.abs(offsetMinutes), 3)}`;
}

function cimOutput(
    rows: Array<{
        ProcessId: number;
        ParentProcessId: number;
        CommandLine: string | null;
        CreationDate: string;
    }>,
): string {
    return JSON.stringify(rows.length === 1 ? rows[0] : rows);
}

function windowsProcessListExec(
    handler: (file: string, args: readonly string[]) => string,
): typeof execFileSync {
    return ((file: string | URL, args: readonly string[] = []) =>
        handler(String(file), args)) as typeof execFileSync;
}

afterEach(() => {
    __resetRpcIdentityTestHooks();
});

describe("classifyProcessKind", () => {
    test("classifies OpenCode server, OpenCode instance, Pi, and unknown commands", () => {
        expect(classifyProcessKind("/usr/local/bin/opencode serve --hostname 127.0.0.1")).toBe(
            "OpenCode server",
        );
        expect(classifyProcessKind("node /opt/opencode/bin/opencode --continue")).toBe(
            "OpenCode instance (TUI/CLI)",
        );
        expect(
            classifyProcessKind(
                "bun /workspace/node_modules/@mariozechner/pi-coding-agent/dist/cli.js",
            ),
        ).toBe("Pi");
        expect(classifyProcessKind("/usr/bin/other --flag")).toBe("process");
        expect(classifyProcessKind(null)).toBe("process");
    });

    test("recognizes serve flags and Windows-style executable paths", () => {
        expect(classifyProcessKind("opencode --serve=true")).toBe("OpenCode server");
        expect(classifyProcessKind("C:\\Tools\\opencode.exe")).toBe("OpenCode instance (TUI/CLI)");
        expect(classifyProcessKind("pi.cmd --model test")).toBe("Pi");
    });
});

describe("discoverLivePiProcessIds", () => {
    test("finds Pi-family harness commands while excluding the current process", () => {
        __setRpcIdentityTestHooks({
            processListExecFileSync: (() =>
                [
                    ` ${process.pid} /usr/local/bin/pi`,
                    " 41001 /usr/local/bin/pi --model test",
                    " 41002 node /opt/node_modules/@mariozechner/pi-coding-agent/dist/cli.js",
                    " 41003 bun /opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
                    " 41004 /Applications/OpenCode.app/Contents/MacOS/opencode",
                    " 41005 node /workspace/pi-plugin/src/index.ts",
                    " 41006 npm install @earendil-works/pi-coding-agent",
                    " 41007 /usr/local/bin/omp --model test",
                ].join("\n")) as typeof execFileSync,
        });

        expect(inspectLivePiProcesses()).toEqual({
            state: "known",
            processIds: [41002, 41003],
            inconclusivePids: [41001, 41007],
        });
        expect(discoverLivePiProcessIds()).toEqual([41002, 41003]);
    });

    test("reports uncertainty instead of treating an unavailable process list as empty", () => {
        __setRpcIdentityTestHooks({
            processListExecFileSync: (() => {
                throw new Error("ps unavailable");
            }) as typeof execFileSync,
        });

        expect(inspectLivePiProcesses()).toEqual({
            state: "unreadable",
            processIds: [],
            error: "ps unavailable",
        });
    });

    test("tries PowerShell CIM before tasklist on Windows", () => {
        const calls: string[] = [];
        __setRpcIdentityTestHooks({
            platform: "win32",
            processListExecFileSync: ((file: string | URL) => {
                calls.push(String(file));
                if (String(file) === "powershell") throw new Error("powershell unavailable");
                return tasklistOutput([
                    [process.pid, "pi.exe"],
                    [41001, "pi.exe"],
                    [41002, "opencode.exe"],
                ]);
            }) as typeof execFileSync,
        });

        expect(inspectLivePiProcesses()).toEqual({
            state: "inconclusive",
            processIds: [],
            inconclusivePids: [41001],
        });
        expect(calls).toEqual(["powershell", "tasklist"]);
    });
});

describe("#411 Windows OMP/Pi live-process scan", () => {
    test("reuses a Windows snapshot briefly, then refreshes process discovery", () => {
        let now = PLUGIN_BUILD_MS;
        const calls: string[] = [];
        __setRpcIdentityTestHooks({
            platform: "win32",
            nowMs: () => now,
            processListExecFileSync: windowsProcessListExec((file) => {
                calls.push(file);
                return cimOutput([
                    {
                        ProcessId: WINDOWS_FOREIGN_PID,
                        ParentProcessId: 4,
                        CommandLine: OMP_PI_ARC_COMMAND,
                        CreationDate: wmiCreationDate(OLDER_THAN_PLUGIN_MS),
                    },
                ]);
            }),
        });
        expect(inspectLivePiProcesses().processIds).toEqual([WINDOWS_FOREIGN_PID]);
        now += 1_999;
        expect(inspectLivePiProcesses().processIds).toEqual([WINDOWS_FOREIGN_PID]);
        expect(calls).toEqual(["powershell"]);
        now += 1;
        inspectLivePiProcesses();
        expect(calls).toEqual(["powershell", "powershell"]);
    });
    test("(a) tasklist-only fallback skips a parent omp.exe as an ancestor", () => {
        const calls: string[] = [];
        __setRpcIdentityTestHooks({
            platform: "win32",
            processListExecFileSync: windowsProcessListExec((file) => {
                calls.push(file);
                if (file === "powershell") {
                    throw new Error("powershell unavailable");
                }
                return tasklistOutput([
                    [process.ppid, "omp.exe"],
                    [WINDOWS_FOREIGN_PID, "notepad.exe"],
                ]);
            }),
        });

        const discovery = inspectLivePiProcesses();
        expect(discovery.processIds).not.toContain(process.ppid);
        expect(discovery.skippedAncestorPids).toContain(process.ppid);
        expect(calls[0]).toBe("powershell");
        expect(calls).toContain("tasklist");
    });

    test("(a) CIM parent omp.exe with a Pi arc is skipped as an ancestor", () => {
        __setRpcIdentityTestHooks({
            platform: "win32",
            nowMs: () => PLUGIN_BUILD_MS,
            processListExecFileSync: windowsProcessListExec((file) => {
                if (file !== "powershell") {
                    throw new Error(`${file} must not run when CIM succeeds`);
                }
                return cimOutput([
                    {
                        ProcessId: process.pid,
                        ParentProcessId: WINDOWS_LAUNCHER_PID,
                        CommandLine: BUN_PI_CHILD_COMMAND,
                        CreationDate: wmiCreationDate(PLUGIN_BUILD_MS),
                    },
                    {
                        ProcessId: WINDOWS_LAUNCHER_PID,
                        ParentProcessId: 4,
                        CommandLine: OMP_PI_ARC_COMMAND,
                        CreationDate: wmiCreationDate(OLDER_THAN_PLUGIN_MS),
                    },
                ]);
            }),
        });

        const discovery = inspectLivePiProcesses();
        expect(discovery.processIds).not.toContain(WINDOWS_LAUNCHER_PID);
        expect(discovery.processIds).not.toContain(process.pid);
        expect(discovery.skippedAncestorPids).toContain(WINDOWS_LAUNCHER_PID);
        expect(discovery.state).toBe("known");
    });

    test("(b) CIM unrelated omp.exe with a Pi arc and older CreationDate is a verified blocker", () => {
        __setRpcIdentityTestHooks({
            platform: "win32",
            nowMs: () => PLUGIN_BUILD_MS,
            processListExecFileSync: windowsProcessListExec((file) => {
                if (file !== "powershell") {
                    throw new Error(`${file} must not run when CIM succeeds`);
                }
                return cimOutput([
                    {
                        ProcessId: process.pid,
                        ParentProcessId: process.ppid,
                        CommandLine: BUN_PI_CHILD_COMMAND,
                        CreationDate: wmiCreationDate(PLUGIN_BUILD_MS),
                    },
                    {
                        ProcessId: WINDOWS_FOREIGN_PID,
                        ParentProcessId: 8,
                        CommandLine: OMP_PI_ARC_COMMAND,
                        CreationDate: wmiCreationDate(OLDER_THAN_PLUGIN_MS, 60),
                    },
                ]);
            }),
        });

        const discovery = inspectLivePiProcesses();
        expect(discovery.state).toBe("known");
        expect(discovery.processIds).toEqual([WINDOWS_FOREIGN_PID]);
        expect(readProcessProbeEvidence(WINDOWS_FOREIGN_PID)).toEqual({
            startTime: OLDER_THAN_PLUGIN_MS,
            commandLine: OMP_PI_ARC_COMMAND,
        });
    });

    test("(c) CIM omp.exe with no Pi arc is inconclusive", () => {
        __setRpcIdentityTestHooks({
            platform: "win32",
            processListExecFileSync: windowsProcessListExec((file) => {
                if (file !== "powershell") {
                    throw new Error(`${file} must not run when CIM succeeds`);
                }
                return cimOutput([
                    {
                        ProcessId: WINDOWS_FOREIGN_PID,
                        ParentProcessId: 8,
                        CommandLine: BARE_OMP_COMMAND,
                        CreationDate: wmiCreationDate(OLDER_THAN_PLUGIN_MS),
                    },
                ]);
            }),
        });

        const discovery = inspectLivePiProcesses();
        expect(discovery.state).toBe("inconclusive");
        expect(discovery.processIds).toEqual([]);
        expect(discovery.inconclusivePids).toEqual([WINDOWS_FOREIGN_PID]);
    });

    test("(d) PowerShell unavailable falls back to tasklist as inconclusive", () => {
        const calls: string[] = [];
        __setRpcIdentityTestHooks({
            platform: "win32",
            processListExecFileSync: windowsProcessListExec((file) => {
                calls.push(file);
                if (file === "powershell") {
                    throw new Error("powershell unavailable");
                }
                return tasklistOutput([
                    [WINDOWS_FOREIGN_PID, "omp.exe"],
                    [41002, "opencode.exe"],
                ]);
            }),
        });

        const discovery = inspectLivePiProcesses();
        expect(discovery.state).toBe("inconclusive");
        expect(discovery.processIds).toEqual([]);
        expect(discovery.inconclusivePids).toEqual([WINDOWS_FOREIGN_PID]);
        expect(calls).toEqual(["powershell", "tasklist"]);
    });

    test("(e) POSIX ancestor exclusion skips the parent Pi harness", () => {
        __setRpcIdentityTestHooks({
            platform: "darwin",
            processListExecFileSync: windowsProcessListExec((file, args) => {
                if (file === "ps" && args.includes("ppid=")) {
                    const pidIndex = args.indexOf("-p");
                    const pid = Number(args[pidIndex + 1]);
                    if (pid === process.pid) return ` ${process.ppid}\n`;
                    if (pid === process.ppid) return " 1\n";
                    return " 1\n";
                }
                return [
                    ` ${process.pid} bun /opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`,
                    ` ${process.ppid} bun /opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`,
                    " 41001 bun /opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
                ].join("\n");
            }),
        });

        const discovery = inspectLivePiProcesses();
        expect(discovery.processIds).toEqual([41001]);
        expect(discovery.skippedAncestorPids).toContain(process.ppid);
    });

    test("(f) CIM single-object JSON shape parses", () => {
        __setRpcIdentityTestHooks({
            platform: "win32",
            processListExecFileSync: windowsProcessListExec((file) => {
                if (file !== "powershell") {
                    throw new Error(`${file} must not run when CIM succeeds`);
                }
                return cimOutput([
                    {
                        ProcessId: WINDOWS_FOREIGN_PID,
                        ParentProcessId: 8,
                        CommandLine: OMP_PI_ARC_COMMAND,
                        CreationDate: wmiCreationDate(OLDER_THAN_PLUGIN_MS),
                    },
                ]);
            }),
        });

        expect(inspectLivePiProcesses()).toMatchObject({
            state: "known",
            processIds: [WINDOWS_FOREIGN_PID],
        });
    });
});

describe("isPidAlive", () => {
    test("distinguishes confirmed, dead, and inaccessible PID probes", () => {
        const probeFailure = (code: string): NodeJS.ErrnoException => {
            const error = new Error(`kill failed: ${code}`) as NodeJS.ErrnoException;
            error.code = code;
            return error;
        };

        __setRpcIdentityTestHooks({
            processKill: (() => true) as typeof process.kill,
        });
        expect(isPidAlive(PID)).toBe("alive");

        __setRpcIdentityTestHooks({
            processKill: (() => {
                throw probeFailure("ESRCH");
            }) as typeof process.kill,
        });
        expect(isPidAlive(PID)).toBe("dead");

        __setRpcIdentityTestHooks({
            processKill: (() => {
                throw probeFailure("EPERM");
            }) as typeof process.kill,
        });
        expect(isPidAlive(PID)).toBe("inconclusive");
    });

    test("uses tasklist for Windows liveness and captures probe stderr", () => {
        const calls: Array<{ file: string; args: readonly string[]; stdio: unknown }> = [];
        __setRpcIdentityTestHooks({
            platform: "win32",
            execFileSync: ((
                file: string | URL,
                args: readonly string[] = [],
                options: { stdio?: unknown } = {},
            ) => {
                calls.push({ file: String(file), args, stdio: options.stdio });
                if (String(file) === "ps") throw new Error("ps must not run on Windows");
                return tasklistOutput([[PID, "OpenCode.exe"]]);
            }) as typeof execFileSync,
        });

        expect(isPidAlive(PID)).toBe("alive");
        expect(calls).toEqual([
            {
                file: "tasklist",
                args: ["/FO", "CSV", "/NH", "/FI", `PID eq ${PID}`],
                stdio: ["ignore", "pipe", "pipe"],
            },
        ]);
    });

    test("treats a successful tasklist no-match response as dead", () => {
        __setRpcIdentityTestHooks({
            platform: "win32",
            execFileSync: (() =>
                "INFO: No tasks are running which match the specified criteria.") as typeof execFileSync,
        });

        expect(isPidAlive(PID)).toBe("dead");
    });

    test("returns inconclusive when the Windows tasklist probe cannot spawn", () => {
        __setRpcIdentityTestHooks({
            platform: "win32",
            execFileSync: (() => {
                throw new Error("tasklist unavailable");
            }) as typeof execFileSync,
        });

        expect(isPidAlive(PID)).toBe("inconclusive");
        expect(isPidIdentityPlausible(record(0))).toBe("inconclusive");
    });
});

describe("readProcessProbeEvidence", () => {
    test("captures the same Linux start-time and command probes used by the guard", () => {
        __setRpcIdentityTestHooks({
            platform: "linux",
            nowMs: () => NOW_MS,
            readFileSync: linuxFiles({
                [`/proc/${PID}/stat`]: procStat(10_000),
                "/proc/uptime": `${UPTIME_SECONDS}.0 0.0`,
                [`/proc/${PID}/cmdline`]:
                    "/usr/local/bin/opencode\u0000--directory\u0000/home/alice/project",
            }),
        });

        expect(readProcessProbeEvidence(PID)).toEqual({
            startTime: 1_100_000,
            commandLine: "/usr/local/bin/opencode\u0000--directory\u0000/home/alice/project",
        });
    });

    test("returns unavailable fields instead of throwing when probes fail", () => {
        __setRpcIdentityTestHooks({
            platform: "linux",
            readFileSync: linuxFiles({}),
        });

        expect(() => readProcessProbeEvidence(PID)).not.toThrow();
        expect(readProcessProbeEvidence(PID)).toEqual({ startTime: null, commandLine: null });
    });
});

describe("isPidIdentityPlausible", () => {
    test("rejects a reused Linux PID when proc start time is substantially newer", () => {
        const readPaths: string[] = [];
        __setRpcIdentityTestHooks({
            platform: "linux",
            nowMs: () => NOW_MS,
            readFileSync: ((path: string | URL) => {
                readPaths.push(String(path));
                const files = {
                    [`/proc/${PID}/stat`]: procStat(10_000),
                    "/proc/uptime": `${UPTIME_SECONDS}.0 0.0`,
                };
                return files[String(path) as keyof typeof files];
            }) as typeof readFileSync,
            execFileSync: (() => {
                throw new Error("ps must not run on Linux");
            }) as typeof execFileSync,
        });

        expect(isPidIdentityPlausible(record(500_000))).toBe("implausible");
        expect(readPaths).toEqual([`/proc/${PID}/stat`, "/proc/uptime"]);
    });

    test("accepts a genuine Linux record when the process started no later than the record", () => {
        __setRpcIdentityTestHooks({
            platform: "linux",
            nowMs: () => NOW_MS,
            readFileSync: linuxFiles({
                [`/proc/${PID}/stat`]: procStat(10_000),
                "/proc/uptime": `${UPTIME_SECONDS}.0 0.0`,
            }),
        });

        // The mocked process start is 1,100,000ms. The 120s tolerance is part of
        // the contract because port-file creation follows process startup.
        expect(isPidIdentityPlausible(record(1_000_000))).toBe("plausible");
    });

    test("reports an unreadable Linux start-time probe as inconclusive", () => {
        __setRpcIdentityTestHooks({
            platform: "linux",
            readFileSync: linuxFiles({
                [`/proc/${PID}/stat`]: new Error("procfs unavailable"),
            }),
        });

        expect(isPidIdentityPlausible(record(500_000))).toBe("inconclusive");
    });

    test("uses the legacy Linux command fallback and distinguishes probe errors", () => {
        __setRpcIdentityTestHooks({
            platform: "linux",
            readFileSync: linuxFiles({
                [`/proc/${PID}/cmdline`]: "/usr/sbin/opendkim --config /etc/opendkim.conf",
            }),
        });
        expect(isPidIdentityPlausible(record(0))).toBe("implausible");

        __setRpcIdentityTestHooks({
            platform: "linux",
            readFileSync: linuxFiles({
                [`/proc/${PID}/cmdline`]: "/usr/local/bin/opencode serve",
            }),
        });
        expect(isPidIdentityPlausible(record(0))).toBe("plausible");

        __setRpcIdentityTestHooks({
            platform: "linux",
            readFileSync: linuxFiles({
                [`/proc/${PID}/cmdline`]: new Error("procfs unavailable"),
            }),
        });
        expect(isPidIdentityPlausible(record(0))).toBe("inconclusive");
    });

    test("uses ps start time and command probes on non-Linux platforms", () => {
        __setRpcIdentityTestHooks({
            platform: "darwin",
            execFileSync: psOutput("Mon Aug  7 00:00:00 1970"),
        });
        expect(
            isPidIdentityPlausible(record(Date.parse("Mon Aug  7 00:00:00 1970") - 121_000)),
        ).toBe("implausible");

        __setRpcIdentityTestHooks({
            platform: "darwin",
            execFileSync: psOutput("Mon Aug  7 00:00:00 1970"),
        });
        expect(
            isPidIdentityPlausible(record(Date.parse("Mon Aug  7 00:00:00 1970") - 120_000)),
        ).toBe("plausible");

        __setRpcIdentityTestHooks({
            platform: "darwin",
            execFileSync: psOutput("/usr/sbin/opendkim -f"),
        });
        expect(isPidIdentityPlausible(record(0))).toBe("implausible");

        __setRpcIdentityTestHooks({
            platform: "darwin",
            execFileSync: psOutput("/Applications/OpenCode.app/Contents/MacOS/opencode"),
        });
        expect(isPidIdentityPlausible(record(0))).toBe("plausible");

        __setRpcIdentityTestHooks({
            platform: "darwin",
            execFileSync: psOutput(new Error("ps unavailable")),
        });
        expect(isPidIdentityPlausible(record(0))).toBe("inconclusive");
    });

    test("uses tasklist for the Windows command fallback and skips unavailable start time", () => {
        const calls: Array<{ file: string; args: readonly string[] }> = [];
        __setRpcIdentityTestHooks({
            platform: "win32",
            execFileSync: ((file: string | URL, args: readonly string[] = []) => {
                calls.push({ file: String(file), args });
                if (String(file) === "ps") throw new Error("ps must not run on Windows");
                return tasklistOutput([[PID, "OpenCode.exe"]]);
            }) as typeof execFileSync,
        });

        expect(isPidIdentityPlausible(record(0))).toBe("plausible");
        expect(calls).toEqual([
            { file: "tasklist", args: ["/FO", "CSV", "/NH", "/FI", `PID eq ${PID}`] },
        ]);

        calls.length = 0;
        // With the start time unreadable, the image is read next: only an image
        // that cannot be a host would prove the record stale, and OpenCode.exe can.
        expect(isPidIdentityPlausible(record(NOW_MS))).toBe("inconclusive");
        expect(calls.map((call) => call.file)).toEqual(["powershell", "tasklist"]);
        expect(calls[0]?.args.slice(0, 2)).toEqual(["-NoProfile", "-Command"]);
        expect(String(calls[0]?.args[2])).toContain("Get-CimInstance Win32_Process");
        expect(String(calls[0]?.args[2])).toContain("ToString('o')");
    });
});

test("the synchronous Windows process list allows more output than the 1 MiB default", () => {
    // Bun's execFileSync throws ENOBUFS past 1 MiB, and a Win32_Process listing
    // with command lines passes that on a busy desktop; the snapshot then falls
    // back to tasklist, which has no start times.
    const limits: unknown[] = [];
    __setRpcIdentityTestHooks({
        platform: "win32",
        processListExecFileSync: ((
            _file: string,
            _args: readonly string[],
            options?: { maxBuffer?: number },
        ) => {
            limits.push(options?.maxBuffer);
            return JSON.stringify([
                {
                    ProcessId: 7,
                    ParentProcessId: 1,
                    Name: "opencode.exe",
                    CommandLine: "opencode",
                    CreationDate: "2026-09-30T10:15:00Z",
                },
            ]);
        }) as unknown as typeof execFileSync,
    });
    const inspection = inspectWindowsProcessesSync();
    expect(inspection.processSnapshot?.source).toBe("cim");
    expect(limits).toEqual([8 * 1024 * 1024]);
});

test("Spanish tasklist no-match is not running", () => {
    const output =
        "INFORMACIÓN: no hay tareas ejecutándose que coincidan con los\ncriterios especificados.";
    expect(parseTasklistOutput(output)).toEqual([]);
    __setRpcIdentityTestHooks({ platform: "win32", execFileSync: psOutput(output) });
    expect(isPidAlive(PID)).toBe("dead");
});

test("German tasklist no-match is not running", () => {
    expect(
        parseTasklistOutput(
            "INFORMATION: Es werden keine Aufgaben mit den angegebenen Kriterien ausgeführt.",
        ),
    ).toEqual([]);
});

test("tasklist CSV live process is running", () => {
    expect(parseTasklistOutput('"opencode.exe","1234","Console","1","10,000 K"')).toEqual([
        { pid: 1234, command: "opencode.exe" },
    ]);
});

describe("proving a discovery record stale from the record's own start time", () => {
    // Values from a Windows machine where PIDs from old records had been reused.
    const RECORDED = Date.parse("2026-08-16T22:49:55Z");
    const DAY_MS = 24 * 60 * 60 * 1000;
    const windowsRecord = (startedAt: number): RpcPortFileRecord => ({
        port: 54209,
        pid: 15520,
        started_at: startedAt,
    });

    test("a PID whose process started after the record was written is a reused PID", () => {
        expect(
            isPidIdentityPlausible(windowsRecord(RECORDED), {
                startTime: RECORDED + 42 * DAY_MS,
                commandLine: "C:\\Windows\\System32\\RuntimeBroker.exe -Embedding",
                imageName: "RuntimeBroker.exe",
            }),
        ).toBe("implausible");
        // The start time alone is proof, even when the new process is a runtime a
        // host could use.
        expect(
            isPidIdentityPlausible(windowsRecord(RECORDED), {
                startTime: RECORDED + 42 * DAY_MS,
                commandLine: "node.exe C:\\tools\\unrelated.js",
                imageName: "node.exe",
            }),
        ).toBe("implausible");
    });

    test("a host that started at or before its record is genuine", () => {
        for (const startTime of [RECORDED - 13_000, RECORDED]) {
            expect(
                isPidIdentityPlausible(windowsRecord(RECORDED), {
                    startTime,
                    commandLine: null,
                    imageName: "RuntimeBroker.exe",
                }),
            ).toBe("plausible");
        }
    });

    test("an unreadable start time with an image no host can run is a reused PID", () => {
        for (const imageName of ["svchost.exe", "WinAutomation.UserAgent.exe"]) {
            expect(
                isPidIdentityPlausible(windowsRecord(RECORDED), {
                    startTime: null,
                    commandLine: imageName,
                    imageName,
                }),
            ).toBe("implausible");
        }
    });

    test("an unreadable start time with a host-like image stays inconclusive", () => {
        for (const imageName of [
            "opencode.exe",
            "OpenChamber.exe",
            "pi.exe",
            "omp.exe",
            "bun.exe",
            "node.exe",
            "ck-mc.exe",
        ]) {
            expect(
                isPidIdentityPlausible(windowsRecord(RECORDED), {
                    startTime: null,
                    commandLine: null,
                    imageName,
                }),
            ).toBe("inconclusive");
        }
        expect(
            isPidIdentityPlausible(windowsRecord(RECORDED), {
                startTime: null,
                commandLine: null,
                imageName: null,
            }),
        ).toBe("inconclusive");
    });

    test("an unreadable start time is resolved from the probed image when no evidence is passed", () => {
        __setRpcIdentityTestHooks({
            platform: "win32",
            execFileSync: ((file: string | URL) => {
                if (String(file) === "powershell") throw new Error("CIM unavailable");
                return tasklistOutput([[15520, "svchost.exe"]]);
            }) as typeof execFileSync,
        });
        expect(isPidIdentityPlausible(windowsRecord(RECORDED))).toBe("implausible");
    });

    test("a record without a start time is stale only when its image cannot be a host", () => {
        expect(
            isPidIdentityPlausible(windowsRecord(0), {
                startTime: null,
                commandLine: "dllhost.exe",
                imageName: "dllhost.exe",
            }),
        ).toBe("implausible");
        expect(
            isPidIdentityPlausible(windowsRecord(0), {
                startTime: null,
                commandLine: "pi.exe",
                imageName: "pi.exe",
            }),
        ).toBe("inconclusive");
    });

    test("host markers are matched in either the image name or the command line", () => {
        expect(processCannotBeRpcHost({ commandLine: null, imageName: "Cherry Studio.exe" })).toBe(
            true,
        );
        expect(
            processCannotBeRpcHost({
                commandLine: "C:\\Users\\a\\.bun\\bin\\omp.exe",
                imageName: "unknown",
            }),
        ).toBe(false);
        expect(
            processCannotBeRpcHost({
                commandLine: "/usr/bin/env node /opt/pi-coding-agent/dist/cli.js",
            }),
        ).toBe(false);
        expect(processCannotBeRpcHost({ commandLine: "  ", imageName: null })).toBe(false);
    });
});

import { afterEach, describe, expect, it, mock } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
    __ignoredNotificationTest,
    flushIgnoredMessages,
    observeIgnoredNotificationEvent,
} from "../hooks/magic-context/send-session-notification";
import { drainNotifications } from "../shared/rpc-notifications";
import { cleanupTestTempDir, createTestTempDir } from "../shared/test-temp-dir";
import { __conflictWarningTest, sendStartupAnnouncement } from "./conflict-warning-hook";

function sourceFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...sourceFiles(path));
        } else if (entry.isFile() && path.endsWith(".ts")) {
            files.push(path);
        }
    }
    return files;
}

describe("conflict-warning notifications", () => {
    let temporaryRoot: string | undefined;
    const originalNoticeGate = process.env.MAGIC_CONTEXT_NOTICE_GATE;

    afterEach(() => {
        __ignoredNotificationTest.reset();
        __conflictWarningTest.reset();
        if (originalNoticeGate === undefined) delete process.env.MAGIC_CONTEXT_NOTICE_GATE;
        else process.env.MAGIC_CONTEXT_NOTICE_GATE = originalNoticeGate;
        if (temporaryRoot) cleanupTestTempDir(temporaryRoot);
        temporaryRoot = undefined;
    });

    it("publishes startup status through RPC without appending chat rows", async () => {
        const temp = createTestTempDir("mc-conflict-");
        temporaryRoot = temp.dir;
        const directory = join(temp.dir, "project");
        const sessionId = "ses-startup-announcement-active";
        __conflictWarningTest.setDesktopState(directory, { sessionId, sidecarUrl: null });
        process.env.MAGIC_CONTEXT_NOTICE_GATE = "hold";
        __ignoredNotificationTest.reset();

        const prompt = mock(async () => ({ data: { info: { id: "msg-startup" } } }));
        const get = mock(async () => ({ title: "Real project title" }));
        const markSeen = mock(() => {});

        await sendStartupAnnouncement(
            { session: { get, prompt } },
            directory,
            "9.9.9",
            ["A release feature"],
            "",
            markSeen,
        );

        expect(prompt).not.toHaveBeenCalled();
        expect(markSeen).toHaveBeenCalledWith("9.9.9");
        expect(__ignoredNotificationTest.pendingTexts(sessionId)).toEqual([]);
        expect(
            drainNotifications(0, sessionId).some((notice) =>
                String(notice.payload.message).includes("A release feature"),
            ),
        ).toBe(true);
        process.env.MAGIC_CONTEXT_NOTICE_GATE = "bypass";
        await flushIgnoredMessages(sessionId);
        expect(prompt).not.toHaveBeenCalled();
        observeIgnoredNotificationEvent({
            type: "session.idle",
            properties: { sessionID: sessionId },
        });
        await flushIgnoredMessages(sessionId);
        expect(prompt).not.toHaveBeenCalled();
        expect(markSeen).toHaveBeenCalledWith("9.9.9");
    });

    it("keeps direct noReply posts centralized in the guarded sender", () => {
        const sourceRoot = join(import.meta.dir, "..");
        const notificationSender = join(
            sourceRoot,
            "hooks",
            "magic-context",
            "send-session-notification.ts",
        );
        const allowedSites = new Set<string>();
        const needle = ["noReply", "true"].join(": ");
        const violations = sourceFiles(sourceRoot)
            .filter((path) => path !== notificationSender && !path.endsWith(".test.ts"))
            .flatMap((path) =>
                readFileSync(path, "utf8")
                    .split("\n")
                    .map((line, index) =>
                        line.includes(needle) ? `${relative(sourceRoot, path)}:${index + 1}` : null,
                    )
                    .filter((line): line is string => line !== null && !allowedSites.has(line)),
            );

        expect(violations).toEqual([]);
    });

    it("allows ignored chat posts only at explicit command sites", () => {
        const sourceRoot = join(import.meta.dir, "..");
        // Counts pin each remaining command-owned call, not just its containing file.
        const allowed = new Map([
            ["hooks/magic-context/hook.ts", 1],

            // The RPC `recomp` handler is the only remaining one: the session-upgrade
            // handler that also posted one was removed with its command.
            ["plugin/rpc-handlers.ts", 1],
        ]);
        const actual = new Map<string, number>();
        // sendCommandResult posts a command's result through sendIgnoredMessage, so a
        // command site that calls it is an ignored chat post too.
        const call = new RegExp(
            ["(?:sendIgnoredMessage|sendCommandResult)", "\\s*\\("].join(""),
            "g",
        );
        for (const path of sourceFiles(sourceRoot)) {
            if (path.endsWith(".test.ts") || path.endsWith("/send-session-notification.ts"))
                continue;
            const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
            const count = [...source.matchAll(call)].length;
            if (count) actual.set(relative(sourceRoot, path), count);
        }
        expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(allowed));
    });
});

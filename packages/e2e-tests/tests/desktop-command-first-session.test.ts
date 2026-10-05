/// <reference types="bun-types" />
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { TestHarness } from "../src/harness";

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        magicContextConfig: { memory: { auto_search: { enabled: false } } },
        // A released plugin must initialize its own schema, not master's newer one.
        prepareContextDatabase: process.env.MC_E2E_PLUGIN_ENTRY ? false : undefined,
    });
    const opened = spawnSync("lsof", ["-nP", "-p", String(h.opencode.pid)], { encoding: "utf8" });
    expect(opened.status).toBe(0);
    for (const forbidden of [
        "/.local/share/opencode/opencode.db",
        "/.local/share/cortexkit/magic-context/",
        "/.config/opencode/",
        "/.config/cortexkit/",
    ]) {
        expect(opened.stdout).not.toContain(`${process.env.HOME}${forbidden}`);
    }
    expect(opened.stdout).toContain(h.opencode.env.dataDir);
    const dbPaths = opened.stdout.split("\n")
        .flatMap((line) => line.match(/\S+\.db(?:-wal|-shm)?(?=\s|$)/g) ?? []);
    expect(dbPaths.length).toBeGreaterThan(0);
    const dataDir = realpathSync(h.opencode.env.dataDir);
    expect(dbPaths.filter((path) => !path.startsWith(`${dataDir}/`))).toEqual([]);
});

afterAll(async () => { await h?.dispose(); });

async function sendDesktopCommand(id: string, command: string): Promise<Response> {
    // OpenCode Desktop sends registered commands to the command API with a
    // preallocated message ID and no file parts.
    return fetch(`${h.serverUrl}/session/${id}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            messageID: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
            command,
            arguments: "",
            agent: "build",
            model: "mock-anthropic/mock-sonnet",
            parts: [],
        }),
    });
}

async function assertCommandResult(id: string, command: string, before: number): Promise<void> {
    const controller = new AbortController();
    const events = await fetch(`${h.serverUrl}/event`, { signal: controller.signal });
    expect(events.ok).toBe(true);
    let wire = "";
    const stream = (async () => {
        const reader = events.body!.getReader();
        try {
            while (true) {
                const next = await reader.read();
                if (next.done) return;
                wire += new TextDecoder().decode(next.value);
            }
        } catch {
            // Aborting the subscription after the assertion closes the stream.
        }
    })();
    try {
        const response = await sendDesktopCommand(id, command);
        expect(response.status).toBe(204);
        const messages = await fetch(`${h.serverUrl}/session/${id}/message`).then((res) => res.json()) as Array<{
            info: { role: string };
            parts: Array<{ type: string; text?: string; ignored?: boolean }>;
        }>;
        expect(messages.some((message) => message.parts.some((part) =>
            part.type === "text" && part.ignored === true && (part.text?.length ?? 0) > 0,
        ))).toBe(true);
        expect(messages.some((message) => message.parts.some((part) => part.text === command))).toBe(false);
        const status = await fetch(`${h.serverUrl}/session/status`).then((res) => res.json()) as Record<string, { type: string }>;
        expect(status[id]?.type).not.toBe("busy");
        expect(h.mock.requests().length).toBe(before);
        await h.waitFor(() => wire.includes(id) && wire.includes('"status":{"type":"idle"'), {
            timeoutMs: 5_000, intervalMs: 50, label: "Desktop idle event",
        });
    } finally {
        controller.abort();
        await stream;
    }
}

test("Desktop command on a fresh session has visible output and no generation", async () => {
    const id = await h.createSession();
    await assertCommandResult(id, "ctx-status", h.mock.requests().length);
    const session = await fetch(`${h.serverUrl}/session/${id}`).then((res) => res.json()) as { title: string };
    expect(session.title).toBe("Magic Context");
    const before = h.mock.requests().length;
    await h.sendPrompt(id, "answer the first real question");
    expect(h.mock.requests().length).toBe(before + 1);
});

test("every registered Desktop command publishes a result from a fresh session", async () => {
    for (const command of ["ctx-flush", "ctx-recomp", "ctx-wrapup", "ctx-embed", "ctx-dream"]) {
        const id = await h.createSession();
        const before = h.mock.requests().length;
        const response = await sendDesktopCommand(id, command);
        expect(response.status).toBe(204);
        const messages = await fetch(`${h.serverUrl}/session/${id}/message`).then((res) => res.json()) as Array<{
            parts: Array<{ ignored?: boolean; text?: string }>;
        }>;
        expect(messages.some((message) => message.parts.some((part) => part.ignored && part.text))).toBe(true);
        const status = await fetch(`${h.serverUrl}/session/status`).then((res) => res.json()) as Record<string, { type: string }>;
        expect(status[id]?.type).not.toBe("busy");
        // Dreaming may start its own maintenance model work; command transport
        // itself must not schedule a normal generation for the other commands.
        if (command !== "ctx-dream") expect(h.mock.requests().length).toBe(before);
    }
});

test("Desktop command on an existing session preserves its previous model turn", async () => {
    const id = await h.createSession();
    await h.sendPrompt(id, "title this session");
    const before = h.mock.requests().length;
    await assertCommandResult(id, "ctx-flush", before);
});

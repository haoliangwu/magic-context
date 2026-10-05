// Minimal OpenCode 2 plugin used only by oc2-api-vs-store.ts.
//
// It answers one question: can a plugin hook that runs INSIDE the service process, while a
// prompt for a session is in flight, call that same service's HTTP API for the same session?
// The hook reads the service registration the way Magic Context's adapter does (matched on this
// process id), calls a few read routes with a hard timeout, and appends what happened to the file
// named by MC_PROBE_OUT. It never changes the draft, so the prompt continues normally.
import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const out = process.env.MC_PROBE_OUT;
const bigSession = process.env.MC_PROBE_BIG_SESSION;
const TIMEOUT_MS = 10_000;

function ownRegistration() {
    const dir = join(process.env.XDG_STATE_HOME ?? "", "opencode");
    let names = [];
    try {
        names = readdirSync(dir);
    } catch {
        return undefined;
    }
    for (const name of names.filter((n) => /^service(-.+)?\.json$/.test(n))) {
        try {
            const info = JSON.parse(readFileSync(join(dir, name), "utf8"));
            if (info.pid === process.pid) return info;
        } catch {}
    }
    return undefined;
}

async function timed(label, run) {
    const started = performance.now();
    try {
        const value = await run();
        return { label, ms: +(performance.now() - started).toFixed(1), ...value };
    } catch (error) {
        return { label, ms: +(performance.now() - started).toFixed(1), error: String(error) };
    }
}

export default {
    id: "mc-probe-oc2-reentrancy",
    async setup(context) {
        await context.session.hook("context", async (draft) => {
            const record = {
                at: Date.now(),
                pid: process.pid,
                sessionID: draft.sessionID,
                draftIds: draft.messages.map((m) => m.id ?? null),
                calls: [],
            };
            const reg = ownRegistration();
            record.registrationFound = Boolean(reg);
            if (reg) {
                const headers = {
                    authorization: `Basic ${Buffer.from(`opencode:${reg.password}`).toString("base64")}`,
                };
                const get = async (path) => {
                    const res = await fetch(`${reg.url}${path}`, {
                        headers,
                        signal: AbortSignal.timeout(TIMEOUT_MS),
                    });
                    const text = await res.text();
                    return { status: res.status, bytes: Buffer.byteLength(text), text };
                };
                const sid = encodeURIComponent(draft.sessionID);
                record.calls.push(
                    await timed("session.get", async () => {
                        const r = await get(`/api/session/${sid}`);
                        return { status: r.status, bytes: r.bytes };
                    }),
                );
                record.calls.push(
                    await timed("message.list desc 5", async () => {
                        const r = await get(`/api/session/${sid}/message?order=desc&limit=5`);
                        const body = r.status === 200 ? JSON.parse(r.text) : undefined;
                        return {
                            status: r.status,
                            bytes: r.bytes,
                            ids: body?.data.map((m) => `${m.type}:${m.id}`),
                        };
                    }),
                );
                record.calls.push(
                    await timed("session.context", async () => {
                        const r = await get(`/api/session/${sid}/context`);
                        const body = r.status === 200 ? JSON.parse(r.text) : undefined;
                        return { status: r.status, bytes: r.bytes, count: body?.data.length };
                    }),
                );
                const lastUser = [...draft.messages].reverse().find((m) => m.role === "user");
                if (lastUser?.id) {
                    record.calls.push(
                        await timed("message.get in-flight user", async () => {
                            const r = await get(
                                `/api/session/${sid}/message/${encodeURIComponent(lastUser.id)}`,
                            );
                            return { status: r.status, bytes: r.bytes, id: lastUser.id };
                        }),
                    );
                }
                if (bigSession) {
                    // A full count of a large session through the API, from inside the hook, while
                    // this prompt is still waiting on the hook.
                    record.calls.push(
                        await timed("big session full page walk (limit 200)", async () => {
                            let cursor;
                            let rows = 0;
                            let bytes = 0;
                            let requests = 0;
                            for (;;) {
                                const q = cursor
                                    ? `cursor=${encodeURIComponent(cursor)}&limit=200`
                                    : "order=asc&limit=200";
                                const r = await get(
                                    `/api/session/${encodeURIComponent(bigSession)}/message?${q}`,
                                );
                                requests += 1;
                                bytes += r.bytes;
                                if (r.status !== 200) return { status: r.status, rows, requests };
                                const body = JSON.parse(r.text);
                                rows += body.data.length;
                                if (body.data.length < 200) break;
                                cursor = body.cursor.next;
                            }
                            return { status: 200, rows, requests, bytes };
                        }),
                    );
                }
            }
            if (reg) {
                // Magic Context's raw-message reader interface is synchronous. The only way to
                // satisfy it over HTTP is to block this thread until the response arrives. This does
                // exactly that with an external curl capped at 5 s, to show whether the service,
                // which runs on this same thread, can answer while the hook blocks it.
                const started = performance.now();
                const res = spawnSync(
                    "curl",
                    [
                        "-s",
                        "-o",
                        "/dev/null",
                        "-w",
                        "%{http_code}",
                        "--max-time",
                        "5",
                        "-u",
                        `opencode:${reg.password}`,
                        `${reg.url}/api/session/${encodeURIComponent(draft.sessionID)}/message?order=desc&limit=1`,
                    ],
                    { encoding: "utf8" },
                );
                record.calls.push({
                    label: "blocking (spawnSync curl, 5 s cap) same-process API call",
                    ms: +(performance.now() - started).toFixed(1),
                    httpCode: res.stdout,
                    curlExit: res.status,
                });
            }
            record.calls.push(
                await timed("in-process context.session.context", async () => {
                    const value = await Promise.race([
                        context.session.context({ sessionID: draft.sessionID }),
                        new Promise((_, reject) =>
                            setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS),
                        ),
                    ]);
                    const list = Array.isArray(value) ? value : value?.data;
                    return { count: list?.length };
                }),
            );
            if (out) appendFileSync(out, `${JSON.stringify(record)}\n`);
        });
    },
};

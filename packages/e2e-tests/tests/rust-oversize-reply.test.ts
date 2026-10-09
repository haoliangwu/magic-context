import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubcClient, type Frame } from "@cortexkit/subc-client";
import { buildHermeticBinaries, buildSlowTransformProbe, detectRustModePrereqs, HermeticSubcStack } from "../src/rust-runner/hermetic-subc";
import { assembleReplyPages } from "../../plugin/src/hooks/magic-context/reply-pages";
import { buildPagedModuleTransformPayloads } from "../../plugin/src/hooks/magic-context/module-wire";

const prereqs = detectRustModePrereqs();
const baseline = process.env.MC_REPLY_BASELINE === "1";
const session = "mc-historian:oversize-reply";

function screenshotRequest(data: string): Record<string, unknown> {
    const messages = Array.from({ length: 48 }, (_, index) => {
        const mid = `screenshot-${index}`;
        return { mid, ordinal: index + 1, ck: { role: "user", content: [{ kind: { type: "text", text: "screenshot" } }, { kind: { type: "media", kind: "image", media_type: "image/png", source: { type: "data_base64", data } } }], meta: { harness_id: mid, ordinal: index + 1 } } };
    });
    return {
        method: "transform", kind: "transform", v: 2, serializer_profile: "opencode-aisdk", accept_reply_pages: true,
        session_id: session, render_config: "reply-probe", serve_native: true,
        full_array_fingerprint: "reply-probe-fingerprint", messages,
        native_messages: messages.map(({ mid }) => ({ info: { id: mid, role: "user" }, parts: [
            { type: "text", text: "screenshot" },
            { type: "file", mime: "image/png", url: `data:image/png;base64,${data}` },
        ] })),
    };
}

async function healthProbe(client: SubcClient): Promise<number> {
    // The public SDK has no supervisor probe method; use its real channel-0 RPC,
    // not session.status (which would measure a data route instead of health).
    const rpc = client as unknown as { controlRpc(body: Uint8Array): Promise<Frame> };
    const start = performance.now();
    const frame = await rpc.controlRpc(Buffer.from(JSON.stringify({ op: "supervisor.health_probe", module_id: "magic-context" })));
    const answer = JSON.parse(Buffer.from(frame.body).toString("utf8"));
    expect(answer.op).toBe("supervisor.health_probe");
    return performance.now() - start;
}

describe.skipIf(!prereqs.ok)("bounded replies through a real daemon", () => {
    it("delivers screenshot output above 4 MiB byte-identically without closing the connection", async () => {
        const binaries = await buildHermeticBinaries(prereqs.subconsciousRoot!);
        const root = mkdtempSync(join(tmpdir(), "mc-reply-e2e-"));
        const project = join(root, "project");
        mkdirSync(project);
        const stack = await HermeticSubcStack.start({ ...binaries, dataDir: join(root, "data"), startProducer: false });
        const client = await SubcClient.connect({ connectionFile: stack.connectionFile });
        const health = await SubcClient.connect({ connectionFile: stack.connectionFile });
        let maximumFrame = 0;
        const socket = (client as unknown as { sock: { readFrame(...args: unknown[]): Promise<Frame> } }).sock;
        const readFrame = socket.readFrame.bind(socket);
        socket.readFrame = async (...args) => { const frame = await readFrame(...args); maximumFrame = Math.max(maximumFrame, frame.body.length); return frame; };
        try {
            const route = await client.routeOpen({ kind: "tool_provider", module_id: "magic-context" }, { harness: "opencode", project_root: project, session }, { consumerIdentity: null });
            const template = await client.request(route, screenshotRequest("QUJD")) as Record<string, unknown>;
            expect(template.prefix_bust_permitted).toBe(false);
            expect(template.native_messages).toBeArray();
            const native = template.native_messages as Array<{ parts: Array<{ type: string; url?: string }> }>;
            expect(native).toHaveLength(48);
            for (const message of native) {
                expect(message.parts.find((part) => part.type === "file")?.url).toBe("data:image/png;base64,QUJD");
            }
            const legacyImage = "QUJD".repeat(4_096);
            const legacyRequest = screenshotRequest(legacyImage);
            delete legacyRequest.accept_reply_pages;
            const legacyReply = await client.request(route, legacyRequest) as Record<string, unknown>;
            expect(legacyReply).not.toHaveProperty("reply_page");
            const legacyExpected = JSON.stringify(template).replaceAll("data:image/png;base64,QUJD", `data:image/png;base64,${legacyImage}`).replaceAll('"data":"QUJD"', `"data":"${legacyImage}"`);
            expect(Buffer.byteLength(legacyExpected)).toBeGreaterThan(512 * 1024);
            expect(JSON.stringify(legacyReply)).toBe(legacyExpected);
            maximumFrame = 0;
            const image = "QUJD".repeat(65_536);
            const expected = JSON.stringify(template).replaceAll("data:image/png;base64,QUJD", `data:image/png;base64,${image}`).replaceAll('"data":"QUJD"', `"data":"${image}"`);
            expect(Buffer.byteLength(expected)).toBeGreaterThan(4 * 1024 * 1024);
            const pages = buildPagedModuleTransformPayloads(screenshotRequest(image));
            for (const { page } of pages.slice(0, -1)) await client.request(route, page);
            let done = false;
            let probes = 0;
            const healthLoop = (async () => {
                while (!done) {
                    try {
                        const elapsed = await healthProbe(health);
                        if (!baseline) expect(elapsed).toBeLessThan(1_000);
                    } catch (error) {
                        if (!baseline) throw error;
                        console.log(`legacy health probe during giant reply: ${String(error)}`);
                    }
                    probes += 1;
                    await Bun.sleep(25);
                }
            })();
            void healthLoop.catch(() => undefined);
            const finalRequest = client.request(route, pages.at(-1)!.page);
            // The daemon admits a giant frame into an empty egress queue, but a
            // following frame cannot fit until it drains. Pull paging avoids that overlap.
            const following = client.request(route, { method: "echo", payload: "following-frame" });
            void following.catch(() => undefined);
            let raw = "";
            let reply: unknown;
            try {
                const first = await finalRequest;
                if (baseline) { await following; throw new Error("baseline did not close"); }
                raw += (first as { reply_page: { data: string } }).reply_page.data;
                reply = await assembleReplyPages(first, async (id, index) => {
                    const page = await client.request(route, { method: "reply.page", reply_page_id: id, reply_page_index: index });
                    raw += (page as { reply_page: { data: string } }).reply_page.data;
                    return page;
                });
                await following;
                expect(raw).toBe(expected);
                expect(JSON.stringify(reply)).toBe(expected);
                expect((reply as Record<string, unknown>).prefix_bust_permitted).toBe(false);
                expect(maximumFrame).toBeLessThanOrEqual(512 * 1024);
                const replayFirst = await client.request(route, screenshotRequest(image));
                const replay = await assembleReplyPages(replayFirst, (id, index) => client.request(route, { method: "reply.page", reply_page_id: id, reply_page_index: index }));
                expect(JSON.stringify(replay)).toBe(expected);
                expect((replay as Record<string, unknown>).prefix_bust_permitted).toBe(false);

                // The ordinary constructor also carries permission through a
                // real paged reply, not only the historian passthrough default.
                const normalSession = "ordinary-paged-permission";
                const normalRoute = await client.routeOpen({ kind: "tool_provider", module_id: "magic-context" }, { harness: "opencode", project_root: project, session: normalSession }, { consumerIdentity: null });
                const normalPages = buildPagedModuleTransformPayloads({ ...screenshotRequest(image), session_id: normalSession });
                for (const { page } of normalPages.slice(0,-1)) await client.request(normalRoute,page);
                const normalFirst = await client.request(normalRoute,normalPages.at(-1)!.page);
                expect(normalFirst).toHaveProperty("reply_page");
                const normal = await assembleReplyPages(normalFirst, (id,index)=>client.request(normalRoute,{method:"reply.page",reply_page_id:id,reply_page_index:index})) as Record<string,unknown>;
                expect(normal.status).toBe("ok");
                expect(normal.prefix_bust_permitted).toBe(true);
            } catch (error) {
                await following.catch(() => undefined);
                if (!baseline) throw error;
                console.log(`legacy oversized-reply reproduction: ${String(error)}`);
                expect(String(error)).not.toContain("baseline did not close");
                expect(stack.daemonLog()).toContain("egress byte budget exhausted");
            } finally { done = true; await healthLoop; }
            expect(probes).toBeGreaterThan(0);
            if (!baseline) expect(stack.daemonLog()).not.toContain("egress byte budget exhausted");
        } finally { client.close(); health.close(); await stack.stop(); rmSync(root, { recursive: true, force: true }); }
    }, 600_000);

    it.skipIf(baseline)("answers health within 1 s during a deliberately slow synchronous transform", async () => {
        const binaries = await buildHermeticBinaries(prereqs.subconsciousRoot!);
        const slowBinary = await buildSlowTransformProbe();
        const root = mkdtempSync(join(tmpdir(), "mc-slow-reply-e2e-"));
        const project = join(root, "project");
        mkdirSync(project);
        const stack = await HermeticSubcStack.start({ ...binaries, ckMcBin: slowBinary, dataDir: join(root, "data"), startProducer: false });
        const client = await SubcClient.connect({ connectionFile: stack.connectionFile });
        try {
            const route = await client.routeOpen({ kind: "tool_provider", module_id: "magic-context" }, { harness: "opencode", project_root: project, session }, { consumerIdentity: null });
            let completed = false;
            const start = performance.now();
            const pass = client.request(route, screenshotRequest("QUJD")).then((reply) => { completed = true; return reply; });
            await Bun.sleep(100);
            for (let index = 0; index < 5; index += 1) {
                expect(completed).toBe(false);
                expect(await healthProbe(client)).toBeLessThan(1_000);
                await Bun.sleep(100);
            }
            expect((await pass as { status: string }).status).toBe("ok");
            expect(performance.now() - start).toBeGreaterThanOrEqual(2_000);
        } finally { client.close(); await stack.stop(); rmSync(root, { recursive: true, force: true }); }
    }, 600_000);
});

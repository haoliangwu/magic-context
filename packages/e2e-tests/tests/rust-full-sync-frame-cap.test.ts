import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SubcModuleTransport } from "../../plugin/src/hooks/magic-context/module-transport";
import {
	buildPagedModuleTransformPayloads,
	encodeOpenCodeMessagesToCk,
	MODULE_PAGE_MAX_BYTES,
} from "../../plugin/src/hooks/magic-context/module-wire";
import {
	buildHermeticBinaries,
	detectRustModePrereqs,
	HermeticSubcStack,
} from "../src/rust-runner/hermetic-subc";

const prereqs = detectRustModePrereqs();
const session = "ses_full_sync_frame_cap";

async function testBinaries() {
	if (!prereqs.subconsciousRoot) throw new Error(prereqs.skipReason);
	return buildHermeticBinaries(prereqs.subconsciousRoot);
}

function request(count: number, textBytes: number): Record<string, unknown> {
	const native = Array.from({ length: count }, (_, index) => ({
		info: {
			id: `msg_${index.toString().padStart(5, "0")}`,
			role: index % 2 ? "assistant" : "user",
		},
		absolute_ordinal: index + 1,
		parts: [
			{ type: "text", text: `message ${index} ${"x".repeat(textBytes)}` },
		],
	}));
	return {
		method: "transform",
		kind: "transform",
		v: 2,
		serializer_profile: "opencode-aisdk",
		session_id: session,
		render_config: "frame-cap",
		serve_native: false,
		full_array_fingerprint: "full-sync-frame-cap",
		messages: encodeOpenCodeMessagesToCk(native),
		native_messages: native,
	};
}

describe.skipIf(!prereqs.ok)("Rust full-sync frame admission", () => {
	it("accepts a 9,268-message paged full retry above 48 MiB and refuses oversized single tool frames", async () => {
		const binaries = await testBinaries();
		const root = mkdtempSync(join(tmpdir(), "mc-full-sync-cap-"));
		const project = join(root, "project");
		mkdirSync(project);
		const stack = await HermeticSubcStack.start({
			...binaries,
			dataDir: join(root, "data"),
			startProducer: false,
		});
		const transport = new SubcModuleTransport(
			stack.connectionFile,
			"magic-context",
			600_000,
		);
		const call = (body: Record<string, unknown>) =>
			transport.call({
				sessionId: session,
				projectRoot: project,
				method: "transform",
				body,
			});
		try {
			// A stale acknowledged base exercises the same NEED_FULL_SYNC -> full
			// retry sequence as the adapter, without involving any live session.
			const delta = {
				...request(1, 10),
				tail_delta: {
					after: "missing-base",
					replace_from: 1,
					native_replace_from: 1,
				},
			};
			const missing = (await call(delta)) as Record<string, unknown>;
			expect(missing.status).toBe("need_full_sync");

			const body = request(9_268, 100);
			// Large native sidecars, like tool metadata or file data, must page
			// even when the canonical text and served tail are small. Keep this
			// admission regression independent of cold projection/tokenizer cost.
			for (const message of body.native_messages as Array<
				Record<string, unknown>
			>) {
				message.page_fixture_padding = "x".repeat(12_000);
			}
			const initial = buildPagedModuleTransformPayloads(
				body,
				MODULE_PAGE_MAX_BYTES,
				true,
			);
			const initialPage = initial[0];
			if (!initialPage) throw new Error("large fixture produced no pages");
			const firstNative = initialPage.page.native_messages as Array<{
				page_fixture_padding: string;
			}>;
			const paddingMessage = firstNative.at(-1);
			if (!paddingMessage)
				throw new Error("large fixture first page has no native sidecars");
			// Deterministically land inside the 26-byte late-envelope hazard;
			// ordinary equal-sized messages need not happen to land there.
			paddingMessage.page_fixture_padding += "x".repeat(
				MODULE_PAGE_MAX_BYTES - initialPage.bytes - 10,
			);
			const pages = buildPagedModuleTransformPayloads(
				body,
				MODULE_PAGE_MAX_BYTES,
				true,
			);
			const frameBytes = pages.map(({ page }) =>
				Buffer.byteLength(
					JSON.stringify({ ...page, accept_reply_pages: true }),
				),
			);
			console.log(
				`full-sync-cap messages=9268 total=${Buffer.byteLength(JSON.stringify(body))} frames=${JSON.stringify(frameBytes)} cap=${MODULE_PAGE_MAX_BYTES}`,
			);
			expect(pages.length).toBeGreaterThan(1);
			let response: Record<string, unknown> = {};
			for (const [index, { page }] of pages.entries()) {
				try {
					response = (await call(page)) as Record<string, unknown>;
				} catch (error) {
					throw new Error(
						`refused frame ${index + 1}/${pages.length} bytes=${frameBytes[index]} cap=${MODULE_PAGE_MAX_BYTES}: ${String(error)} cause=${String((error as Error & { cause?: unknown }).cause)}\nmodule: ${stack.moduleLog().slice(-4000)}\ndaemon: ${stack.daemonLog().slice(-2000)}`,
					);
				}
				if (index + 1 < pages.length) expect(response.staged).toBe(true);
			}
			expect(response.status).toBe("ok");
			expect(frameBytes.every((bytes) => bytes <= MODULE_PAGE_MAX_BYTES)).toBe(
				true,
			);
			expect(response.ck_messages).toBeArray();
			expect((response.ck_messages as unknown[]).length).toBeGreaterThanOrEqual(
				9_268,
			);
			console.log(
				stack
					.moduleLog()
					.split("\n")
					.filter((line) => line.includes("projection-cache"))
					.join("\n"),
			);

			await expect(
				call({
					name: "ctx_memory",
					arguments: { content: "x".repeat(MODULE_PAGE_MAX_BYTES) },
				}),
			).rejects.toThrow("request body exceeds the 48 MiB limit");
			const healthy = (await call({
				method: "echo",
				payload: "still-connected",
			})) as Record<string, unknown>;
			expect(healthy.ok).toBe(true);
		} finally {
			transport.closeSession(session);
			await stack.stop();
			rmSync(root, { recursive: true, force: true });
		}
	}, 1_200_000);

	it("replays ordinary seeded CK and native output bytes", async () => {
		const binaries = await testBinaries();
		const root = mkdtempSync(join(tmpdir(), "mc-frame-cap-replay-"));
		const project = join(root, "project");
		mkdirSync(project);
		const stack = await HermeticSubcStack.start({
			...binaries,
			dataDir: join(root, "data"),
			startProducer: false,
		});
		const transport = new SubcModuleTransport(
			stack.connectionFile,
			"magic-context",
			600_000,
		);
		try {
			const seed: Record<string, unknown> = {
				...request(52, 100),
				serve_native: true,
			};
			const hashes: string[] = [];
			let native: unknown[] = [];
			for (let pass = 0; pass < 5; pass++) {
				const body: Record<string, unknown> = {
					...seed,
					full_array_fingerprint: `replay-${pass}`,
					usage: {
						current_total_input_tokens: pass + 1,
						context_limit_tokens: 200_000,
					},
					...(pass === 0
						? {}
						: {
								messages: (seed.messages as unknown[]).slice(50),
								native_messages: (seed.native_messages as unknown[]).slice(50),
								tail_delta: {
									after: `replay-${pass - 1}`,
									replace_from: 50,
									native_replace_from: 50,
								},
							}),
				};
				const [page] = buildPagedModuleTransformPayloads(
					body,
					MODULE_PAGE_MAX_BYTES,
					true,
				);
				if (!page) throw new Error("replay fixture produced no page");
				const response = (await transport.call({
					sessionId: session,
					projectRoot: project,
					method: "transform",
					body: page.page,
				})) as Record<string, unknown>;
				if (response.status !== "ok")
					throw new Error(`replay pass ${pass}: ${JSON.stringify(response)}`);
				expect(response.status).toBe("ok");
				expect(response.ck_messages).toBeArray();
				expect(response.full_array_fingerprint).toBe(`replay-${pass}`);
				if (Array.isArray(response.native_messages))
					native = response.native_messages;
				else {
					const delta = response.native_messages_delta as {
						after: string;
						replace_from: number;
						messages: unknown[];
					};
					expect(delta.after).toBe(`replay-${pass - 1}`);
					expect(delta.replace_from).toBeGreaterThan(0);
					expect(delta.replace_from).toBeLessThanOrEqual(native.length);
					expect(delta.messages).toBeArray();
					native = [...native.slice(0, delta.replace_from), ...delta.messages];
				}
				expect(native.length).toBeGreaterThanOrEqual(52);
				hashes.push(
					createHash("sha256")
						.update(JSON.stringify([response.ck_messages, native]))
						.digest("hex"),
				);
			}
			expect(new Set(hashes).size).toBe(1);
			// Captured from the pre-fix real module with the identical seeded
			// full request and four distinct acknowledged tail-delta passes.
			expect(hashes[0]).toBe(
				"352ec3d5c89c0c35bfd41e44461bf36d2da5f81855aea4afbd9f1a31e20dfea3",
			);
			console.log(`FRAME_CAP_REPLAY=${JSON.stringify(hashes)}`);
		} finally {
			transport.closeSession(session);
			await stack.stop();
			rmSync(root, { recursive: true, force: true });
		}
	}, 1_200_000);
});

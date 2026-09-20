import { describe, expect, it, spyOn } from "bun:test";
import { insertMemory } from "@magic-context/core/features/magic-context/memory";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { UnifiedSearchResult } from "@magic-context/core/features/magic-context/search";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb, fakeContext } from "../test-utils.test";
import { createCtxSearchTool } from "./ctx-search";

describe("createCtxSearchTool", () => {
	it("prints ctx_expand ranges and footer for message search hits", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "message",
						content: "prior conversation detail",
						score: 0.87,
						messageOrdinal: 12,
						role: "user",
						matchType: "fts",
					},
				] as UnifiedSearchResult[],
		);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-1",
				{ query: "prior detail", sources: ["message"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("ordinal=12 range=9-15 role=user");
			expect(text).toContain(
				"Use ctx_expand(start, end) with the range from any message result above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("accepts note sources and renders note anchors", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async (_db, _sessionId, _project, _query, options) => {
				expect(options?.sources).toEqual(["note"]);
				return [
					{
						source: "note",
						content:
							"Decision: keep the compatibility shim for one more release.",
						score: 0.91,
						noteId: 5,
						status: "ready",
						createdAt: Date.now() - 24 * 60 * 60 * 1000,
						anchorOrdinal: 21,
						sourceSessionId: "ses-search",
					},
				] as UnifiedSearchResult[];
			},
		);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-2",
				{ query: "compatibility shim", sources: ["note"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("id=#5 status=ready");
			expect(text).toContain("@msg 21");
			expect(text).toContain(
				"Use ctx_expand(start=N-10, end=N) around any note @msg anchor above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("omits note anchors and footer hints for foreign-session smart notes", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "note",
						content:
							"Foreign session note should not expose an expandable anchor.",
						score: 0.72,
						noteId: 6,
						status: "ready",
						createdAt: Date.now(),
						anchorOrdinal: 22,
						sourceSessionId: "ses-other",
					},
				] as UnifiedSearchResult[],
		);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: false,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-3",
				{ query: "foreign anchor", sources: ["note"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search") as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("id=#6 status=ready");
			expect(text).not.toContain("@msg 22");
			expect(text).not.toContain(
				"Use ctx_expand(start=N-10, end=N) around any note @msg anchor above",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("explains when an id-shaped memory hit is already visible (Pi parity)", async () => {
		const db = createTestDb();
		const { insertMemory } = await import(
			"@magic-context/core/features/magic-context/memory"
		);
		const projectIdentity = resolveProjectIdentity(process.cwd());
		const memory = insertMemory(db, {
			projectPath: projectIdentity,
			category: "ARCHITECTURE",
			content: "Visible Pi memory for direct lookup.",
		});
		db.prepare(
			"INSERT INTO session_meta (session_id, memory_block_ids) VALUES (?, ?)",
		).run("ses-visible", JSON.stringify([memory.id]));
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-visible",
				{ query: `#${memory.id}`, sources: ["memory"] },
				new AbortController().signal,
				undefined,
				fakeContext("ses-visible", process.cwd()) as never,
			);

			expect(result.content[0]?.text).toBe(
				`No hidden results found for "#${memory.id}".\n\nMemories: 1 match found, all already visible in your project-memory block (ids ${memory.id}).`,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("resolves a `#1234` query directly without calling unifiedSearch (Pi parity)", async () => {
		const db = createTestDb();
		// Dynamically import `insertMemory` to seed a memory for this test,
		// then verify that an ID-shaped query uses `resolveMemoriesByIdsForSearch`
		// instead of `unifiedSearch`.
		const { insertMemory } = await import(
			"@magic-context/core/features/magic-context/memory"
		);
		const projectIdentity = resolveProjectIdentity(process.cwd());
		const memory = insertMemory(db, {
			projectPath: projectIdentity,
			category: "USER_DIRECTIVES",
			content: "Direct id hit for the short-circuit.",
		});
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => {
				throw new Error("unifiedSearch must not run for ID-shaped queries");
			},
		);
		try {
			const tool = createCtxSearchTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				gitCommitsEnabled: false,
			});

			const result = await tool.execute(
				"call-id",
				{ query: `#${memory.id}` },
				new AbortController().signal,
				undefined,
				fakeContext("ses-search", process.cwd()) as never,
			);

			const text = result.content[0]?.text ?? "";
			expect(text).toContain("[1] [memory]");
			expect(text).toContain(`id=${memory.id}`);
			expect(text).toContain("Direct id hit for the short-circuit.");
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("treats empty sources and limit 0 as the omitted defaults so required-all filler matches a clean search", async () => {
		const spy = spyOn(searchModule, "unifiedSearch");
		const run = async (args: {
			query: string;
			sources?: Array<"memory" | "message" | "git_commit" | "primer" | "note">;
			limit?: number;
		}) => {
			const db = createTestDb();
			try {
				const projectIdentity = resolveProjectIdentity(process.cwd());
				for (const [content, label] of [
					["Needle alpha", "first"],
					["Needle alpha alpha", "second"],
					["Needle alpha alpha alpha", "third"],
				]) {
					insertMemory(db, {
						projectPath: projectIdentity,
						category: "ARCHITECTURE",
						content: `${content} ${label} result.`,
					});
				}
				const tool = createCtxSearchTool({
					db,
					memoryEnabled: true,
					embeddingEnabled: false,
					gitCommitsEnabled: false,
				});
				const result = await tool.execute(
					"call-search",
					args,
					new AbortController().signal,
					undefined,
					fakeContext("ses-search", process.cwd()) as never,
				);
				return result.content[0]?.text ?? "";
			} finally {
				closeQuietly(db);
			}
		};

		try {
			const clean = await run({ query: "Needle alpha" });
			const filler = await run({
				query: "Needle alpha",
				sources: [],
				limit: 0,
			});
			expect(filler).toBe(clean);
			expect(clean).toContain("Found 3 results");
			for (const label of ["first", "second", "third"]) {
				expect(clean).toContain(`${label} result`);
			}

			const cleanOpts = spy.mock.calls[0]?.[4] as {
				sources?: unknown;
				limit?: number;
			};
			const fillerOpts = spy.mock.calls[1]?.[4] as {
				sources?: unknown;
				limit?: number;
			};
			expect(fillerOpts.sources).toEqual(cleanOpts.sources);
			expect(fillerOpts.limit).toEqual(cleanOpts.limit);
			expect(fillerOpts.sources).toBeUndefined();
			expect(fillerOpts.limit).toBe(10);
		} finally {
			spy.mockRestore();
		}
	});
});

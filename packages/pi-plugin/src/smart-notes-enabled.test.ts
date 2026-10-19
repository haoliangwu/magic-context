import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { buildDreamTaskRuntimeConfigs } from "@magic-context/core/features/magic-context/dreamer/task-config";
import {
	addNote,
	getNotes,
	markNoteReady,
} from "@magic-context/core/features/magic-context/storage";
import {
	onNoteTrigger,
	peekNoteNudgeText,
} from "@magic-context/core/hooks/magic-context/note-nudger";
import { CTX_NOTE_LIGHT_DESCRIPTION } from "@magic-context/core/tools/light-descriptions";
import { applyJsonSchemaParameterDescriptions } from "@magic-context/core/tools/parameter-descriptions";
import golden from "../../plugin/src/agents/smart-notes-on.golden.json";
import { buildMagicContextBlock } from "./system-prompt";
import { createTestDb, fakeContext } from "./test-utils.test";
import { registerMagicContextTools } from "./tools";
import { createCtxNoteTool } from "./tools/ctx-note";

const digest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
const expected = golden as Record<string, string>;

test("Pi/OMP enabled tool and guidance bytes match master golden", () => {
	for (const preset of ["full", "light"] as const) {
		for (const enabled of [undefined, true]) {
			const definition = createCtxNoteTool({
				db: null as never,
				smartNotesEnabled: enabled,
			});
			applyJsonSchemaParameterDescriptions(
				"ctx_note",
				definition.parameters,
				preset,
			);
			expect(
				digest({
					description:
						preset === "light"
							? CTX_NOTE_LIGHT_DESCRIPTION
							: definition.description,
					schema: definition.parameters,
				}),
			).toBe(expected[`pi/${preset}`]);
			for (const reduce of [false, true])
				for (const memory of [false, true])
					for (const dreamer of [false, true])
						for (const temporal of [false, true]) {
							const text = buildMagicContextBlock({
								db: null as never,
								cwd: "/fixture",
								memoryEnabled: memory,
								ctxReduceCallable: reduce,
								dreamerEnabled: dreamer,
								temporalAwarenessEnabled: temporal,
								promptSurfacePreset: preset,
								smartNotesEnabled: enabled,
							});
							expect(digest(text)).toBe(
								expected[
									`pi-guidance/${preset}/${reduce}/${memory}/${dreamer}/${temporal}`
								],
							);
						}
		}
	}
});

test("Pi/OMP disabled guidance removes smart-note clauses on every preset", () => {
	const custom = buildMagicContextBlock({
		db: null as never,
		cwd: "/fixture",
		memoryEnabled: true,
		dreamerEnabled: true,
		smartNotesEnabled: false,
		primaryGuidanceOverride:
			"Custom guidance\n### Smart notes\n#### Verification\nUse an external condition to park work.\n### Ordinary notes\nKeep intentions in ctx_note.",
	});
	expect(custom).not.toContain("external condition");
	expect(custom).toContain("Keep intentions in ctx_note");
	for (const preset of ["full", "light"] as const)
		for (const reduce of [false, true]) {
			expect(
				buildMagicContextBlock({
					db: null as never,
					cwd: "/fixture",
					memoryEnabled: true,
					dreamerEnabled: true,
					ctxReduceCallable: reduce,
					promptSurfacePreset: preset,
					smartNotesEnabled: false,
				}),
			).not.toMatch(/surface_condition|smart.note|outside checker/i);
		}
});

test("Pi/OMP registered disabled surface refuses cached conditions, keeps ready/read/dismiss and omits evaluator", async () => {
	const db = createTestDb();
	try {
		for (const preset of ["full", "light"] as const) {
			const tools = new Map<string, ReturnType<typeof createCtxNoteTool>>();
			registerMagicContextTools(
				{
					registerTool: (definition: ReturnType<typeof createCtxNoteTool>) =>
						tools.set(definition.name, definition),
					registerCommand: () => {},
				} as never,
				{
					db,
					smartNotesEnabled: false,
					dreamerEnabled: true,
					promptSurface: { default: preset },
					resolveProjectIdentity: () => "git:fixture",
					todowriteEnabled: false,
				},
			);
			const note = tools.get("ctx_note");
			if (!note) throw new Error("ctx_note was not registered");
			expect(
				JSON.stringify({
					description: note.description,
					schema: note.parameters,
				}),
			).not.toMatch(/surface_condition|smart.note|outside checker/i);
			const result = await note
				.execute(
					"old",
					{ content: "old", surface_condition: "cached" },
					new AbortController().signal,
					undefined,
					fakeContext("ses-off", process.cwd()) as never,
				)
				.catch((error) => ({ content: [{ text: String(error) }] }));
			expect((result.content[0] as { text: string }).text).toContain(
				"Smart notes are disabled",
			);
		}
		expect(getNotes(db, {})).toHaveLength(0);
		const ready = addNote(db, "smart", {
			projectPath: "git:fixture",
			content: "already fired",
			surfaceCondition: "done",
		});
		const pending = addNote(db, "smart", {
			projectPath: "git:fixture",
			content: "still parked",
			surfaceCondition: "later",
		});
		markNoteReady(db, ready.id, "already true");
		onNoteTrigger(db, "ses-off", "historian_complete");
		expect(peekNoteNudgeText(db, "ses-off", "u-1", "git:fixture")).toBeNull();
		expect(peekNoteNudgeText(db, "ses-off", "u-2", "git:fixture")).toContain(
			"already fired",
		);
		const note = createCtxNoteTool({
			db,
			smartNotesEnabled: false,
			resolveProjectIdentity: () => "git:fixture",
		});
		const call = async (params: Record<string, unknown>) => {
			const result = await note.execute(
				"test",
				params,
				new AbortController().signal,
				undefined,
				fakeContext("ses-off", process.cwd()) as never,
			);
			return (result.content[0] as { text: string }).text;
		};
		expect(await call({ action: "read" })).toContain("already fired");
		expect(await call({ action: "read", note_ids: [pending.id] })).toContain(
			"still parked",
		);
		expect(
			await call({ action: "dismiss", note_ids: [ready.id, pending.id] }),
		).toContain("Dismissed 2 of 2");
		for (const harness of ["pi", "omp"] as const)
			expect(
				buildDreamTaskRuntimeConfigs({}, harness, undefined, false).map(
					(t) => t.task,
				),
			).not.toContain("evaluate-smart-notes");
	} finally {
		db.close();
	}
});

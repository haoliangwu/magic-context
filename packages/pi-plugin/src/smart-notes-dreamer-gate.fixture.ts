/**
 * Shared harness for the Pi/OMP smart-note/dreamer tool-surface differential.
 *
 * `piGateCases` enumerates every combination of the registration options the
 * ctx_* tool list depends on; `renderPiToolSurfaces` registers the tools for
 * one combination and digests ctx_note and every other tool separately.
 *
 * The committed golden (`smart-notes-dreamer-gate.golden.json`) holds these
 * digests as produced by the code before ctx_note followed the dreamer gate.
 */
import { createHash } from "node:crypto";
import type { Database } from "@magic-context/core/shared/sqlite";
import { registerMagicContextTools } from "./tools";

export interface PiGateCase {
	smartNotesEnabled: boolean | undefined;
	dreamerEnabled: boolean;
	preset: "full" | "light";
	memoryToolEnabled: boolean;
	compactionOff: boolean;
}

export function piGateCases(): PiGateCase[] {
	const cases: PiGateCase[] = [];
	for (const smartNotesEnabled of [undefined, true, false])
		for (const dreamerEnabled of [true, false])
			for (const preset of ["full", "light"] as const)
				for (const memoryToolEnabled of [true, false])
					for (const compactionOff of [false, true])
						cases.push({
							smartNotesEnabled,
							dreamerEnabled,
							preset,
							memoryToolEnabled,
							compactionOff,
						});
	return cases;
}

const shortDigest = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

export interface PiToolSurfaceDigests {
	note: string;
	other: string;
	/** ctx_note's { description, parameters } as JSON, for content checks. */
	noteText: string;
}

export function renderPiToolSurfaces(
	gateCase: PiGateCase,
	db: Database,
): PiToolSurfaceDigests {
	const tools = new Map<
		string,
		{ name: string; description: string; parameters: unknown }
	>();
	registerMagicContextTools(
		{
			registerTool: (definition: {
				name: string;
				description: string;
				parameters: unknown;
			}) => tools.set(definition.name, definition),
			registerCommand: () => {},
		} as never,
		{
			db,
			smartNotesEnabled: gateCase.smartNotesEnabled,
			dreamerEnabled: gateCase.dreamerEnabled,
			memoryToolEnabled: gateCase.memoryToolEnabled,
			compactionOff: gateCase.compactionOff,
			promptSurface: { default: gateCase.preset },
			resolveProjectIdentity: () => "git:fixture",
			todowriteEnabled: false,
		},
	);
	const surfaces = Object.fromEntries(
		[...tools.entries()]
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([name, definition]) => {
				return [
					name,
					{
						description: definition.description,
						parameters: definition.parameters,
					},
				];
			}),
	);
	const { ctx_note: note, ...other } = surfaces;
	return {
		note: shortDigest(note ?? null),
		other: shortDigest(other),
		noteText: JSON.stringify(note ?? null),
	};
}

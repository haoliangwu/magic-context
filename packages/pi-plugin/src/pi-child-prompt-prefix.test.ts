import { expect, it } from "bun:test";
import { buildClassifyPrompt } from "@magic-context/core/features/magic-context/dreamer/classify-prompt";
import { buildMapMemoriesPrompt } from "@magic-context/core/features/magic-context/dreamer/map-memories-prompt";
import {
	buildDreamTaskPrompt,
	buildFrictionGatePrompt,
	buildRetrospectivePrompt,
} from "@magic-context/core/features/magic-context/dreamer/task-prompts";
import { buildVerifyPrompt } from "@magic-context/core/features/magic-context/dreamer/verify-prompt";
import { buildCompressCuesPrompt } from "@magic-context/core/features/magic-context/mural/compress-cues-prompt";
import {
	buildCompartmentAgentPrompt,
	buildHistorianEditorPrompt,
} from "@magic-context/core/hooks/magic-context/compartment-prompt";
import { buildHistorianRepairPrompt } from "@magic-context/core/hooks/magic-context/compartment-runner-validation";
import { buildArgs } from "./subagent-runner";

const firstMessage = "@skill://name";
const source = {
	seedExamples: "",
	sessionReferences: "",
	projectMemory: "",
	inputSource: `Messages 1-1:\n\n${firstMessage}`,
};
const firstPass = buildCompartmentAgentPrompt(source);
const prompts: Array<[string, string]> = [
	["historian first pass", firstPass],
	[
		"historian repair",
		buildHistorianRepairPrompt(firstPass, "not xml", "fixture error"),
	],
	[
		"historian editor",
		buildHistorianEditorPrompt(`<draft>\n${firstMessage}\n</draft>`),
	],
	[
		"full recomp",
		buildCompartmentAgentPrompt({
			...source,
			memoryEnabled: false,
			extractionFree: true,
		}),
	],
	[
		"partial recomp",
		buildCompartmentAgentPrompt({
			...source,
			memoryEnabled: false,
			extractionFree: true,
		}),
	],
	[
		"map memories",
		buildMapMemoriesPrompt("git:fixture", [
			{
				id: 1,
				category: "ARCHITECTURE",
				content: firstMessage,
				candidates: [],
			},
		]),
	],
	[
		"verify",
		buildVerifyPrompt("git:fixture", [
			{
				id: 1,
				category: "ARCHITECTURE",
				content: firstMessage,
				mappedFiles: [],
			},
		]),
	],
	[
		"verify broad",
		buildVerifyPrompt("git:fixture", [
			{
				id: 1,
				category: "ARCHITECTURE",
				content: firstMessage,
				mappedFiles: [],
			},
		]),
	],
	[
		"curate",
		buildDreamTaskPrompt("curate", {
			projectPath: "git:fixture",
			curate: {
				category: "PROJECT_RULES",
				memories: [
					{
						id: 1,
						category: "PROJECT_RULES",
						content: firstMessage,
						mappedFiles: [],
						hasNoFileSentinel: false,
						importance: 50,
						retrievalCount: 0,
						seenCount: 0,
					},
				],
			},
		}),
	],
	[
		"maintain docs",
		buildDreamTaskPrompt("maintain-docs", {
			projectPath: "git:fixture",
			docsChangeSet: firstMessage,
			existingDocs: { architecture: false, structure: false },
		}),
	],
	[
		"classify memories",
		buildClassifyPrompt({
			projectPath: "git:fixture",
			memories: [
				{
					id: 1,
					category: "ARCHITECTURE",
					content: firstMessage,
					importance: 50,
					scope: "project",
					shareable: false,
				},
			],
		}),
	],
	[
		"compress cues",
		buildCompressCuesPrompt({
			projectPath: "git:fixture",
			memories: [
				{
					id: 1,
					category: "ARCHITECTURE",
					importance: 50,
					content: firstMessage,
				},
			],
		}),
	],
	[
		"retrospective gate",
		buildFrictionGatePrompt({ userLines: [`1: ${firstMessage}`] }),
	],
	[
		"retrospective deepen",
		buildRetrospectivePrompt({
			projectPath: "git:fixture",
			frictionWindow: `1. (s1) U: ${firstMessage}`,
			events: [],
		}),
	],
];

for (const [name, userMessage] of prompts) {
	it(`Pi ${name} keeps a leading transcript mention behind fixed template text`, () => {
		expect(userMessage).toContain(firstMessage);
		const args = buildArgs(
			{
				agent: "historian",
				systemPrompt: "fixed system guidance",
				userMessage,
			},
			{
				targetHarness: "pi",
				systemPromptPath: "/fixture/system.txt",
				historianCalibrationEntryPath: null,
			},
		);
		expect(args.at(-1)).toBe(userMessage);
		expect(args.at(-1)?.[0]).not.toBe("@");
	});
}

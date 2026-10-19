import { expect, test } from "bun:test";
import { exactReusablePrefix } from "@magic-context/core/hooks/magic-context/lkg-slot";
import {
	piConversationFields,
	piHasManagedSignature,
	piManagedSignature,
} from "./pi-dispatch-identity";

function same(a: unknown, b: unknown) {
	const left = piConversationFields(a);
	const right = piConversationFields(b);
	return (
		!!left &&
		!!right &&
		exactReusablePrefix(
			[{ id: "request", fields: left }],
			[{ id: "request", fields: right }],
		) === 1
	);
}

test("dispatch identity: only Anthropic block cache decoration and singleton text representation normalize", () => {
	const first = {
		system: [
			{ type: "text", text: "system", cache_control: { type: "ephemeral" } },
		],
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "managed",
						cache_control: { type: "ephemeral" },
					},
				],
			},
		],
	};
	expect(
		same(first, {
			system: "system",
			messages: [{ role: "user", content: "managed" }],
		}),
	).toBe(true);
	expect(
		same(first, {
			system: "system",
			messages: [{ role: "user", content: "raw" }],
		}),
	).toBe(false);
});

test("dispatch identity: arbitrary metadata cannot disappear with cache controls", () => {
	const first = {
		system: "system",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "managed", metadata: { owner: "current" } },
				],
			},
		],
	};
	expect(
		same(first, {
			system: "system",
			messages: [{ role: "user", content: "managed" }],
		}),
	).toBe(false);
	expect(
		same(first, {
			system: "system",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "managed", metadata: { owner: "other" } },
					],
				},
			],
		}),
	).toBe(false);
});

test("dispatch identity: nested and Responses cache fields remain significant", () => {
	const first = {
		system: "system",
		messages: [
			{
				role: "user",
				metadata: { cache_control: "current" },
				content: "managed",
			},
		],
	};
	expect(
		same(first, {
			...first,
			messages: [{ role: "user", metadata: {}, content: "managed" }],
		}),
	).toBe(false);
	const response = {
		input: [
			{
				role: "user",
				content: [
					{ type: "input_text", text: "managed", cache_control: "current" },
				],
			},
		],
	};
	expect(
		same(response, {
			input: [
				{ role: "user", content: [{ type: "input_text", text: "managed" }] },
			],
		}),
	).toBe(false);
});

test("dispatch identity: object order is canonical while arrays and reasoning stay ordered", () => {
	const first = {
		input: [
			{ type: "reasoning", encrypted_content: "current", id: "r" },
			{ role: "user", content: "managed" },
		],
		prompt: { id: "p", version: "1", variables: { a: "one", b: "two" } },
	};
	expect(
		same(first, {
			prompt: { variables: { b: "two", a: "one" }, version: "1", id: "p" },
			input: [
				{ id: "r", encrypted_content: "current", type: "reasoning" },
				{ content: "managed", role: "user" },
			],
		}),
	).toBe(true);
	expect(same(first, { ...first, input: [...first.input].reverse() })).toBe(
		false,
	);
	expect(
		same(first, {
			...first,
			input: [{ ...first.input[0], encrypted_content: "raw" }, first.input[1]],
		}),
	).toBe(false);
});

test("dispatch identity: prompt id version and each variable bind provider input", () => {
	const first = {
		input: [{ role: "user", content: "managed" }],
		prompt: { id: "p", version: "1", variables: { transcript: "prepared" } },
	};
	for (const prompt of [
		{ ...first.prompt, id: "other" },
		{ ...first.prompt, version: "2" },
		{ ...first.prompt, variables: { transcript: "raw" } },
	]) {
		expect(same(first, { ...first, prompt })).toBe(false);
	}
});

test("dispatch identity: cyclic overly deep and oversized structures fail closed", () => {
	const cyclic: Record<string, unknown> = {};
	cyclic.self = cyclic;
	expect(piConversationFields({ messages: [cyclic] })).toBeUndefined();
	let deep: unknown = "text";
	for (let i = 0; i < 130; i++) deep = [deep];
	expect(piConversationFields({ messages: [deep] })).toBeUndefined();
	expect(
		piConversationFields({
			messages: Array.from({ length: 100001 }, () => null),
		}),
	).toBeUndefined();
});

test("dispatch signature: native wrappers survive date steering conversion and image framing", () => {
	const signature = piManagedSignature([
		{
			role: "user",
			content: [
				{
					type: "text",
					text: "<session-history>managed source</session-history>",
				},
			],
		},
	]);
	expect(signature).toBe("<session-history>");
	expect(
		piHasManagedSignature(
			{
				messages: [
					{
						role: "user",
						content:
							"<system-reminder>Today: date</system-reminder>\n<session-history>obfuscated source</session-history>",
					},
				],
			},
			signature,
		),
	).toBe(true);
	expect(
		piHasManagedSignature(
			{
				input: [
					{
						role: "user",
						content: [
							{
								type: "input_text",
								text: "<session-history>managed source</session-history>",
							},
						],
					},
				],
			},
			signature,
		),
	).toBe(true);
	expect(
		piHasManagedSignature(
			{
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "system frame note" },
							...Array.from({ length: 6 }, () => ({
								type: "image",
								source: { data: "frame" },
							})),
							{ type: "text", text: "Today: date" },
							{
								type: "text",
								text: "<session-history>managed source</session-history>",
							},
						],
					},
				],
			},
			signature,
		),
	).toBe(true);
});

test.each([
	"<project-docs>",
	"<user-profile>",
	"<project-memory>",
	"<memory-mural>",
	"<covered-system-messages>",
	"<knowledge-updates>",
])("dispatch signature: %s survives secret obfuscation", (marker) => {
	const signature = piManagedSignature([
		{
			role: "user",
			content: [{ type: "text", text: `${marker}\nfake-private-value` }],
		},
	]);
	expect(signature).toBe(marker);
	expect(
		piHasManagedSignature(
			{
				messages: [
					{
						role: "user",
						content: `<system-reminder>Today: date</system-reminder>\n${marker}\n$$REDACTED$$`,
					},
				],
			},
			signature,
		),
	).toBe(true);
});

test("dispatch signature: host-owned system-reminder is not a managed marker", () => {
	const head =
		"<system-reminder>host date and cwd</system-reminder>\nraw input";
	const signature = piManagedSignature([{ role: "user", content: head }]);
	expect(signature).toBe(head);
	expect(
		piHasManagedSignature(
			{
				messages: [
					{
						role: "user",
						content:
							"<system-reminder>host date and cwd</system-reminder>\nunrelated raw input",
					},
				],
			},
			signature,
		),
	).toBe(false);
});

test("dispatch signature: unknown or nonleading delimiters keep the 128-char fallback", () => {
	for (const prefix of [
		"unknown text",
		" <project-docs>",
		"preface\n<user-profile>",
		"<project-memory extra='attribute'>",
		"<memory-mural-extra>",
	]) {
		const head = `${prefix}${"x".repeat(150)}`;
		expect(piManagedSignature([{ role: "user", content: head }])).toBe(
			head.slice(0, 128),
		);
	}
});

test("dispatch signature: unrelated raw input cannot borrow the current managed head", () => {
	const signature = piManagedSignature([
		{ role: "user", content: "<memory>managed</memory>" },
	]);
	expect(
		piHasManagedSignature(
			{ messages: [{ role: "user", content: "prior raw" }] },
			signature,
		),
	).toBe(false);
	expect(
		piHasManagedSignature(
			{
				messages: [
					{ role: "user", content: "raw", metadata: { text: "<memory>" } },
				],
			},
			signature,
		),
	).toBe(false);
});

import { describe, expect, it } from "bun:test";
import { neutralizeOmpMentions, restoreOmpMentions } from "./omp-mentions";

describe("literal OMP transcript mentions", () => {
	for (const boundary of [
		"",
		..."\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff",
		"(",
		"[",
		"{",
		"<",
		'"',
		"'",
		"`",
	]) {
		it(`neutralizes boundary ${JSON.stringify(boundary)}`, () => {
			expect(neutralizeOmpMentions(`${boundary}@skill://name`)).toBe(
				`${boundary}\u2060@skill://name`,
			);
		});
	}

	it("preserves quoted paths and all text after the at sign", () => {
		expect(
			neutralizeOmpMentions(`@"some file" @'agent://foo' @proc://bg_1`),
		).toBe(`\u2060@"some file" \u2060@'agent://foo' \u2060@proc://bg_1`);
	});

	it("leaves non-boundaries and text without mentions byte-identical", () => {
		for (const text of [
			"a@b.com x@y",
			"plain text\n中文 😀",
			"",
			")@file ]@file }@file >@file",
			"\u2060other",
		]) {
			expect(Buffer.from(neutralizeOmpMentions(text))).toEqual(
				Buffer.from(text),
			);
		}
	});

	it("is idempotent because WORD JOINER is not whitespace", () => {
		expect(/\s/.test("\u2060")).toBe(false);
		const once = neutralizeOmpMentions(
			"@skill://name (@agent://foo)\n@'some file' a@b.com",
		);
		expect(neutralizeOmpMentions(once)).toBe(once);
	});

	it("restores only WORD JOINER immediately followed by at", () => {
		expect(
			restoreOmpMentions(
				"\u2060@skill://name \u2060@'some file' \u2060other @\u2060path",
			),
		).toBe("@skill://name @'some file' \u2060other @\u2060path");
		const plain = "@agent://foo a@b.com\n中文 😀";
		expect(Buffer.from(restoreOmpMentions(plain))).toEqual(Buffer.from(plain));
	});

	it("restores nested output string values without touching keys or other values", () => {
		const original = {
			"\u2060@key": [
				"\u2060@file",
				{
					text: "\u2060@agent://foo",
					number: 42,
					flag: false,
					empty: null,
					other: "\u2060not-a-mention",
				},
			],
		};
		expect(restoreOmpMentions(original)).toEqual({
			"\u2060@key": [
				"@file",
				{
					text: "@agent://foo",
					number: 42,
					flag: false,
					empty: null,
					other: "\u2060not-a-mention",
				},
			],
		});
		expect(original["\u2060@key"][0]).toBe("\u2060@file");
	});
});

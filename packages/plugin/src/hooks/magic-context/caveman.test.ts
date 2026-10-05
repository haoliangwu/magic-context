import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { cavemanCompress, cavemanWordRulesForLanguage, findFilePathMatches } from "./caveman";

describe("cavemanCompress", () => {
    describe("empty and passthrough", () => {
        test("empty string returns empty", () => {
            expect(cavemanCompress("", "lite")).toBe("");
            expect(cavemanCompress("", "full")).toBe("");
            expect(cavemanCompress("", "ultra")).toBe("");
        });

        test("text with no filler survives lite", () => {
            const input = "Fixed bug in handler.";
            expect(cavemanCompress(input, "lite")).toBe("Fixed bug in handler.");
        });
    });

    describe("preservation", () => {
        test("code blocks preserved at all levels", () => {
            const input = "Look at `const x = 1` for reference.";
            expect(cavemanCompress(input, "lite")).toContain("`const x = 1`");
            expect(cavemanCompress(input, "full")).toContain("`const x = 1`");
            expect(cavemanCompress(input, "ultra")).toContain("`const x = 1`");
        });

        test("fenced code blocks preserved", () => {
            const input = "Try this:\n```ts\nconst x = 1;\n```\nIt works.";
            const out = cavemanCompress(input, "ultra");
            expect(out).toContain("```ts\nconst x = 1;\n```");
        });

        test("URLs preserved", () => {
            const input = "See https://github.com/cortexkit/magic-context for details.";
            expect(cavemanCompress(input, "ultra")).toContain(
                "https://github.com/cortexkit/magic-context",
            );
        });

        test("file paths preserved", () => {
            const input = "Fix the bug in src/hooks/magic-context/transform.ts.";
            expect(cavemanCompress(input, "ultra")).toContain(
                "src/hooks/magic-context/transform.ts",
            );
        });

        test("commit hashes preserved", () => {
            const input = "Committed as ffa0997b, replayed as bcd8816e.";
            const out = cavemanCompress(input, "ultra");
            expect(out).toContain("ffa0997b");
            expect(out).toContain("bcd8816e");
        });

        test("magic-context tags preserved", () => {
            const input = "See §1234§ for context.";
            expect(cavemanCompress(input, "ultra")).toContain("§1234§");
        });

        test("opencode IDs preserved", () => {
            const input = "In session ses_331acff95ff the issue was seen.";
            expect(cavemanCompress(input, "ultra")).toContain("ses_331acff95ff");
        });

        test("U: lines preserved verbatim at all levels", () => {
            const input =
                "Narrative text that was really quite verbose.\nU: We should not touch the protected area\nMore narrative.";
            const out = cavemanCompress(input, "ultra");
            expect(out).toContain("U: We should not touch the protected area");
        });

        test("U: lines preserved even when they contain filler words", () => {
            const input = "Some narrative.\nU: I just really think we should do this.\n";
            const out = cavemanCompress(input, "ultra");
            // The U: line content must stay verbatim, filler-words-and-all.
            expect(out).toContain("U: I just really think we should do this.");
        });
    });

    describe("lite level", () => {
        test("drops filler words", () => {
            const input = "The fix was really just a one-line change.";
            const out = cavemanCompress(input, "lite");
            expect(out).not.toContain("really");
            expect(out).not.toContain("just");
            // Articles kept at lite.
            expect(out.toLowerCase()).toContain("the");
        });

        test("drops hedging phrases", () => {
            const input = "I think probably the cache is stale.";
            const out = cavemanCompress(input, "lite");
            expect(out.toLowerCase()).not.toContain("i think");
            expect(out.toLowerCase()).not.toContain("probably");
        });

        test("drops pleasantries", () => {
            const input = "Please check the thanks of the log.";
            const out = cavemanCompress(input, "lite");
            expect(out.toLowerCase()).not.toMatch(/\bplease\b/);
            expect(out.toLowerCase()).not.toMatch(/\bthanks\b/);
        });

        test("applies phrase shortenings", () => {
            const input = "We did this in order to fix the bug.";
            const out = cavemanCompress(input, "lite");
            expect(out).toContain(" to ");
            expect(out).not.toContain("in order to");
        });

        test("keeps articles at lite level", () => {
            const input = "Fixed the auth middleware.";
            const out = cavemanCompress(input, "lite");
            expect(out.toLowerCase()).toContain("the");
        });
    });

    describe("full level", () => {
        test("drops filler (inherits lite)", () => {
            const input = "The fix was really a change.";
            const out = cavemanCompress(input, "full");
            expect(out).not.toContain("really");
        });

        test("drops articles", () => {
            const input = "Fixed the auth middleware in a session.";
            const out = cavemanCompress(input, "full");
            expect(out.toLowerCase()).not.toMatch(/\bthe\b/);
            expect(out.toLowerCase()).not.toMatch(/\ba\b/);
        });

        test("drops auxiliaries in subject-aux-verb patterns", () => {
            const input = "The historian was compressed successfully.";
            const out = cavemanCompress(input, "full");
            // "was" should be dropped since it's before a participle.
            expect(out.toLowerCase()).not.toMatch(/\bwas\b/);
            expect(out.toLowerCase()).toContain("compressed");
        });

        test("preserves code even when surrounding prose is heavily compressed", () => {
            const input = "The config key `execute_threshold_percentage` was added.";
            const out = cavemanCompress(input, "full");
            expect(out).toContain("`execute_threshold_percentage`");
        });
    });

    describe("ultra level", () => {
        test("replaces connectives with symbols", () => {
            const input = "Fixed bug and shipped release and updated docs.";
            const out = cavemanCompress(input, "ultra");
            expect(out).toContain(" + ");
        });

        test("replaces 'then' with arrow", () => {
            const input = "Committed and then pushed.";
            const out = cavemanCompress(input, "ultra");
            // "and then" → "→"
            expect(out).toContain("→");
        });

        test("abbreviates common repeat terms when >= 3 uses", () => {
            const input =
                "The historian ran. Then historian retried. Then historian succeeded. Historian finished.";
            const out = cavemanCompress(input, "ultra");
            // historian appears 4 times → should be abbreviated to "hist"
            expect(out.toLowerCase()).toMatch(/\bhist\b/);
            expect(out.toLowerCase()).not.toMatch(/\bhistorian\b/);
        });

        test("does NOT abbreviate if term appears fewer than 3 times", () => {
            const input = "The historian ran once.";
            const out = cavemanCompress(input, "ultra");
            // historian appears only once → keeps original
            expect(out.toLowerCase()).toContain("historian");
        });

        test("preserves capitalization when abbreviating", () => {
            const input = "Historian started. Historian ran. Historian finished successfully.";
            const out = cavemanCompress(input, "ultra");
            // All three are sentence-initial; abbreviation should be capitalized
            expect(out).toContain("Hist");
        });
    });

    describe("cumulative compression: full output smaller than lite, ultra smallest", () => {
        const sample =
            "The historian was really running in the background, and it was producing compartments for the session. Basically, the compressor was then merging them in order to fit the budget. Therefore, the output tokens were reduced significantly.";

        test("lite shorter than original", () => {
            const out = cavemanCompress(sample, "lite");
            expect(out.length).toBeLessThan(sample.length);
        });

        test("full shorter than lite", () => {
            const lite = cavemanCompress(sample, "lite");
            const full = cavemanCompress(sample, "full");
            expect(full.length).toBeLessThan(lite.length);
        });

        test("ultra shorter than full", () => {
            const full = cavemanCompress(sample, "full");
            const ultra = cavemanCompress(sample, "ultra");
            expect(ultra.length).toBeLessThan(full.length);
        });

        test("ultra achieves at least 30% reduction on verbose prose", () => {
            const out = cavemanCompress(sample, "ultra");
            const reduction = 1 - out.length / sample.length;
            expect(reduction).toBeGreaterThanOrEqual(0.3);
        });
    });

    describe("whitespace normalization", () => {
        test("collapses multiple spaces after removals", () => {
            const input = "Fixed  the   really   bad   bug.";
            const out = cavemanCompress(input, "lite");
            expect(out).not.toMatch(/ {2,}/);
        });

        test("trims trailing whitespace on lines", () => {
            const input = "Line one.   \nLine two.";
            const out = cavemanCompress(input, "lite");
            expect(out).not.toMatch(/ \n/);
        });

        test("caps consecutive blank lines to 1", () => {
            const input = "Para one.\n\n\n\nPara two.";
            const out = cavemanCompress(input, "lite");
            expect(out).not.toMatch(/\n\n\n/);
        });
    });

    describe("real-world compartment content", () => {
        test("V4-style compartment at ultra level", () => {
            const input =
                "Committed the live-notification-params fix on feat/context-management as ffa0997b, replayed it onto integrate/athena-context-management as bcd8816e, and rebuilt both branches successfully. The replay was clean; the only remaining integrate dirt was an unrelated pre-existing src/shared/context-limit-resolver.ts modification.";
            const out = cavemanCompress(input, "ultra");
            // Technical identifiers preserved.
            expect(out).toContain("ffa0997b");
            expect(out).toContain("bcd8816e");
            expect(out).toContain("src/shared/context-limit-resolver.ts");
            // Output shorter than input.
            expect(out.length).toBeLessThan(input.length);
        });

        test("mixed narrative + U: line preserves U: exactly", () => {
            const input =
                "Fixed the really annoying cache bug in the transform. The fix preserved message order.\nU: We need to make sure the protected tail is not touched.\nCommitted and pushed.";
            const out = cavemanCompress(input, "ultra");
            expect(out).toContain("U: We need to make sure the protected tail is not touched.");
        });
    });
});

describe("linear-time compression", () => {
    // Each bound is far above the linear cost and far below the old quadratic one
    // (a 40k run of one token took seconds, and the transform replays compression
    // on every pass).
    test("a long token without slashes compresses in linear time", () => {
        const input = "x".repeat(200_000);
        const started = performance.now();
        expect(cavemanCompress(input, "ultra")).toBe(input);
        expect(performance.now() - started).toBeLessThan(2_000);
    });

    test("a long dash-joined id compresses in linear time", () => {
        const input = Array.from({ length: 20_000 }, (_, index) => `id${index}`).join("-");
        const started = performance.now();
        expect(cavemanCompress(input, "lite")).toBe(input);
        expect(performance.now() - started).toBeLessThan(2_000);
    });

    test("a long whitespace run compresses in linear time", () => {
        const input = `x${" ".repeat(200_000)}y`;
        const started = performance.now();
        expect(cavemanCompress(input, "full")).toBe("x y");
        expect(performance.now() - started).toBeLessThan(2_000);
    });

    test("many paths restore in linear time", () => {
        const input = Array.from({ length: 60_000 }, (_, index) => `see src/f${index}.ts`).join(
            " ",
        );
        const started = performance.now();
        expect(cavemanCompress(input, "lite")).toBe(input);
        expect(performance.now() - started).toBeLessThan(2_000);
    });

    test("the path scanner finds exactly the matches of the path regex", () => {
        const pathRegex = /(?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.\w{1,6}/g;
        const alphabet = ["a", "b", "1", "_", ".", "-", "/", " ", "\u0000", "é", "..", "./"];
        let seed = 7;
        const random = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
        };
        for (let round = 0; round < 20_000; round += 1) {
            let text = "";
            const length = Math.floor(random() * 30);
            for (let index = 0; index < length; index += 1) {
                text += alphabet[Math.floor(random() * alphabet.length)];
            }
            const expected = [...text.matchAll(pathRegex)].map((match) => [
                match.index,
                match.index + match[0].length,
            ]);
            expect({ text, matches: findFilePathMatches(text) }).toEqual({
                text,
                matches: expected,
            });
        }
    });

    test("nested and literal placeholders restore like a region-at-a-time replace", () => {
        const nested = "open https://x.io/a`b c` now";
        expect(cavemanCompress(nested, "lite")).toBe(nested);
        expect(cavemanCompress("keep \u0000MC_PRES_0\u0000 and `code`", "lite")).toBe(
            "keep `code` and `code`",
        );
    });
});

type CavemanGoldenCase = {
    text: string;
    lite: string;
    full: string;
    ultra: string;
};

describe("TypeScript/Rust caveman differential golden", () => {
    test("renders every shared corpus row byte-for-byte", async () => {
        const path = resolve(
            import.meta.dir,
            "../../../../../crates/mc-module/testdata/caveman-golden.json",
        );
        const cases = (await Bun.file(path).json()) as CavemanGoldenCase[];

        expect(cases.length).toBeGreaterThan(30);
        for (const fixture of cases) {
            expect(cavemanCompress(fixture.text, "lite")).toBe(fixture.lite);
            expect(cavemanCompress(fixture.text, "full")).toBe(fixture.full);
            expect(cavemanCompress(fixture.text, "ultra")).toBe(fixture.ultra);
        }
    });
});

describe("original ASCII rules", () => {
    // Sessions compressed before the Unicode rules replay these bytes until a
    // cache-rebuilding pass switches them, so they must never drift. The fixture
    // was rendered by the module as it was before the Unicode rules existed.
    test("render every fixture row exactly as the original module did", async () => {
        const path = resolve(import.meta.dir, "__fixtures__/caveman-ascii-v1-golden.json");
        const cases = (await Bun.file(path).json()) as CavemanGoldenCase[];

        expect(cases.length).toBeGreaterThan(60);
        for (const fixture of cases) {
            expect(cavemanCompress(fixture.text, "lite", "ascii-v1")).toBe(fixture.lite);
            expect(cavemanCompress(fixture.text, "full", "ascii-v1")).toBe(fixture.full);
            expect(cavemanCompress(fixture.text, "ultra", "ascii-v1")).toBe(fixture.ultra);
        }
    });
});

describe("Unicode rules", () => {
    test("keep words next to accented letters whole", () => {
        expect(
            cavemanCompress(
                "Hoy es un d\u00eda para probar la energ\u00eda de la bater\u00eda.",
                "full",
            ),
        ).toBe("Hoy es un d\u00eda para probar la energ\u00eda de la bater\u00eda.");
        expect(cavemanCompress("Ask Mar\u00eda about the caf\u00e9 menu.", "ultra")).toBe(
            "Ask Mar\u00eda about caf\u00e9 menu.",
        );
        // A combining accent is part of the word too.
        expect(cavemanCompress("un di\u0301a para", "full")).toBe("un di\u0301a para");
    });

    test("keep fenced code indentation", () => {
        expect(
            cavemanCompress("Text\n```ts\nfunction f() {\n    return 1;\n}\n```\n", "lite"),
        ).toBe("Text\n```ts\nfunction f() {\n    return 1;\n}\n```");
    });

    test("never merge lines when a word at the start of a line is dropped", () => {
        expect(
            cavemanCompress(
                "Steps:\n1. Build it\nProbably the tests fail.\n\nActually, ship it.",
                "lite",
            ),
        ).toBe("Steps:\n1. Build it\nthe tests fail.\n\n, ship it.");
        expect(
            cavemanCompress("The historian was\ncompressed and the\nresult was fixed.", "full"),
        ).toBe("historian was\ncompressed and the\nresult fixed.");
    });
});

type CavemanLanguageGolden = {
    englishLanguages: Array<string | null>;
    nonEnglishLanguages: string[];
    cases: Array<{ text: string; neutral: string }>;
};

describe("language gate (shared with the Rust module)", () => {
    const load = async () =>
        (await Bun.file(
            resolve(
                import.meta.dir,
                "../../../../../crates/mc-module/testdata/caveman-language-golden.json",
            ),
        ).json()) as CavemanLanguageGolden;

    test("treats unset, en, en-* and invalid codes as English and other languages as not", async () => {
        const golden = await load();
        for (const language of golden.englishLanguages) {
            expect({ language, rules: cavemanWordRulesForLanguage(language ?? undefined) }).toEqual(
                {
                    language,
                    rules: "english",
                },
            );
        }
        for (const language of golden.nonEnglishLanguages) {
            expect({ language, rules: cavemanWordRulesForLanguage(language) }).toEqual({
                language,
                rules: "none",
            });
        }
    });

    test("another language keeps only the language-neutral passes, at every level", async () => {
        const golden = await load();
        expect(golden.cases.length).toBeGreaterThan(60);
        for (const fixture of golden.cases) {
            for (const level of ["lite", "full", "ultra"] as const) {
                expect(cavemanCompress(fixture.text, level, undefined, "none")).toBe(
                    fixture.neutral,
                );
            }
        }
        expect(
            cavemanCompress("Voy a revisar la configuraci\u00f3n.", "full", undefined, "none"),
        ).toBe("Voy a revisar la configuraci\u00f3n.");
        expect(
            cavemanCompress("Es mejor que quite la l\u00ednea.", "ultra", undefined, "none"),
        ).toBe("Es mejor que quite la l\u00ednea.");
    });

    test("English output is unchanged for unset and English settings", async () => {
        const path = resolve(
            import.meta.dir,
            "../../../../../crates/mc-module/testdata/caveman-golden.json",
        );
        const cases = (await Bun.file(path).json()) as CavemanGoldenCase[];
        for (const language of [undefined, "en", "en-US"]) {
            const rules = cavemanWordRulesForLanguage(language);
            for (const fixture of cases) {
                expect(cavemanCompress(fixture.text, "lite", undefined, rules)).toBe(fixture.lite);
                expect(cavemanCompress(fixture.text, "full", undefined, rules)).toBe(fixture.full);
                expect(cavemanCompress(fixture.text, "ultra", undefined, rules)).toBe(
                    fixture.ultra,
                );
            }
        }
    });
});

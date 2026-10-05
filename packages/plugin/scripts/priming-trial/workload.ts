// The scripted coding session both arms replay, turn for turn. It works on a
// throwaway clone of the TOON repository (https://github.com/toon-format/toon) at
// a fixed commit, chosen because its source never mentions Magic Context's
// notation, so any placeholder or tag shape in the model's output comes from the
// served context and not from a file it read.

export const WORKLOAD_REPO_COMMIT = "a52f2d2815b37b69bde11b54d84b0e82cd505ce8";

type Topic = { file: string; symbol: string; test: string; dir: string };

// Twenty-five topics, one per episode of twelve turns. Files repeat with a
// different symbol so later episodes revisit code the model has already read,
// as a real session does.
const TOPICS: Topic[] = [
    { file: "packages/toon/src/index.ts", symbol: "encode", test: "packages/toon/test/encode.test.ts", dir: "packages/toon/src" },
    { file: "packages/toon/src/decode/parser.ts", symbol: "parseArrayHeaderLine", test: "packages/toon/test/decode.test.ts", dir: "packages/toon/src/decode" },
    { file: "packages/toon/src/encode/encoders.ts", symbol: "isTabularArray", test: "packages/toon/test/encodeLines.test.ts", dir: "packages/toon/src/encode" },
    { file: "packages/toon/src/shared/string-utils.ts", symbol: "unescapeString", test: "packages/toon/test/decode-errors.test.ts", dir: "packages/toon/src/shared" },
    { file: "packages/toon/src/decode/decoders.ts", symbol: "decodeKeyValueSync", test: "packages/toon/test/decodeStream.test.ts", dir: "packages/toon/src/decode" },
    { file: "packages/toon/src/encode/normalize.ts", symbol: "normalizeValue", test: "packages/toon/test/normalization.test.ts", dir: "packages/toon/src/encode" },
    { file: "packages/toon/src/encode/replacer.ts", symbol: "applyReplacer", test: "packages/toon/test/replacer.test.ts", dir: "packages/toon/src/encode" },
    { file: "packages/cli/src/conversion.ts", symbol: "encodeToToon", test: "packages/cli/test/index.test.ts", dir: "packages/cli/src" },
    { file: "packages/toon/src/decode/expand.ts", symbol: "expandPathsSafe", test: "packages/toon/test/decode.test.ts", dir: "packages/toon/src/decode" },
    { file: "packages/toon/src/encode/folding.ts", symbol: "tryFoldKeyChain", test: "packages/toon/test/encode.test.ts", dir: "packages/toon/src/encode" },
    { file: "packages/cli/src/json-from-events.ts", symbol: "jsonStreamFromEvents", test: "packages/cli/test/json-from-events.test.ts", dir: "packages/cli/src" },
    { file: "packages/toon/src/decode/scanner.ts", symbol: "parseLineIncremental", test: "packages/toon/test/decodeStream.test.ts", dir: "packages/toon/src/decode" },
    { file: "packages/toon/src/shared/validation.ts", symbol: "isSafeUnquoted", test: "packages/toon/test/encode.test.ts", dir: "packages/toon/src/shared" },
    { file: "packages/cli/src/json-stringify-stream.ts", symbol: "jsonStringifyLines", test: "packages/cli/test/json-stringify-stream.test.ts", dir: "packages/cli/src" },
    { file: "packages/toon/src/encode/primitives.ts", symbol: "encodePrimitive", test: "packages/toon/test/encode.test.ts", dir: "packages/toon/src/encode" },
    { file: "packages/toon/src/decode/event-builder.ts", symbol: "buildValueFromEvents", test: "packages/toon/test/decodeStream.test.ts", dir: "packages/toon/src/decode" },
    { file: "packages/cli/src/utils.ts", symbol: "detectMode", test: "packages/cli/test/index.test.ts", dir: "packages/cli/src" },
    { file: "packages/toon/src/decode/validation.ts", symbol: "assertExpectedCount", test: "packages/toon/test/decode-errors.test.ts", dir: "packages/toon/src/decode" },
    { file: "packages/toon/src/index.ts", symbol: "decodeStream", test: "packages/toon/test/decodeStream.test.ts", dir: "packages/toon/src" },
    { file: "packages/toon/src/decode/parser.ts", symbol: "parsePrimitiveToken", test: "packages/toon/test/decode.test.ts", dir: "packages/toon/src/decode" },
    { file: "packages/cli/src/format-error.ts", symbol: "formatError", test: "packages/cli/test/format-error.test.ts", dir: "packages/cli/src" },
    { file: "packages/toon/src/encode/encoders.ts", symbol: "encodeInlineArrayLine", test: "packages/toon/test/encodeLines.test.ts", dir: "packages/toon/src/encode" },
    { file: "packages/toon/src/decode/errors.ts", symbol: "ToonDecodeError", test: "packages/toon/test/decode-errors.test.ts", dir: "packages/toon/src/decode" },
    { file: "packages/toon/src/shared/literal-utils.ts", symbol: "isNumericLiteral", test: "packages/toon/test/decode.test.ts", dir: "packages/toon/src/shared" },
    { file: "packages/toon/src/decode/decoders.ts", symbol: "decodeArrayFromHeaderSync", test: "packages/toon/test/decode.test.ts", dir: "packages/toon/src/decode" },
];

const EPISODE: ((topic: Topic) => string)[] = [
    (t) => `Read ${t.file} and summarize what it exports and what each export is for.`,
    (t) => `Search the repository for every use of \`${t.symbol}\` and list the call sites with file and line number.`,
    (t) => `Run \`git log --oneline -n 12 -- ${t.file}\` and tell me what the most recent change to that file was about.`,
    (t) => `Explain how \`${t.symbol}\` handles its edge cases. Quote the lines that matter.`,
    (t) => `Run \`wc -l\` on every .ts file in ${t.dir} and tell me which file is the largest.`,
    (t) => `Read ${t.test} and summarize what it asserts. Which test case is the longest?`,
    (t) => `Add a one-line comment directly above the definition of \`${t.symbol}\` in ${t.file} that says what it does. Change nothing else.`,
    (t) => `Show me \`git diff\` for the working tree and confirm your change only touched that comment.`,
    (t) => `Grep for "throw" in ${t.dir} and tell me which error messages a user could see from that area.`,
    (t) => `Is there anything in ${t.file} that looks like a bug or an unhandled case? Be specific and cite lines.`,
    (t) => `Read SPEC.md around the part that governs \`${t.symbol}\` (search it first) and tell me whether the code matches the spec.`,
    (t) => `Revert your edit with \`git checkout -- ${t.file}\`, then run \`git status --short\` and confirm the tree is clean.`,
];

/** The full ordered prompt list: 25 episodes of 12 turns, 300 turns in all. */
export function workloadTurns(): string[] {
    return TOPICS.flatMap((topic) => EPISODE.map((turn) => turn(topic)));
}

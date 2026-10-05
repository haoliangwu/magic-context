/** Run with: timeout 30 bun packages/plugin/scripts/perf-audit/hr-compare.ts <before.jsonl> <after.jsonl> */
import { readFileSync } from "node:fs";

console.log(`Bun ${Bun.version}`);
function rows(path: string): Array<{ id: string; fixture: string; hash: string }> {
    return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        .filter((row) => typeof row.hash === "string");
}
const before = rows(process.argv[2]!);
const after = rows(process.argv[3]!);
let checks = 0;
for (const row of before) {
    const matches = after.filter((candidate) => candidate.id === row.id && candidate.fixture === row.fixture);
    if (!matches.length) throw new Error(`Missing after result for ${row.id} / ${row.fixture}`);
    if (matches.some((candidate) => candidate.hash !== row.hash)) throw new Error(`Reader bytes changed: ${row.id} / ${row.fixture}`);
    checks++;
}
console.log(`${checks} before/after serialized reader, chunk, tag-key, seed and digest hashes matched`);

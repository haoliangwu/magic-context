/** Compare independently captured base/current outputs, not their timing fields. */
import { deepStrictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';

type Capture = { frozenNow: number; samples: Record<string, unknown> };
const load = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Capture;
const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath || beforePath === afterPath) throw new Error('Provide two distinct base/current captures');
const before = load(beforePath);
const after = load(afterPath);
deepStrictEqual(after.frozenNow, before.frozenNow, 'expiry/formatting clock');
for (const name of ['comparisons', 'commitComparisons']) {
    const expected = name === 'comparisons' ? 10 : 20;
    deepStrictEqual(Object.keys(before.samples[name] as object).length, expected, `${name} reached`);
    deepStrictEqual(Object.keys(after.samples[name] as object).length, expected, `${name} reached`);
}
let checks = 0;
for (const name of ['comparisons', 'commitComparisons', 'MEM-5 coverage and ordered entries hash', 'MEM-10 backlog hash', 'MEM-13 ordered list hash', 'gitFixture']) {
    if (before.samples[name] === undefined || after.samples[name] === undefined) throw new Error(`Missing capture: ${name}`);
    deepStrictEqual(after.samples[name], before.samples[name], name);
    checks += name === 'comparisons' ? 10 : name === 'commitComparisons' ? 20 : 1;
}
console.log(`Bun ${Bun.version}: ${checks} independent ordered-row/served-text/mural/list/backlog/diff comparisons passed`);

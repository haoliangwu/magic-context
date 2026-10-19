// Compare the randomized provider bodies captured on the base revision and on the
// revision under review. A run in which no provider reply recorded a system prompt
// sent behind held signed thinking (an acknowledgement) must match on every pass.
// A run with an acknowledgement must match through the first acknowledged pass;
// the revision under review is designed to differ only after it.
import { readFileSync } from "node:fs";

type Row = {
    host: string;
    signed: boolean;
    active: boolean;
    seed: number;
    ackAt: number;
    acks: number;
    pending: number;
    bodies: string[];
};
const load = (path: string) =>
    new Map(
        (JSON.parse(readFileSync(path, "utf8")) as Row[]).map((row) => [
            `${row.host}-${row.active ? "active" : row.signed ? "closed" : "none"}-${row.seed}`,
            row,
        ]),
    );
const master = load(process.argv[2]!);
const reviewed = load(process.argv[3]!);
let failures = 0;
let comparedBodies = 0;
let identicalRuns = 0;
let ackedRuns = 0;
let totalAcks = 0;
for (const [key, base] of master) {
    const next = reviewed.get(key);
    if (!next) throw new Error(`missing reviewed row ${key}`);
    if (base.ackAt !== -1) throw new Error(`master acknowledged a system edit in ${key}: wrong tree`);
    const limit = next.ackAt < 0 ? base.bodies.length : next.ackAt + 1;
    const firstDiff = base.bodies.findIndex((body, i) => body !== next.bodies[i]);
    comparedBodies += limit;
    totalAcks += next.acks;
    if (next.ackAt < 0) identicalRuns++;
    else ackedRuns++;
    // Without an open signed turn nothing is ever held, so nothing may be acknowledged.
    const ok = (firstDiff < 0 || firstDiff >= limit) && (base.active || next.ackAt < 0);
    if (!ok) failures++;
    console.log(
        `${ok ? "OK  " : "FAIL"} ${key} passes=${base.bodies.length} ackAt=${next.ackAt} acks=${next.acks} firstDiff=${firstDiff} pending master=${base.pending} reviewed=${next.pending}`,
    );
}
console.log(
    `SUMMARY runs=${master.size} identicalRuns=${identicalRuns} ackedRuns=${ackedRuns} acks=${totalAcks} comparedBodies=${comparedBodies} failures=${failures}`,
);
process.exit(failures === 0 && master.size === reviewed.size ? 0 : 1);

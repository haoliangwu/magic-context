import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Records the shape of every message part Magic Context hands back to the OpenCode 2 host,
 * so a scenario can assert on the request we produce instead of on whether one particular
 * host build happens to tolerate it.
 *
 * It is loaded as a second plugin, after Magic Context, so its `context` hook runs on the
 * draft Magic Context already rewrote. A part type outside the host's content union is what
 * a schema rejection is made of; a host that accepts one today is not evidence that we
 * emitted a valid request.
 */

/** LLM.Content union members, as carried in the 2.0.7 binary's request schema. */
export const V2_CONTENT_TYPES: ReadonlySet<string> = new Set([
    "text",
    "media",
    "tool-call",
    "tool-result",
    "reasoning",
    "compaction",
    "effort",
]);

export interface OutboundShapeRecord {
    sessionID: string;
    /** Every part type in the draft, so a reader can tell "no tool parts at all" from "tool
     * parts, correctly shaped" — the first would make a union assertion vacuous. */
    types: string[];
}

export interface OutboundShapeProbe {
    /** Plugin directory to hand to `probePlugin`. The host refuses a bare file. */
    plugin: string;
    records(): OutboundShapeRecord[];
    /** Part types recorded for a session that the host's content union does not contain. */
    nonV2(sessionID: string): string[];
}

export function createOutboundShapeProbe(): OutboundShapeProbe {
    const root = mkdtempSync(join(tmpdir(), "mc-outbound-shape-"));
    const plugin = join(root, "outbound-shape");
    mkdirSync(plugin);
    const trace = join(root, "trace.jsonl");
    writeFileSync(trace, "");
    writeFileSync(
        join(plugin, "server.js"),
        `import { appendFileSync } from 'node:fs';
export default { id: 'mc-outbound-shape-probe', async setup(context) {
    await context.session.hook('context', draft => {
        const types = [];
        for (const message of draft.messages ?? []) {
            for (const part of message?.content ?? []) types.push(String(part?.type));
        }
        appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ sessionID: String(draft?.sessionID), types }) + '\\n');
    });
}};`,
    );
    const records = (): OutboundShapeRecord[] =>
        readFileSync(trace, "utf8")
            .split("\n")
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as OutboundShapeRecord);
    return {
        plugin,
        records,
        nonV2: (sessionID: string) => [
            ...new Set(
                records()
                    .filter((record) => record.sessionID === sessionID)
                    .flatMap((record) => record.types)
                    .filter((type) => !V2_CONTENT_TYPES.has(type)),
            ),
        ],
    };
}

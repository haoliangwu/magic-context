import { expect, spyOn, test } from "bun:test";
import { createLkgEntryProjector, projectLkgEntry } from "./lkg-replay";
import * as slot from "./lkg-slot";
import type { MessageLike } from "./transform-operations";

const messages = (): MessageLike[] =>
    Array.from({ length: 120 }, (_, index) => ({
        info: {
            id: `m-${index}`,
            role: index % 2 ? "assistant" : "user",
            sessionID: "session",
            time: { created: index },
            finish: "stop",
        } as never,
        parts: [
            { type: "text", text: "Unicode α and long source text\n".repeat(300) },
            {
                type: "tool",
                callID: `call-${index}`,
                state: {
                    status: "completed",
                    input: { path: "src/file.ts" },
                    output: { nested: [null, 42, true, "large tool output".repeat(200)] },
                },
            },
        ],
    }));
const digests = (entry: ReturnType<typeof projectLkgEntry>) =>
    entry.map((p) => p.contentDigest?.());

test("entry projector hashes only the new tail while matching pristine full digests", () => {
    const project = createLkgEntryProjector();
    const raw = messages();
    const expected = digests(projectLkgEntry(raw));
    const hash = spyOn(slot, "lkgContentDigestFromFields");
    try {
        const first = project("session", raw);
        expect(digests(first)).toEqual(expected);
        expect(hash).toHaveBeenCalledTimes(raw.length);
        // The transform mutates the original graph after the pristine projection.
        (raw[0]!.parts[0] as { text: string }).text = "tagged output";
        expect(digests(first)).toEqual(expected);
        const next = messages();
        next.push({
            info: { id: "tail", role: "user" } as never,
            parts: [{ type: "text", text: "continue" }],
        });
        hash.mockClear();
        const incremental = project("session", next);
        expect(hash).toHaveBeenCalledTimes(1);
        expect(digests(incremental)).toEqual(digests(projectLkgEntry(next)));
    } finally {
        hash.mockRestore();
    }
});

test("entry projector invalidates changed ids, nested content, order and session", () => {
    const project = createLkgEntryProjector();
    const raw = messages();
    project("session", raw);
    const cases = [
        (wire: MessageLike[]) => {
            (wire[10]!.parts[0] as { text: string }).text += "edited";
        },
        (wire: MessageLike[]) => {
            wire[0]!.info.id = "replacement";
        },
        (wire: MessageLike[]) => {
            wire.reverse();
        },
        (wire: MessageLike[]) => {
            (wire[1]!.parts[1] as { state: { output: unknown } }).state.output = { changed: true };
        },
    ];
    for (const mutate of cases) {
        const wire = structuredClone(raw);
        mutate(wire);
        expect(digests(project("session", wire))).toEqual(digests(projectLkgEntry(wire)));
    }
    expect(digests(project("other-session", raw))).toEqual(digests(projectLkgEntry(raw)));
});

test("entry projector retains bounded reuse when the restored history exceeds its budget", () => {
    const raw = messages();
    const project = createLkgEntryProjector({ maxBytes: 200_000 });
    project("restored", raw);
    const hash = spyOn(slot, "lkgContentDigestFromFields");
    try {
        const projected = project("restored", structuredClone(raw));
        const calls = hash.mock.calls.length;
        expect(calls).toBeGreaterThan(0);
        expect(calls).toBeLessThan(raw.length);
        expect(digests(projected)).toEqual(digests(projectLkgEntry(raw)));
    } finally {
        hash.mockRestore();
    }
});

test("entry projector reuses unchanged successors after a leading metadata edit", () => {
    const raw = messages();
    const project = createLkgEntryProjector();
    project("restored", raw);
    const changed = structuredClone(raw);
    (changed[0]!.info as unknown as { time: { created: number } }).time.created += 1;
    const hash = spyOn(slot, "lkgContentDigestFromFields");
    try {
        const projected = project("restored", changed);
        expect(hash).toHaveBeenCalledTimes(1);
        expect(digests(projected)).toEqual(digests(projectLkgEntry(changed)));
    } finally {
        hash.mockRestore();
    }
});

test("entry projector reuses exact entries across head trims without trusting ids alone", () => {
    const raw = messages();
    const project = createLkgEntryProjector();
    project("trimmed", raw);
    const shifted = structuredClone(raw.slice(5));
    (shifted[4]!.parts[0] as { text: string }).text += "!";
    const hash = spyOn(slot, "lkgContentDigestFromFields");
    try {
        const projected = project("trimmed", shifted);
        expect(hash).toHaveBeenCalledTimes(1);
        expect(digests(projected)).toEqual(digests(projectLkgEntry(shifted)));
    } finally {
        hash.mockRestore();
    }
});

import { expect, test } from "bun:test";
import { jsonHashSink, stableStringify, stableStringifyHash } from "./stable-json";
import { piJsonHash, TailHygieneJsonMemo } from "./tail-hygiene-json";

function hash(text: string): string {
    const sink = jsonHashSink("excluded\0");
    sink.write(text);
    return sink.digest();
}

function piStringify(value: unknown): string {
    const seen = new Set<object>();
    try {
        return (
            JSON.stringify(value, (_key, current) => {
                if (!current || typeof current !== "object" || Array.isArray(current))
                    return current;
                if (seen.has(current)) return "[Circular]";
                seen.add(current);
                return Object.fromEntries(
                    Object.entries(current).sort(([a], [b]) => a.localeCompare(b)),
                );
            }) ?? ""
        );
    } catch {
        return "";
    }
}

test("streamed excluded fingerprints equal both original serializers on randomized values", () => {
    let state = 704;
    const random = (n: number): number => {
        state = (Math.imul(state, 1664525) + 1013904223) | 0;
        return (state >>> 0) % n;
    };
    const leaves = [
        undefined,
        null,
        -0,
        NaN,
        Infinity,
        1e-7,
        1e23,
        false,
        "\ud800",
        "é😀\n\u2028",
        '"\\',
    ];
    const generate = (depth: number): unknown => {
        if (!depth || random(3) === 0) return leaves[random(leaves.length)];
        if (random(2)) {
            const array = new Array(4);
            array[0] = generate(depth - 1);
            array[2] = undefined;
            array[3] = generate(depth - 1);
            return array;
        }
        const value: Record<string, unknown> = {};
        const keys = ["10", "2", "Z", "ä", "a", "e\u0301", "é"];
        for (let i = 0; i < 4; i++) value[keys[random(keys.length)]] = generate(depth - 1);
        if (random(5) === 0) value.self = value;
        return value;
    };
    const shared = { a: undefined, z: "shared" };
    const cycle: unknown[] = [];
    cycle.push(cycle);
    const samples: unknown[] = [
        cycle,
        { a: shared, b: shared },
        1n,
        new Date(0),
        { toJSON: () => "date" },
    ];
    for (let i = 0; i < 2_000; i++) samples.push(generate(4));
    for (const value of samples) {
        try {
            const expected = stableStringify(value);
            expect(stableStringifyHash(value, "excluded\0")).toBe(hash(expected));
        } catch {
            expect(() => stableStringifyHash(value, "excluded\0")).toThrow();
        }
        expect(piJsonHash(value, () => piStringify(value))).toBe(hash(piStringify(value)));
    }
    console.log(`excluded fingerprint differential: ${samples.length} values per serializer`);
});

test("part memo catches in-place edits, alias changes, key order and accessor values", () => {
    const memo = new TailHygieneJsonMemo();
    let calls = 0;
    const get = (value: unknown): string => {
        memo.beginPass();
        return memo.get("part", value, () => {
            calls++;
            return stableStringify(value);
        });
    };
    const shared = { value: "first" };
    const value = { a: shared, b: shared };
    expect(get(value)).toBe(get(structuredClone(value)));
    expect(calls).toBe(1);
    shared.value = "other";
    expect(get(value)).toContain("other");
    expect(calls).toBe(2);
    value.b = { value: "other" };
    expect(get(value)).not.toContain("Circular");
    expect(calls).toBe(3);
    expect(get({ b: value.b, a: value.a })).toBe(get(value));
    expect(calls).toBe(5);
    let changing = 0;
    const accessor = {
        get value() {
            return ++changing;
        },
    };
    expect(get(accessor)).not.toBe(get(accessor));
    expect(calls).toBe(7);
});

import { jsonHashSink } from "./stable-json";

const MAX_MEMO_BYTES = 64 * 1024 * 1024;
const MAX_MEMO_ENTRIES = 10_000;

/**
 * A bounded, process-local memo for individual parts and selected tool fields.
 * Detached snapshots catch in-place host edits; reference equality alone cannot.
 * Key collisions between sessions only evict entries, never imply equality.
 */
export class TailHygieneJsonMemo {
    private entries = new Map<string, { snapshot: unknown; result: string; bytes: number }>();
    private bytes = 0;
    private passText = new WeakMap<object, string>();
    private passHash = new WeakMap<object, string>();

    beginPass(): void {
        this.passText = new WeakMap();
        this.passHash = new WeakMap();
    }

    get(key: string, value: unknown, compute: () => string, fingerprint = false): string {
        const pass = fingerprint ? this.passHash : this.passText;
        const object = value !== null && typeof value === "object" ? value : undefined;
        const local = object ? pass.get(object) : undefined;
        if (local !== undefined) return local;
        const previous = this.entries.get(key);
        if (previous && sameJson(previous.snapshot, value)) {
            if (object) pass.set(object, previous.result);
            return previous.result;
        }
        const result = compute();
        if (previous) {
            this.bytes -= previous.bytes;
            this.entries.delete(key);
        }
        try {
            const copy = copyJson(value);
            const bytes = copy.bytes + (key.length + result.length) * 2;
            if (bytes <= MAX_MEMO_BYTES) {
                this.entries.set(key, { snapshot: copy.value, result, bytes });
                this.bytes += bytes;
                if (object) pass.set(object, result);
            }
        } catch {
            // Accessors and exotic objects retain their original serialization behavior.
        }
        while (this.bytes > MAX_MEMO_BYTES || this.entries.size > MAX_MEMO_ENTRIES) {
            const oldest = this.entries.entries().next().value;
            if (!oldest) break;
            this.bytes -= oldest[1].bytes;
            this.entries.delete(oldest[0]);
        }
        return result;
    }
}

function copyJson(value: unknown): { value: unknown; bytes: number } {
    const seen = new Map<object, unknown>();
    let bytes = 0;
    const copy = (current: unknown): unknown => {
        bytes += 16;
        if (typeof current === "string") bytes += current.length * 2;
        if (bytes > MAX_MEMO_BYTES) throw new Error("memo capacity");
        if (current === null || typeof current !== "object") {
            if (["function", "symbol", "bigint"].includes(typeof current))
                throw new Error("exotic");
            return current;
        }
        if (seen.has(current)) return seen.get(current);
        const prototype = Object.getPrototypeOf(current);
        if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null)
            throw new Error("exotic");
        const result = Array.isArray(current)
            ? new Array(current.length)
            : Object.create(prototype);
        seen.set(current, result);
        for (const key of Object.keys(current)) {
            const descriptor = Object.getOwnPropertyDescriptor(current, key);
            if (!descriptor || !("value" in descriptor)) throw new Error("accessor");
            bytes += key.length * 2 + 16;
            if (key === "__proto__") {
                Object.defineProperty(result, key, {
                    value: copy(descriptor.value),
                    enumerable: true,
                    writable: true,
                    configurable: true,
                });
            } else result[key] = copy(descriptor.value);
        }
        return result;
    };
    return { value: copy(value), bytes };
}

function sameJson(before: unknown, after: unknown): boolean {
    const forward = new Map<object, object>();
    const reverse = new Set<object>();
    const same = (left: unknown, right: unknown): boolean => {
        if (
            left === null ||
            right === null ||
            typeof left !== "object" ||
            typeof right !== "object"
        )
            return Object.is(left, right);
        if (forward.has(left)) return forward.get(left) === right;
        if (reverse.has(right) || Object.getPrototypeOf(left) !== Object.getPrototypeOf(right))
            return false;
        forward.set(left, right);
        reverse.add(right);
        if (Array.isArray(left) && (!Array.isArray(right) || left.length !== right.length))
            return false;
        const keys = Object.keys(left);
        const otherKeys = Object.keys(right);
        if (keys.length !== otherKeys.length) return false;
        for (let index = 0; index < keys.length; index++) {
            const key = keys[index];
            // Pi sorts with localeCompare, which can tie distinct Unicode spellings.
            // Preserve insertion order too, because a tied sort keeps that order.
            if (key !== otherKeys[index]) return false;
            const descriptor = Object.getOwnPropertyDescriptor(right, key);
            if (
                !descriptor ||
                !("value" in descriptor) ||
                !same((left as Record<string, unknown>)[key], descriptor.value)
            )
                return false;
        }
        return true;
    };
    return same(before, after);
}

/**
 * Fingerprint excluded Pi content without retaining its whole JSON string.
 * Match Pi's native JSON replacer: localeCompare key order, omitted undefined
 * object fields, null array holes, and a marker for repeated non-array objects.
 * Unsupported objects and array cycles use the original serializer; serialization
 * errors produce the fingerprint of an empty string, as they did before.
 */
export function piJsonHash(value: unknown, fallback: () => string): string {
    const sink = jsonHashSink("excluded\0");
    try {
        const seen = new Set<object>();
        const arrays = new Set<object>();
        const write = (current: unknown): void => {
            if (current === null || typeof current !== "object") {
                if (["function", "symbol", "bigint"].includes(typeof current))
                    throw new Error("exotic");
                sink.write(JSON.stringify(current) ?? "");
            } else if (Array.isArray(current)) {
                if (
                    Object.getPrototypeOf(current) !== Array.prototype ||
                    Object.hasOwn(current, "toJSON")
                )
                    throw new Error("exotic array");
                if (arrays.has(current)) throw new Error("array cycle");
                arrays.add(current);
                sink.write("[");
                for (let index = 0; index < current.length; index++) {
                    if (index) sink.write(",");
                    const descriptor = Object.getOwnPropertyDescriptor(current, index);
                    if (descriptor && !("value" in descriptor)) throw new Error("accessor");
                    if (!descriptor && index in current) throw new Error("inherited array element");
                    write(descriptor?.value === undefined ? null : descriptor.value);
                }
                sink.write("]");
                arrays.delete(current);
            } else if (seen.has(current)) {
                sink.write('"[Circular]"');
            } else {
                const prototype = Object.getPrototypeOf(current);
                if (prototype !== Object.prototype && prototype !== null) throw new Error("exotic");
                seen.add(current);
                const entries = Object.keys(current).map((key): [string, unknown] => {
                    const descriptor = Object.getOwnPropertyDescriptor(current, key);
                    if (!descriptor || !("value" in descriptor)) throw new Error("accessor");
                    return [key, descriptor.value];
                });
                const sorted = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
                if (
                    entries.length <= 16 &&
                    entries.every(
                        ([key, child]) =>
                            key.length <= 4096 &&
                            (child === null ||
                                child === undefined ||
                                typeof child === "number" ||
                                typeof child === "boolean" ||
                                (typeof child === "string" && child.length <= 4096)),
                    )
                ) {
                    sink.write(JSON.stringify(sorted));
                    return;
                }
                sink.write("{");
                let first = true;
                for (const [key, child] of Object.entries(sorted)) {
                    if (child === undefined) continue;
                    if (!first) sink.write(",");
                    first = false;
                    sink.write(JSON.stringify(key));
                    sink.write(":");
                    write(child);
                }
                sink.write("}");
            }
        };
        write(value);
        return sink.digest();
    } catch {
        const failed = jsonHashSink("excluded\0");
        failed.write(fallback());
        return failed.digest();
    }
}

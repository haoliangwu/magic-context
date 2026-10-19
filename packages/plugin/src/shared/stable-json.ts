/**
 * Process-local deterministic JSON serialization for JSON-like plain
 * objects. Keys are sorted by code-point order (NOT locale-sensitive).
 *
 * Contract:
 * - Stable for plain objects, arrays, primitives, and `null`.
 * - `undefined` serialized as the string "undefined".
 * - Circular references serialized as the string `"[Circular]"`.
 * - **NOT** a canonical cross-runtime / cross-locale JSON serializer.
 *   Two different runtimes that disagree on `JSON.stringify` of primitives
 *   (none known today) would produce different output.
 *
 * Used for:
 * - `tool_definition_measurements` fingerprint hashing
 * - `pending_compaction_marker_state` CAS comparison
 *
 * If a future use case needs true canonical JSON (e.g. cross-process
 * signing), build a separate utility — do NOT widen this contract.
 */
export function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
    // Collect pieces and join once. Joining at every level copied each nested
    // value's text once per enclosing level, so a large value N levels deep cost
    // N copies of itself.
    const pieces: string[] = [];
    writeStable(value, seen, (piece) => pieces.push(piece));
    return pieces.join("");
}

function writeStable(value: unknown, seen: WeakSet<object>, write: (piece: string) => void): void {
    if (value === undefined) {
        write("undefined");
        return;
    }
    if (value === null || typeof value !== "object") {
        write(JSON.stringify(value) ?? String(value));
        return;
    }
    // Any object met a second time, shared or cyclic, is written as "[Circular]".
    if (seen.has(value)) {
        write('"[Circular]"');
        return;
    }
    seen.add(value);
    if (Array.isArray(value)) {
        write("[");
        for (let index = 0; index < value.length; index += 1) {
            if (index > 0) write(",");
            // A hole writes nothing between its commas, as joining a mapped array did.
            if (index in value) writeStable(value[index], seen, write);
        }
        write("]");
        return;
    }
    // Code-point sort (NOT localeCompare). Stable across runtimes/locales.
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => {
        if (a < b) return -1;
        if (a > b) return 1;
        return 0;
    });
    // Native JSON can emit a small scalar-only object in one operation. Larger
    // containers still stream; undefined and integer keys need the writer's
    // non-native spelling/order. Bound chunks so hashing never builds a large JSON string.
    if (
        entries.length > 0 &&
        entries.length <= 16 &&
        entries.every(
            ([key, child]) =>
                key.length <= 4096 &&
                !/^(0|[1-9]\d*)$/.test(key) &&
                (child === null ||
                    typeof child === "number" ||
                    typeof child === "boolean" ||
                    (typeof child === "string" && child.length <= 4096)),
        )
    ) {
        write(JSON.stringify(Object.fromEntries(entries)));
        return;
    }
    write("{");
    entries.forEach(([key, child], index) => {
        if (index > 0) write(",");
        write(JSON.stringify(key));
        write(":");
        writeStable(child, seen, write);
    });
    write("}");
}

/** The existing UTF-16 FNV fingerprint, without retaining the serialized JSON. */
export function stableStringifyHash(value: unknown, prefix = ""): string {
    const sink = jsonHashSink(prefix);
    writeStable(value, new WeakSet(), sink.write);
    return sink.digest();
}

/** Hash the same code units as the content memo, including lone surrogates. */
export function jsonHashSink(prefix = ""): {
    write: (piece: string) => void;
    digest: () => string;
} {
    let hash = 0x811c9dc5;
    const write = (piece: string): void => {
        for (let index = 0; index < piece.length; index++) {
            hash = Math.imul(hash ^ piece.charCodeAt(index), 0x01000193);
        }
    };
    write(prefix);
    return { write, digest: () => (hash >>> 0).toString(16).padStart(8, "0") };
}

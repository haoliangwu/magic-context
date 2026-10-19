import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

function vectorUpdates(source: string): number[] {
    const sql = source
        .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
        .replace(/--[^\n]*/g, "");
    // Generic table helpers can target chunk embeddings, so their vector/dims
    // assignments are fenced as well as statements naming the table directly.
    const updates =
        /\bUPDATE\s+(?:OR\s+\w+\s+)?(?:["`[]?\w+["`\]]?\.)?(?:["`[]?compartment_chunk_embeddings["`\]]?|\\?["`]?(?:\$\{[^}]+\}|\{[^}]*\})\\?["`]?)(?:\s+(?:AS\s+)?\w+)?\s+SET\s+([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|;|$)/gi;
    return [...sql.matchAll(updates)]
        .filter((match) =>
            /(?:^|,)\s*(?:["`[]?(?:vector|dims)["`\]]?\s*=|\([^)]*\b(?:vector|dims)\b[^)]*\)\s*=)/i.test(
                match[1],
            ),
        )
        .map((match) => sql.slice(0, match.index).split("\n").length);
}

test("writer guard recognizes vector/dims updates without rejecting metadata repairs", () => {
    expect(
        vectorUpdates("UPDATE compartment_chunk_embeddings SET vector = ? WHERE id = ?"),
    ).toHaveLength(1);
    expect(vectorUpdates("UPDATE ${shape.table} SET dims = ? WHERE session_id = ?")).toHaveLength(
        1,
    );
    expect(
        vectorUpdates(
            'UPDATE "main"."compartment_chunk_embeddings" SET (vector, dims) = (?, ?) WHERE id = ?',
        ),
    ).toHaveLength(1);
    expect(
        vectorUpdates(
            'UPDATE main."compartment_chunk_embeddings" AS e SET window_index = ?, "dims" = ? WHERE id = ?',
        ),
    ).toHaveLength(1);
    expect(
        vectorUpdates("UPDATE compartment_chunk_embeddings SET project_path = ? WHERE id = ?"),
    ).toEqual([]);
    expect(
        vectorUpdates("UPDATE compartment_chunk_embeddings SET window_index = ? WHERE id = ?"),
    ).toEqual([]);
});

test("production chunk vectors and dimensions are immutable at their rowid", () => {
    const root = resolve(import.meta.dir, "../../../..");
    const violations: string[] = [];
    const scan = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
                if (
                    !/^(?:node_modules|dist|target|fixtures|__tests__|tui-compiled)$/.test(
                        entry.name,
                    )
                )
                    scan(path);
            } else if (
                /\.(?:tsx?|rs|py|sql|[cm]?js)$/.test(entry.name) &&
                !/(?:\.test|\.spec|_tests?|\.fixture|\.test-support)\./.test(entry.name)
            ) {
                for (const line of vectorUpdates(readFileSync(path, "utf8"))) {
                    violations.push(`${relative(root, path)}:${line}`);
                }
            }
        }
    };
    for (const directory of ["packages", "crates", "scripts"]) scan(join(root, directory));
    expect(violations).toEqual([]);
});

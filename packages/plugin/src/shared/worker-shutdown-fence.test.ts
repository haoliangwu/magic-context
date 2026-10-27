import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

// A worker that installs exitOnWorkerClose must close its parent port only
// through the returned closePort, which removes the close listener first. On
// Bun 1.3.14 a worker whose port closes with that listener still attached never
// exits, and the port's own close() cannot be wrapped there (it is read-only),
// so this fence rejects a direct close in any such file.

const root = resolve(import.meta.dir, "../../../..");
const helper = "packages/plugin/src/shared/worker-shutdown.ts";

function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return files(path);
        return /\.tsx?$/.test(path) && !/\.test\.|\.d\.ts$/.test(path) ? [path] : [];
    });
}

function unwrap(node: ts.Expression): ts.Expression {
    let current = node;
    while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current))
        current = current.expression;
    return current;
}

/** Direct closes of the parent port, or of a variable holding it, in a file that installs the close listener. */
function scan(path: string, text: string): { usesHelper: boolean; violations: string[] } {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const ports = new Set(["parentPort"]);
    let usesHelper = false;
    const closes: ts.CallExpression[] = [];
    const visit = (node: ts.Node) => {
        if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.initializer &&
            ts.isIdentifier(unwrap(node.initializer)) &&
            ports.has((unwrap(node.initializer) as ts.Identifier).text)
        )
            ports.add(node.name.text);
        if (ts.isCallExpression(node)) {
            const callee = unwrap(node.expression);
            if (ts.isIdentifier(callee) && callee.text === "exitOnWorkerClose") usesHelper = true;
            if (ts.isPropertyAccessExpression(callee) && callee.name.text === "close")
                closes.push(node);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!usesHelper || path === helper) return { usesHelper, violations: [] };
    const violations = closes.flatMap((call) => {
        const target = unwrap((unwrap(call.expression) as ts.PropertyAccessExpression).expression);
        if (!ts.isIdentifier(target) || !ports.has(target.text)) return [];
        const line = source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1;
        return [
            `${path}:${line}: close the port through exitOnWorkerClose's closePort, not ${target.text}.close()`,
        ];
    });
    return { usesHelper, violations };
}

test("workers with the close listener close their port only through closePort", () => {
    const scans = ["packages/plugin/src", "packages/pi-plugin/src", "packages/cli/src"]
        .flatMap((directory) => files(join(root, directory)))
        .map((path) => scan(relative(root, path), readFileSync(path, "utf8")));
    // Pi tag snapshots, raw-ordinal warm-up, auto-search, the chunk writer and the test fixture.
    expect(scans.filter((result) => result.usesHelper).length).toBeGreaterThanOrEqual(5);
    expect(scans.flatMap((result) => result.violations)).toEqual([]);
});

test("the fence rejects direct port closes and accepts closePort", () => {
    const header = 'import { parentPort } from "node:worker_threads";\n';
    const install = "const { closePort } = exitOnWorkerClose(parentPort, () => db.close());\n";
    expect(scan("worker.ts", `${header}${install}parentPort?.close();`).violations).toHaveLength(1);
    expect(
        scan("worker.ts", `${header}const port = parentPort!;\n${install}port.close();`).violations,
    ).toHaveLength(1);
    expect(
        scan("worker.ts", `${header}${install}db.close();\nclosePort();`).violations,
    ).toHaveLength(0);
    // A worker without the close listener may close its port directly.
    expect(scan("worker.ts", `${header}parentPort?.close();`).violations).toHaveLength(0);
});

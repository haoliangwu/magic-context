import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../../../..");
const subprocessNames = new Set([
    "exec",
    "execSync",
    "execFile",
    "execFileSync",
    "spawn",
    "spawnSync",
]);

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
    });
}

function missingHiddenOptions(path: string): string[] {
    const text = readFileSync(path, "utf8");
    if (!/node:child_process|Bun\.spawn/.test(text)) return [];
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const imports = new Set<string>();
    const variables = new Map<string, ts.Expression>();
    for (const statement of source.statements) {
        if (
            ts.isImportDeclaration(statement) &&
            statement.moduleSpecifier.getText(source).includes("node:child_process")
        ) {
            const bindings = statement.importClause?.namedBindings;
            if (bindings && ts.isNamedImports(bindings)) {
                for (const element of bindings.elements) {
                    if (subprocessNames.has(element.propertyName?.text ?? element.name.text))
                        imports.add(element.name.text);
                }
            }
        }
    }
    function collect(node: ts.Node): void {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer)
            variables.set(node.name.text, node.initializer);
        ts.forEachChild(node, collect);
    }
    collect(source);
    function hidden(node: ts.Expression | undefined, seen = new Set<string>()): boolean {
        if (!node) return false;
        if (ts.isIdentifier(node)) {
            if (seen.has(node.text)) return false;
            seen.add(node.text);
            return hidden(variables.get(node.text), seen);
        }
        if (!ts.isObjectLiteralExpression(node)) return false;
        // Later spreads can override an earlier flag, so inspect the effective last assignment.
        for (const property of [...node.properties].reverse()) {
            if (
                ts.isPropertyAssignment(property) &&
                property.name.getText(source) === "windowsHide"
            ) {
                return property.initializer.kind === ts.SyntaxKind.TrueKeyword;
            }
            if (ts.isSpreadAssignment(property) && hidden(property.expression, new Set(seen)))
                return true;
        }
        return false;
    }
    const failures: string[] = [];
    function visit(node: ts.Node): void {
        if (ts.isCallExpression(node)) {
            const expression = node.expression;
            let name: string | undefined;
            if (
                ts.isIdentifier(expression) &&
                (imports.has(expression.text) ||
                    [
                        "execFileAsync",
                        "execFileSyncForIdentity",
                        "rpcIdentityExecFileSync",
                        "execFileForVerificationPaths",
                    ].includes(expression.text) ||
                    (expression.text === "exec" && path.endsWith("rpc-utils.ts")))
            )
                name = expression.text;
            if (ts.isPropertyAccessExpression(expression)) {
                const owner = expression.expression.getText(source);
                if (
                    owner === "Bun" &&
                    (expression.name.text === "spawn" || expression.name.text === "spawnSync")
                )
                    name = "Bun.spawn";
                if (
                    (owner === "deps" || owner === "this") &&
                    (subprocessNames.has(expression.name.text) ||
                        expression.name.text === "spawnImpl")
                )
                    name = expression.name.text;
            }
            if (name) {
                const index =
                    name === "Bun.spawn"
                        ? node.arguments.length === 1
                            ? 0
                            : 1
                        : name === "execSync" || (name === "exec" && !path.endsWith("rpc-utils.ts"))
                          ? 1
                          : 2;
                // A single-argument Bun.spawnSync({cmd, ...}) passes options as its first argument.
                const option = node.arguments[index];
                if (!hidden(option)) {
                    const line =
                        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
                    failures.push(`${relative(root, path)}:${line} ${name}`);
                }
            }
        }
        ts.forEachChild(node, visit);
    }
    visit(source);
    return failures;
}

describe("Windows child processes", () => {
    test("every plugin, Pi and CLI subprocess hides its Windows console", () => {
        const failures = ["plugin", "pi-plugin", "cli"].flatMap((pkg) =>
            sourceFiles(join(root, "packages", pkg, "src")).flatMap(missingHiddenOptions),
        );
        expect(failures).toEqual([]);
    });
});

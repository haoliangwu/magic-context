import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../../../..");
const shared = "packages/plugin/src/shared/sqlite.ts";
function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return files(path);
        return /\.tsx?$/.test(path) && !/\.test\.|test-support|\.d\.ts$/.test(path) ? [path] : [];
    });
}

function scan(
    path: string,
    text: string,
): { violations: string[]; transactions: number; literals: number } {
    const violations: string[] = [];
    let transactions = 0;
    let literals = 0;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "transaction"
        )
            transactions++;
        if (
            path !== shared &&
            ts.isImportDeclaration(node) &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            !node.importClause?.isTypeOnly &&
            /^(bun:sqlite|node:sqlite|better-sqlite3)$/.test(node.moduleSpecifier.text)
        ) {
            violations.push(`${path}: native SQLite import bypasses shared acquisition`);
        }
        if (
            path !== shared &&
            ts.isExportDeclaration(node) &&
            !node.isTypeOnly &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier) &&
            /^(bun:sqlite|node:sqlite|better-sqlite3)$/.test(node.moduleSpecifier.text)
        ) {
            violations.push(`${path}: native SQLite re-export bypasses shared acquisition`);
        }
        if (
            path !== shared &&
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
            /(?:bun:sqlite|node:sqlite|better-sqlite3)/.test(
                node.arguments.map((arg) => arg.getText(source)).join(""),
            )
        ) {
            violations.push(`${path}: dynamic native SQLite import bypasses shared acquisition`);
        }
        const sqlText = ts.isStringLiteralLike(node)
            ? node.text
            : ts.isTemplateExpression(node)
              ? node.head.text + node.templateSpans.map((span) => span.literal.text).join("")
              : undefined;
        if (
            sqlText !== undefined &&
            /\bBEGIN\s+(?:IMMEDIATE|EXCLUSIVE)(?:\s+TRANSACTION)?\s*(?:;|$)/i.test(sqlText)
        ) {
            literals++;
            if (path !== shared) {
                const call = node.parent;
                const routed =
                    !ts.isTemplateExpression(node) &&
                    ts.isCallExpression(call) &&
                    ts.isPropertyAccessExpression(call.expression) &&
                    call.expression.name.text === "exec" &&
                    /^\s*BEGIN\s+(IMMEDIATE|EXCLUSIVE)(?:\s+TRANSACTION)?\s*;?\s*$/i.test(sqlText);
                if (!routed)
                    violations.push(
                        `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: BEGIN acquisition must be a standalone shared Database.exec call`,
                    );
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return { violations, transactions, literals };
}

test("all production transaction acquisition routes through the shared SQLite runtime", () => {
    const scans = ["packages/plugin/src", "packages/pi-plugin/src", "packages/cli/src"]
        .flatMap((directory) => files(join(root, directory)))
        .map((path) => scan(relative(root, path), readFileSync(path, "utf8")));
    expect(scans.reduce((sum, scan) => sum + scan.transactions, 0)).toBeGreaterThan(50);
    expect(scans.reduce((sum, scan) => sum + scan.literals, 0)).toBeGreaterThan(20);
    expect(scans.flatMap((scan) => scan.violations)).toEqual([]);
});

test("acquisition fence rejects raw native transactions and unrouted BEGIN shapes", () => {
    expect(
        scan(
            "new-writer.ts",
            'import { Database } from "bun:sqlite"; new Database(":memory:").transaction(() => write())();',
        ).violations,
    ).toHaveLength(1);
    expect(
        scan(
            "new-writer.ts",
            'const { DatabaseSync } = require("node:sqlite"); new DatabaseSync(":memory:").transaction(() => write())();',
        ).violations,
    ).toHaveLength(1);
    expect(scan("new-writer.ts", 'export { Database } from "bun:sqlite";').violations).toHaveLength(
        1,
    );
    expect(scan("new-writer.ts", 'db.prepare("BEGIN IMMEDIATE").run();').violations).toHaveLength(
        1,
    );
    expect(
        scan("new-writer.ts", 'db.exec("BEGIN IMMEDIATE; INSERT INTO result VALUES (1)");')
            .violations,
    ).toHaveLength(1);
    expect(scan("new-writer.ts", "db.exec(`BEGIN IMMEDIATE; ${extra}`);").violations).toHaveLength(
        1,
    );
    expect(
        scan(
            "new-writer.ts",
            'import { Database } from "./shared/sqlite"; db.exec("BEGIN IMMEDIATE"); db.transaction(() => write()).immediate();',
        ).violations,
    ).toEqual([]);
});

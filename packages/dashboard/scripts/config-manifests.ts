import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const plugin = resolve(import.meta.dir, "../../plugin/src");
function source(path: string) {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
}
function literal(node: ts.Expression): string {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  throw new Error(`Description must be a static string: ${node.getText()}`);
}
function constants(path: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const statement of source(path).statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && /DESCRIPTION$/.test(declaration.name.text)) {
        values[declaration.name.text] = literal(declaration.initializer);
      }
    }
  }
  return values;
}

/** Read the active registry and each tool's actual description expression, not a copied catalog. */
export function toolDescriptionManifest(): Record<string, { full: string; light: string }> {
  const registry = source(resolve(plugin, "shared/prompt-surface-runtime.ts"));
  const statement = registry.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => d.name.getText() === "ACTIVE_TOOL_IDS")) as ts.VariableStatement;
  const initializer = statement.declarationList.declarations[0].initializer as ts.AsExpression;
  const ids = (initializer.expression as ts.ArrayLiteralExpression).elements.map((node) => literal(node as ts.Expression));
  const light = constants(resolve(plugin, "tools/light-descriptions.ts"));
  return Object.fromEntries(ids.map((id) => {
    const folder = id.replaceAll("_", "-");
    const file = source(resolve(plugin, `tools/${folder}/tools.ts`));
    let expression: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (!expression && ts.isCallExpression(node) && node.expression.getText() === "tool" && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
        const description = node.arguments[0].properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText() === "description");
        if (description && ts.isPropertyAssignment(description)) expression = description.initializer;
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    if (!expression) throw new Error(`No tool description for ${id}`);
    const full = ts.isIdentifier(expression) ? constants(resolve(plugin, `tools/${folder}/constants.ts`))[expression.text] : literal(expression);
    const short = light[`${id.toUpperCase()}_LIGHT_DESCRIPTION`];
    if (!full || !short) throw new Error(`Missing full/light tool definition for ${id}`);
    return [id, { full, light: short }];
  }));
}

/** Pi publishes exact per-model thinking support; this does not inspect operator config or credentials. */
export async function piThinkingManifest(): Promise<Record<string, string[]>> {
  const { MODELS } = await import("../../pi-plugin/node_modules/pi-ai-086/dist/models.generated.js");
  const { getSupportedThinkingLevels } = await import("../../pi-plugin/node_modules/pi-ai-086/dist/models.js");
  // Group identical support sets so the dashboard ships IDs, not repeated level arrays.
  const groups: Record<string, string[]> = {};
  for (const [provider, models] of Object.entries(MODELS)) {
    for (const model of Object.values(models)) {
      const key = getSupportedThinkingLevels(model).join(",");
      (groups[key] ??= []).push(`${provider}/${model.id}`);
    }
  }
  return groups;
}

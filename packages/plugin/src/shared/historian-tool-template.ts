/** A deliberately non-executable language for readable, bounded historian tool lines. */
export type ToolExpansionMap = Record<string, string | false>;
type Step = { field: string } | { index: number } | { project: string };
type Expression = {
    steps: Step[];
    each?: Template;
    join?: string;
    count?: boolean;
    cap: number;
};
type Template = Array<string | Expression>;

class Parser {
    pos = 0;
    constructor(private source: string) {}
    error(): never {
        throw new Error(`Invalid tool expansion template at character ${this.pos + 1}`);
    }
    take(value: string): boolean {
        if (!this.source.startsWith(value, this.pos)) return false;
        this.pos += value.length;
        return true;
    }
    field(): string {
        const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(this.source.slice(this.pos));
        if (!match) return this.error();
        this.pos += match[0].length;
        return match[0];
    }
    quoted(): string {
        const start = this.pos;
        if (!this.take('"')) return this.error();
        while (this.pos < this.source.length) {
            if (this.take("\\")) {
                this.pos++;
                continue;
            }
            if (this.take('"')) {
                try {
                    return JSON.parse(this.source.slice(start, this.pos));
                } catch {
                    return this.error();
                }
            }
            this.pos++;
        }
        return this.error();
    }
    integer(): number {
        const match = /^\d+/.exec(this.source.slice(this.pos));
        if (!match) return this.error();
        this.pos += match[0].length;
        const n = Number(match[0]);
        if (!Number.isSafeInteger(n)) return this.error();
        return n;
    }
    expression(relative: boolean): Expression {
        const steps: Step[] = [];
        if (!(relative && this.take("."))) {
            const root = this.field();
            if (!relative && root !== "input" && root !== "output") return this.error();
            steps.push({ field: root });
        }
        while (true) {
            if (this.take("[")) {
                if (this.take("*].")) steps.push({ project: this.field() });
                else {
                    const index = this.integer();
                    if (!this.take("]")) return this.error();
                    steps.push({ index });
                }
            } else if (
                this.source[this.pos] === "." &&
                !/^\.(each\(|join\(|count(?:\.|\})|truncate\()/.test(this.source.slice(this.pos))
            ) {
                this.pos++;
                steps.push({ field: this.field() });
                if (this.source[this.pos] === "(") return this.error();
            } else break;
        }
        const expression: Expression = { steps, cap: 300 };
        if (this.take(".each(")) {
            if (relative) return this.error();
            expression.each = parseTemplate(this.quoted(), true);
            if (!this.take(")")) return this.error();
        }
        if (this.take(".join(")) {
            expression.join = this.quoted();
            if (!this.take(")")) return this.error();
        }
        if (this.take(".count")) {
            if (expression.each || expression.join !== undefined) return this.error();
            expression.count = true;
        }
        if (this.take(".truncate(")) {
            expression.cap = this.integer();
            if (!this.take(")")) return this.error();
        }
        if (!this.take("}")) return this.error();
        return expression;
    }
    template(relative: boolean): Template {
        const nodes: Template = [];
        while (this.pos < this.source.length) {
            const next = this.source.indexOf("${", this.pos);
            if (next < 0) {
                nodes.push(this.source.slice(this.pos));
                break;
            }
            nodes.push(this.source.slice(this.pos, next));
            this.pos = next + 2;
            nodes.push(this.expression(relative));
        }
        return nodes;
    }
}

function parseTemplate(source: string, relative = false): Template {
    return new Parser(source).template(relative);
}

export function toolTemplateError(source: string): string | undefined {
    try {
        parseTemplate(source);
        return undefined;
    } catch (error) {
        return (error as Error).message;
    }
}

const templates = new Map<string, Template | null>();
function compiled(source: string): Template | null {
    if (!templates.has(source)) {
        // Validation belongs to config loading. Malformed data from an older host
        // must never interrupt a historian run.
        try {
            templates.set(source, parseTemplate(source));
        } catch {
            templates.set(source, null);
        }
    }
    return templates.get(source) ?? null;
}

function oneLine(value: string): string {
    return value.replace(/[\r\n\u2028\u2029]+/g, " ");
}
function truncate(value: string, cap: number): string {
    const chars = Array.from(oneLine(value));
    return chars.length > cap ? `${chars.slice(0, cap).join("")}…` : chars.join("");
}
function scalar(value: unknown): string {
    if (value === undefined) return "";
    return typeof value === "string" ? value : compactJson(value);
}
// Sort object keys so the two engines do not depend on their JSON map insertion order.
function compactJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((v) => compactJson(v)).join(",")}]`;
    if (value !== null && typeof value === "object")
        return `{${Object.keys(value)
            .sort()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${compactJson((value as Record<string, unknown>)[key])}`,
            )
            .join(",")}}`;
    return JSON.stringify(value) ?? "null";
}
function field(value: unknown, key: string): unknown {
    return value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.hasOwn(value, key)
        ? (value as Record<string, unknown>)[key]
        : undefined;
}
function render(nodes: Template, root: unknown): string {
    return nodes
        .map((node) => {
            if (typeof node === "string") return node;
            let value = root;
            let list = false;
            for (const step of node.steps) {
                if ("field" in step)
                    value =
                        list && Array.isArray(value)
                            ? value.map((item) => field(item, step.field))
                            : field(value, step.field);
                else if ("index" in step)
                    value = Array.isArray(value) ? value[step.index] : undefined;
                else {
                    value = Array.isArray(value)
                        ? value.map((item) => field(item, step.project))
                        : undefined;
                    list = true;
                }
            }
            if (node.count)
                return truncate(Array.isArray(value) ? String(value.length) : "", node.cap);
            if (node.each || list || node.join !== undefined) {
                if (!Array.isArray(value)) return "";
                const elements = value
                    .slice(0, 10)
                    .map((item) =>
                        truncate(node.each ? render(node.each, item) : scalar(item), 300),
                    );
                if (value.length > 10) elements.push(`… +${value.length - 10} more`);
                return truncate(elements.join(node.join ?? (node.each ? "; " : ", ")), node.cap);
            }
            return truncate(scalar(value), node.cap);
        })
        .join("");
}

export function renderToolTemplate(
    source: string,
    input: unknown,
    output?: unknown,
): string | null {
    const nodes = compiled(source);
    if (!nodes) return null;
    const text =
        typeof output === "string" ? output : output === undefined ? "" : compactJson(output);
    let structured: unknown = output;
    if (typeof output === "string") {
        try {
            const parsed = JSON.parse(output);
            structured =
                parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
        } catch {
            structured = undefined;
        }
    }
    // The bare output placeholder is the original result text, not reserialized JSON.
    const root = { input, output: structured };
    const bareOutputNodes = nodes.map((node) =>
        typeof node !== "string" &&
        node.steps.length === 1 &&
        "field" in node.steps[0] &&
        node.steps[0].field === "output" &&
        !node.each &&
        !node.count &&
        node.join === undefined
            ? truncate(text ?? "", node.cap)
            : node,
    );
    return truncate(render(bareOutputNodes, root), 1000);
}

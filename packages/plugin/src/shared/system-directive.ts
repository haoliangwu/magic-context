const SYSTEM_DIRECTIVE_PREFIX = "[SYSTEM DIRECTIVE: MAGIC-CONTEXT";

export function isSystemDirective(text: string): boolean {
    return text.trimStart().startsWith(SYSTEM_DIRECTIVE_PREFIX);
}

export function removeSystemReminders(text: string): string {
    return removeNestedBlocks(text, ["system-reminder"]).trim();
}

/** Remove matching tagged regions, including nested regions and regions with no closing tag. */
export function removeNestedBlocks(text: string, names: readonly string[]): string {
    const tags = new RegExp(`<(/?)(${names.join("|")})(?:\\s[^<>]*?)?\\s*(/?)>`, "gi");
    const stack: string[] = [];
    let end = 0;
    let result = "";
    for (const match of text.matchAll(tags)) {
        if (stack.length === 0) result += text.slice(end, match.index);
        const name = match[2].toLowerCase();
        if (match[1]) {
            if (stack[stack.length - 1] === name) stack.pop();
        } else if (!match[3]) stack.push(name);
        end = match.index + match[0].length;
    }
    if (stack.length === 0) result += text.slice(end);
    return result;
}

/** Host date fields, not dates quoted in documents or arbitrary `Date:` lines. */
function replaceHostDates(prompt: string, replace: (date: string) => string): string {
    const fields = /<(plugin-env|environment|env)>[\s\S]*?<\/\1>|Today's date: [^\r\n<]+/g;
    // Keep the original label, indentation and line endings byte-for-byte.
    return prompt.replace(fields, (block) =>
        block.replace(
            /(^[\t ]*(?:Date|Today's date):[\t ]*)([^\r\n<]+)/gm,
            (_line, label: string, date: string) => `${label}${replace(date)}`,
        ),
    );
}

/** Capture each host date field so separate system prompt elements keep their own fixed dates. */
export function systemPromptDates(
    prompt: string,
    sticky?: string,
): {
    live: string | undefined;
    stable: string;
} {
    const values: string[] = [];
    replaceHostDates(prompt, (date) => {
        values.push(date);
        return date;
    });
    const prior: string[] = sticky ? JSON.parse(sticky) : [];
    let index = 0;
    const stable = replaceHostDates(prompt, (date) => prior[index++] ?? date);
    return { live: values.length ? JSON.stringify(values) : undefined, stable };
}

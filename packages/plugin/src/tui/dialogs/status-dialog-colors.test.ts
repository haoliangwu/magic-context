import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every `<text>` in the status dialog must set `fg`.
 *
 * A text element without it takes OpenTUI's default foreground, which is the
 * terminal's default colour — on a light theme that is the same colour as the
 * dialog's background, so the row renders as blank space. That is exactly how
 * the old collapsed summary shipped: its rows carried no `fg` and the dialog
 * looked empty. Nothing else catches it, because a colourless row still lays
 * out, still has the right text, and only disappears on themes the author is
 * not using.
 *
 * The check reads the source rather than a rendered frame because `fg` is set
 * per element in this file; a row that loses it loses it here.
 */
const DIALOG_SOURCE = join(import.meta.dir, "status-dialog.tsx");

/**
 * Opening tags for `element`, terminated by the `>` that is not inside a JSX
 * expression. Tracking brace depth keeps a `>` inside `fg={a > b ? x : y}` from
 * ending the tag early.
 */
export function openingTags(source: string, element: string): string[] {
    const tags: string[] = [];
    const marker = `<${element}`;
    let cursor = source.indexOf(marker);
    while (cursor !== -1) {
        let depth = 0;
        let end = cursor + marker.length;
        while (end < source.length) {
            const character = source[end];
            if (character === "{") depth += 1;
            else if (character === "}") depth -= 1;
            else if (character === ">" && depth === 0) break;
            end += 1;
        }
        tags.push(source.slice(cursor, end + 1));
        cursor = source.indexOf(marker, end);
    }
    return tags;
}

test("every text row in the status dialog sets an explicit foreground colour", () => {
    const source = readFileSync(DIALOG_SOURCE, "utf8");
    const tags = openingTags(source, "text");
    // A file that stopped containing text elements would pass the loop below
    // without checking anything.
    expect(tags.length).toBeGreaterThan(8);
    expect(tags.filter((tag) => !tag.includes("fg="))).toEqual([]);
});

test("the tag scanner does not stop at a > inside a JSX expression", () => {
    const sample = "<text fg={a > b ? c : d}>x</text><text>y</text>";
    expect(openingTags(sample, "text")).toEqual(["<text fg={a > b ? c : d}>", "<text>"]);
});

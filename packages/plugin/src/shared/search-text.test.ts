import { expect, test } from "bun:test";
import { cleanSearchText, keywordRelevance, matchedSearchSnippet } from "./search-text";
import { removeSystemReminders } from "./system-directive";

test("nested reminder contents stay quarantined through the outer closing tag", () => {
    expect(
        removeSystemReminders(
            'before <SYSTEM-REMINDER origin="host">outer <system-reminder>inner</system-reminder> leaked tail</SYSTEM-REMINDER> after',
        ),
    ).toBe("before  after");
    expect(removeSystemReminders("before <system-reminder>unfinished")).toBe("before");
    expect(removeSystemReminders("before </system-reminder> after")).toBe("before  after");
});

test("mismatched notification closes cannot release hidden content", () => {
    expect(cleanSearchText("kept <task>hidden </task_cohort> still hidden</task> kept")).toBe(
        "kept kept",
    );
    expect(cleanSearchText("kept <task id='finished'/> kept")).toBe("kept kept");
});

test("task notification trees and cut legacy XML never become hint text", () => {
    expect(
        cleanSearchText(
            '<task_cohort id="parent"><task id="child">background result</task>status</task_cohort> actual answer',
        ),
    ).toBe("actual answer");
    expect(cleanSearchText('<task id="truncated">background result…')).toBe("");
});

test("keyword confidence measures absolute distinct term coverage, not result rank", () => {
    expect(keywordRelevance("explain historian cache wiring", "cache icons")).toBeCloseTo(0.2);
    expect(
        keywordRelevance("historian cache wiring", "historian cache wiring details"),
    ).toBeCloseTo(0.8);
    expect(keywordRelevance("historian cache wiring", "<task>historian cache wiring</task>")).toBe(
        0,
    );
});

test("matched snippets prefer a dense passage over an irrelevant first line", () => {
    const content = `Header cache. ${"padding ".repeat(150)}Historian cache wiring uses incremental pools. ${"trailing ".repeat(100)}`;
    const snippet = matchedSearchSnippet(content, "historian cache wiring", 80);
    expect(snippet).toContain("Historian cache wiring");
    expect(snippet).not.toContain("Header");
    expect(matchedSearchSnippet(content, "unrelated deployment")).toBe("");
});

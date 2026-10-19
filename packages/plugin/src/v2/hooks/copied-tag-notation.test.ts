/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger, type Tagger } from "../../features/magic-context/tagger";
import { tagMessages } from "../../hooks/magic-context/tag-messages";
import type { Database as DatabaseType } from "../../shared/sqlite";
import { Database } from "../../shared/sqlite";
import { stripCopiedTagNotation } from "./copied-tag-notation";
import { adaptPayload } from "./payload";
import type { SessionContext, V2Message } from "./types";

const SESSION = "ses-copied-tags";

function openTestDb(): DatabaseType {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function draft(messages: V2Message[]): SessionContext {
    return {
        sessionID: SESSION,
        model: { providerID: "openai", id: "mock-model" },
        agent: "build",
        messages: structuredClone(messages),
        system: [],
        tools: {},
        options: {},
    };
}

/** What the host stores for a session whose model copied tags into its replies. */
const stored: V2Message[] = [
    { id: "msg_u1", role: "user", content: [{ type: "text", text: "first question §7§" }] },
    {
        id: "msg_a1",
        role: "assistant",
        content: [
            {
                type: "reasoning",
                text: "thinking about §169§ §169§",
                providerMetadata: { sig: "s1" },
            },
            { type: "text", text: "§12§ §12§ Done" },
        ],
    },
    { id: "msg_u2", role: "user", content: [{ type: "text", text: "second question" }] },
    {
        id: "msg_a2",
        role: "assistant",
        content: [
            { type: "text", text: "see §40827§ here" },
            { type: "tool-call", id: "call_1", name: "read", input: { path: "notes §3§.md" } },
        ],
    },
    {
        role: "tool",
        content: [
            {
                type: "tool-result",
                id: "call_1",
                name: "read",
                result: { type: "text", value: "file says §5§" },
            },
        ],
    },
    { id: "msg_u3", role: "user", content: [{ type: "text", text: "third question" }] },
];

function texts(messages: V2Message[]) {
    return messages.flatMap((message) =>
        message.content
            .filter((part) => part.type === "text" || part.type === "reasoning")
            .map((part) => `${message.role}:${part.type}:${String(part.text)}`),
    );
}

/** One OpenCode 2 context pass reduced to the stages that touch text: adapt, tag, commit. */
function pass(db: DatabaseType, tagger: Tagger, messages: V2Message[]): V2Message[] {
    const context = draft(messages);
    const mapped = adaptPayload(context);
    tagger.initFromDb(SESSION, db);
    tagMessages(SESSION, mapped.messages, tagger, db, {
        normalizeRestoredAssistantText: stripCopiedTagNotation,
    });
    mapped.commit();
    return context.messages;
}

describe("stripCopiedTagNotation", () => {
    it("returns text without a section sign byte for byte, surrounding whitespace included", () => {
        for (const text of [
            "  leading and trailing  \n",
            "\n\n## Heading\n\n- 99 files\n- 2024 roadmap\n\n```ts\nconst x = 1;\n```\n",
            "1. do this now, 2. do that next",
            "",
            "   ",
        ]) {
            expect(stripCopiedTagNotation(text)).toBe(text);
        }
    });

    it("removes copied tags at the start and in the middle, as OpenCode 1 persists them", () => {
        expect(stripCopiedTagNotation("§12§ §12§ Done")).toBe("Done");
        expect(stripCopiedTagNotation("see §40827§ here")).toBe("see  here");
        expect(stripCopiedTagNotation("§169§ §169§ §169§")).toBe("");
    });
});

describe("OpenCode 2 request copy of assistant text with copied tags", () => {
    it("strips assistant text only, leaving user text, reasoning and tool parts as stored", () => {
        const context = draft(stored);
        adaptPayload(context).commit();
        expect(texts(context.messages)).toEqual([
            "user:text:first question §7§",
            "assistant:reasoning:thinking about §169§ §169§",
            "assistant:text:Done",
            "user:text:second question",
            "assistant:text:see  here",
            "user:text:third question",
        ]);
        const parts = context.messages.flatMap((message) => message.content);
        expect(parts.find((part) => part.type === "tool-call")?.input).toEqual({
            path: "notes §3§.md",
        });
        expect(parts.find((part) => part.type === "tool-result")?.result).toEqual({
            type: "text",
            value: "file says §5§",
        });
    });

    it("never edits the host's own draft objects", () => {
        const context = draft(stored);
        const hostText = context.messages[1].content[1];
        adaptPayload(context);
        expect(hostText.text).toBe("§12§ §12§ Done");
    });

    it("tags the stripped text and serves the same bytes on every later pass", () => {
        const db = openTestDb();
        const tagger = createTagger();
        const first = pass(db, tagger, stored);
        expect(texts(first)).toContain("assistant:text:§2§ Done");
        expect(texts(first)).toContain("assistant:text:§4§ see  here");
        const second = pass(db, tagger, stored);
        const third = pass(db, tagger, stored);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        expect(JSON.stringify(third)).toBe(JSON.stringify(first));
    });

    it("strips a source copy saved before the strip existed, then replays it unchanged", () => {
        const db = openTestDb();
        const tagger = createTagger();
        // Before this change the adapter left assistant text as stored, so tagging
        // saved the source with only the leading copies removed.
        const before = draft(stored);
        const beforeMapped = adaptPayload(before);
        for (const message of beforeMapped.messages)
            for (const part of message.parts as Array<{ type: string; text?: string }>) {
                const raw = stored
                    .find((row) => row.id === message.info.id)
                    ?.content.find((content) => content.type === "text")?.text;
                if (part.type === "text" && message.info.role === "assistant" && raw)
                    part.text = String(raw);
            }
        tagger.initFromDb(SESSION, db);
        tagMessages(SESSION, beforeMapped.messages, tagger, db);
        beforeMapped.commit();
        expect(texts(before.messages)).toContain("assistant:text:§4§ see §40827§ here");

        const upgraded = pass(db, tagger, stored);
        expect(texts(upgraded)).toContain("assistant:text:§2§ Done");
        expect(texts(upgraded)).toContain("assistant:text:§4§ see  here");
        expect(texts(upgraded)).toContain("user:text:§1§ first question §7§");
        const next = pass(db, tagger, stored);
        const third = pass(db, tagger, stored);
        expect(JSON.stringify(next)).toBe(JSON.stringify(upgraded));
        expect(JSON.stringify(third)).toBe(JSON.stringify(upgraded));
    });

    it("leaves sessions without copied tags byte-identical to tagging without the strip", () => {
        const plain: V2Message[] = [
            { id: "msg_u1", role: "user", content: [{ type: "text", text: "question" }] },
            {
                id: "msg_a1",
                role: "assistant",
                content: [
                    { type: "text", text: "\n  Answer with 99 files and trailing space  \n" },
                ],
            },
            { id: "msg_u2", role: "user", content: [{ type: "text", text: "next" }] },
        ];
        const withStrip = pass(openTestDb(), createTagger(), plain);
        const db = openTestDb();
        const tagger = createTagger();
        const context = draft(plain);
        const mapped = adaptPayload(context);
        tagger.initFromDb(SESSION, db);
        tagMessages(SESSION, mapped.messages, tagger, db);
        mapped.commit();
        expect(JSON.stringify(withStrip)).toBe(JSON.stringify(context.messages));
    });
});

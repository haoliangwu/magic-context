/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Message } from "@opencode/ai/schema/messages";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getTailHygieneTags } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import { estimateMessageTokens } from "../../hooks/magic-context/final-wire-token-estimate";
import { type MessageLike, tagMessages } from "../../hooks/magic-context/tag-messages";
import { measureTailHygiene } from "../../hooks/magic-context/tail-hygiene-walk";
import { Database } from "../../shared/sqlite";
import { adaptPayload } from "./payload";
import type { SessionContext, V2Message } from "./types";

// An image a tool returned (OpenCode's `read` on a PNG), run through the real tagging pass.
// OpenCode 2 carries it as a `content` tool result with a `file` entry; OpenCode 1 carries it
// as `state.attachments` beside a text `state.output`. In both, the model must receive the
// image as an image, and every token count must bill it by its pixels, not its base64 length.

// A PNG header for a 100x100 image followed by 30 KB of padding: ceil(100 * 100 / 750) = 14
// image tokens, against roughly 10,000 tokens if the base64 were counted as text.
const PNG = Buffer.concat([
    Buffer.from("89504e470d0a1a0a0000000d4948445200000064000000640806000000", "hex"),
    Buffer.alloc(30_000),
]).toString("base64");
const DATA_URL = `data:image/png;base64,${PNG}`;
const IMAGE_TOKENS = 14;
const SESSION = "ses-tool-image";

function openTestDb() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function toolTag(db: Database) {
    return db
        .prepare(
            "SELECT tag_number, byte_size, token_count FROM tags WHERE session_id = ? AND type = 'tool'",
        )
        .get(SESSION) as { tag_number: number; byte_size: number; token_count: number };
}

function textOnlyTokens(): number {
    const db = openTestDb();
    const message: MessageLike = {
        info: { id: "msg-text", role: "assistant", sessionID: SESSION },
        parts: [
            {
                type: "tool",
                callID: "call-text",
                tool: "read",
                state: { status: "completed", input: {}, output: "Image read successfully" },
            },
        ],
    };
    tagMessages(SESSION, [message], createTagger(), db);
    return toolTag(db).token_count;
}

describe("a tool result carrying an image, through the tagging pass", () => {
    it("OpenCode 2: reaches the host as its own file entry beside the tagged text, billed by pixels", () => {
        const fileEntry = { type: "file", uri: DATA_URL, mime: "image/png", name: "/w/pixel.png" };
        const messages: V2Message[] = [
            {
                id: "msg-read",
                role: "assistant",
                content: [
                    {
                        type: "tool-call",
                        id: "call-read",
                        name: "read",
                        input: { path: "pixel.png" },
                    },
                ],
            },
            {
                role: "tool",
                content: [
                    {
                        type: "tool-result",
                        id: "call-read",
                        name: "read",
                        result: {
                            type: "content",
                            value: [{ type: "text", text: "Image read successfully" }, fileEntry],
                        },
                    },
                ],
            },
        ];
        const draft: SessionContext = {
            sessionID: SESSION,
            model: { providerID: "provider", id: "model" },
            agent: "build",
            messages,
            system: [],
            tools: {},
            options: {},
        };
        const db = openTestDb();
        const payload = adaptPayload(draft);
        tagMessages(SESSION, payload.messages, createTagger(), db);
        const tag = toolTag(db);

        // The size and token accounting for the tag: text plus a pixel-based image cost.
        expect(tag.byte_size).toBe(Buffer.byteLength("Image read successfully"));
        expect(tag.token_count).toBe(textOnlyTokens() + IMAGE_TOKENS);
        const hygiene = (messages: MessageLike[]) =>
            measureTailHygiene({
                messages,
                tags: getTailHygieneTags(db, SESSION),
                protectedTagNumbers: new Set(),
            }).t;
        const withoutImage = structuredClone(payload.messages);
        (withoutImage[0]!.parts[0] as { state: { attachments: unknown[] } }).state.attachments = [];
        expect(hygiene(payload.messages) - hygiene(withoutImage)).toBe(IMAGE_TOKENS);
        expect(estimateMessageTokens(payload.messages[0]!).toolCall).toBeLessThan(200);

        payload.commit();
        const result = draft.messages
            .flatMap((message) => message.content)
            .find((part) => part.type === "tool-result");
        expect(result?.result).toEqual({
            type: "content",
            value: [
                { type: "text", text: `§${tag.tag_number}§ Image read successfully` },
                fileEntry,
            ],
        });
        expect((result?.result as { value: unknown[] }).value[1]).toBe(fileEntry);
        for (const message of draft.messages) expect(() => Message.make(message)).not.toThrow();
    });

    it("OpenCode 1: tags the text output, leaves the attachment untouched, and bills it by pixels", () => {
        const attachment = {
            type: "file",
            mime: "image/png",
            url: DATA_URL,
            filename: "pixel.png",
        };
        const message: MessageLike = {
            info: { id: "msg-read", role: "assistant", sessionID: SESSION },
            parts: [
                {
                    type: "tool",
                    callID: "call-read",
                    tool: "read",
                    state: {
                        status: "completed",
                        input: { filePath: "pixel.png" },
                        output: "Image read successfully",
                        attachments: [attachment],
                    },
                },
            ],
        };
        const db = openTestDb();
        tagMessages(SESSION, [message], createTagger(), db);
        const tag = toolTag(db);
        const state = (message.parts[0] as { state: { output: string; attachments: unknown[] } })
            .state;

        expect(state.output).toBe(`§${tag.tag_number}§ Image read successfully`);
        expect(state.attachments).toEqual([attachment]);
        expect(state.attachments[0]).toBe(attachment);
        expect(tag.token_count).toBe(textOnlyTokens() + IMAGE_TOKENS);
    });
});

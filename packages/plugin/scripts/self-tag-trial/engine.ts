import { readFileSync } from 'node:fs';

import { buildMagicContextSection } from "../../src/agents/magic-context-prompt";
import { closeDatabase, openDatabase, queuePendingOp } from "../../src/features/magic-context/storage";
import { createTagger } from "../../src/features/magic-context/tagger";
import type { MessageLike } from "../../src/hooks/magic-context/tag-messages";
import { tagMessages } from "../../src/hooks/magic-context/tag-messages";
import { createTransform } from "../../src/hooks/magic-context/transform";
import { applyPendingOperations } from "../../src/hooks/magic-context/apply-operations";
import { stripPersistedAssistantText } from "../../src/hooks/magic-context/tag-content-primitives";
import { instructionB, instructionC } from "./bootstrap";

function requiredDatabase() {
    const db = openDatabase();
    if (!db) throw new Error("Trial database unavailable");
    return db;
}

export type Variant = "A" | "B" | "C" | "D";
export type Call = { id: string; name: string; input: Record<string, unknown> };
export type Reply = { texts: string[]; calls: Call[]; reasoning?: string; usage?: Record<string, number> };
export type Row = {
    model: string; variant: Variant; session: string; position: number; part: number;
    raw: string; rawFirst60: string; assignedTag: number | null; wellFormed: boolean;
    correct: boolean; delta: number | null; malformed: boolean; misplaced: boolean;
    byteIdentity: boolean; retagged: string; usage?: Record<string, number>;
};
export const tools = ["read", "echo", "list", "ctx_reduce"];
export function guidance(variant: Variant): string {
    return buildMagicContextSection(null, 0, true) + (variant === "B" ? `\n\n${instructionB}` : variant === "C" || variant === "D" ? `\n\n${instructionC}` : "");
}
export function fakeTool(call: Call): string {
    switch (call.name) {
        case "read": return "fixture.txt: " + readFileSync(new URL("./fixtures/fixture.txt", import.meta.url), "utf8");
        case "echo": return `${String(call.input.text ?? "fixture echo")}\n`;
        case "list": return "fixture.txt\nREADME.md\n";
        case "ctx_reduce": return "Queued for reduction.";
        default: throw new Error(`Unknown fake tool ${call.name}`);
    }
}

export class Trial {
    readonly db = requiredDatabase();
    readonly tagger = createTagger();
    readonly history: MessageLike[] = [];
    readonly rows: Row[] = [];
    private serial = 0;
    private position = 0;
    private transform;
    constructor(readonly session: string, readonly variant: Variant, readonly model: string) {
        this.transform = createTransform({
            db: this.db, tagger: this.tagger, scheduler: { shouldExecute: () => "defer" },
            contextUsageMap: new Map(), historyRefreshSessions: new Set(),
            pendingMaterializationSessions: new Set(), lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 1000, protectedTokens: 0, historianRunnable: false,
            injectDocs: false, memoryConfig: { enabled: false, injectionBudgetTokens: 0, autoPromote: false },
        });
    }
    message(role: string, parts: MessageLike["parts"]): MessageLike {
        return { info: { id: `${this.session}-${++this.serial}`, sessionID: this.session, role }, parts };
    }
    user(text: string): void { this.history.push(this.message("user", [{ type: "text", text }])); }
    async pass(): Promise<MessageLike[]> {
        const messages = structuredClone(this.history);
        await this.transform({}, { messages });
        const tagged = tagMessages(this.session, messages, this.tagger, this.db);
        const recent = [...this.tagger.getAssignments(this.session).values()].sort((a, b) => b - a).slice(0, 5);
        applyPendingOperations(this.session, this.db, tagged.targets, new Set(recent));
        tagged.batch.finalize();
        return messages;
    }
    async accept(reply: Reply): Promise<Row[]> {
        this.position++;
        const parts: MessageLike["parts"] = [];
        if (reply.reasoning) parts.push({ type: "reasoning", text: reply.reasoning });
        const indices: number[] = [];
        for (const raw of reply.texts) {
            indices.push(parts.length);
            parts.push({ type: "text", text: stripPersistedAssistantText(raw) });
        }
        for (const call of reply.calls) {
            if (call.name === "ctx_reduce") {
                const drop = String(call.input.drop ?? "");
                for (const range of drop.split(",")) {
                    const [a, b = a] = range.split("-").map(Number);
                    if (!Number.isInteger(a) || !Number.isInteger(b) || b - a > 1000) throw new Error("Invalid reduction range");
                    for (let n = a; n <= b; n++) queuePendingOp(this.db, this.session, n, "drop");
                }
            }
            parts.push({ type: "tool", callID: call.id, tool: call.name,
                state: { status: "completed", input: call.input, output: fakeTool(call) } });
        }
        const message = this.message("assistant", parts);
        this.history.push(message);
        const wire = await this.pass();
        const replay = wire.find(m => m.info.id === message.info.id);
        if (!replay) throw new Error("Reply missing on next pass");
        const rows = reply.texts.map((raw, i): Row => {
            const part = replay.parts[indices[i]] as { text: string };
            const assignedTag = this.tagger.getTag(this.session, `${message.info.id}:p${indices[i]}`, "message") ?? null;
            const prefix = /^§(\d+)§ /.exec(raw);
            const remainder = prefix ? raw.slice(prefix[0].length) : raw;
            const malformed = /§/.test(remainder.replace(/§\d+§/g, "")) || (!prefix && /^\s*§/.test(raw));
            return { model: this.model, variant: this.variant, session: this.session, position: this.position,
                part: i, raw, rawFirst60: raw.slice(0, 60), assignedTag, wellFormed: !!prefix,
                correct: !!prefix && Number(prefix[1]) === assignedTag,
                delta: prefix && assignedTag !== null ? Number(prefix[1]) - assignedTag : null,
                malformed, misplaced: /§\d+§/.test(remainder) || reply.calls.some(c => /§/.test(JSON.stringify(c.input))),
                byteIdentity: part.text === raw, retagged: part.text, usage: reply.usage };
        });
        if (!reply.texts.length) rows.push({ model: this.model, variant: this.variant, session: this.session,
            position: this.position, part: -1, raw: "", rawFirst60: "", assignedTag: null,
            wellFormed: false, correct: false, delta: null, malformed: false,
            misplaced: reply.calls.some(c => /§/.test(JSON.stringify(c.input))), byteIdentity: true, retagged: "", usage: reply.usage });
        this.rows.push(...rows);
        return rows;
    }
    close(): void { closeDatabase(); }
}

// Test allocation for newly observed parts without injecting memory or history messages.
export function probe(parts: MessageLike["parts"], results: MessageLike["parts"] = []): { messages: MessageLike[]; assignments: [string, number][] } {
    const db = requiredDatabase();
    const session = crypto.randomUUID();
    const tagger = createTagger();
    const messages: MessageLike[] = [
        { info: { id: "user", role: "user" }, parts: [{ type: "text", text: "prompt" }] },
        { info: { id: "assistant", role: "assistant" }, parts },
    ];
    if (results.length) messages.push({ info: { id: "result", role: "tool" }, parts: results });
    tagMessages(session, messages, tagger, db).batch.finalize();
    return { messages, assignments: [...tagger.getAssignments(session)] };
}

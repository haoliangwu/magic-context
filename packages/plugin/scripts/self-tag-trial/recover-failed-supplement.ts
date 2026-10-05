import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { measure, type Event } from "./measure";

// Recover replies already captured by the OpenCode process in its temporary
// trial directory after a scenario assertion fails. No provider is called.
const prefix = process.argv[2] ?? "docs/reports/issue-582-self-tag-supplement-failed";
const summary = JSON.parse(readFileSync(`${prefix}-summary.json`, "utf8"));
if (!realpathSync(summary.root).startsWith(realpathSync(join(tmpdir(), "magic-context", "self-tag-trial")) + "/")) throw new Error("Recovery root escaped trial directory");
const allEvents: Event[] = readFileSync(join(summary.root, "capture.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const rows: unknown[] = [];
const db = new Database(join(summary.root, "data", "cortexkit", "magic-context", "context.db"), { readonly: true });
try {
    for (const session of summary.sessions) {
        let turn = 0;
        const events = allEvents.filter(event => event.input?.sessionID === session.session || event.messages?.some((message: any) => message.info.sessionID === session.session) || event.kind === "flush" && event.session === session.session)
            .map(event => {
                if (event.kind === "wire") turn = event.messages.filter((message: any) => message.info.role === "user" && message.info.id && !message.parts.some((part: any) => part.text?.includes("__SELF_TAG_FLUSH_ONLY__"))).length;
                return { ...event, userTurn: turn };
            });
        const measured = measure(events, session.session, session.variant, session.scenario, (messageID, partIndex) => {
            const tag = db.query("SELECT tag_number FROM tags WHERE session_id = ? AND message_id = ?").get(session.session, `${messageID}:p${partIndex}`) as { tag_number: number } | null;
            return tag?.tag_number ?? null;
        });
        for (const row of measured) {
            const provider = summary.calls[session.providerCallStart + row.position - 1];
            Object.assign(row, { model: provider.responseModel, requestedModel: provider.model, responseModel: provider.responseModel, providerCallIndex: provider.index, usage: provider.usage });
        }
        rows.push(...measured);
    }
} finally { db.close(); }
writeFileSync(`${prefix}.jsonl`, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
console.log(`Recovered ${rows.length} raw reply rows; no new model calls.`);

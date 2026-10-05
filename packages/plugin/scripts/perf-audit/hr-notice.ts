/** Run with: timeout 120 bun packages/plugin/scripts/perf-audit/hr-notice.ts */
import { shouldHoldIgnoredNotificationFromOpenCodeDb } from "../../src/hooks/magic-context/read-session-db";
import { Database } from "../../src/shared/sqlite";

console.log(`Bun ${Bun.version}`);
for (const count of [1000, 10_000, 60_000]) {
    const db = new Database(":memory:");
    try {
        db.exec(`CREATE TABLE message(id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
            CREATE INDEX message_session_time_idx ON message(session_id, time_created);
            CREATE TABLE part(message_id TEXT, session_id TEXT, data TEXT);`);
        const insert = db.prepare("INSERT INTO message VALUES (?, 's', ?, ?)");
        db.transaction(() => {
            for (let i = 0; i < count; i++) insert.run(`m-${i}`, i, JSON.stringify({ role: i % 2 ? "assistant" : "user", finish: "stop" }));
        })();
        let assistants = 0;
        let users = 0;
        const prepare = db.prepare.bind(db);
        db.prepare = ((sql: string) => {
            const statement = prepare(sql);
            return new Proxy(statement, { get(target, property) {
                const value = Reflect.get(target, property);
                if (property === "get") return (...args: unknown[]) => {
                    if (sql.includes("time_created as timeCreated")) assistants++;
                    if (sql.includes("SELECT 1 as one")) users++;
                    return Reflect.apply(value, target, args);
                };
                return typeof value === "function" ? value.bind(target) : value;
            } });
        }) as typeof db.prepare;
        const times: number[] = [];
        for (let i = 0; i < 5; i++) {
            const start = performance.now();
            if (shouldHoldIgnoredNotificationFromOpenCodeDb(db, "s")) throw new Error("Closed assistant incorrectly holds notices");
            times.push(performance.now() - start);
        }
        console.log(JSON.stringify({ finding: "HR-14", count, medianMs: times.sort((a, b) => a - b)[2], assistantQueriesPerCall: assistants / 5, userQueriesPerCall: users / 5 }));
    } finally { db.close(); }
}

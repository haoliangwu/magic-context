import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import source from "../../../testdata/temporal-session-parity.json";
import { encodeOpenCodeMessagesToCk } from "../src/hooks/magic-context/module-wire";

const sessionId = "temporal-mode-wire";
const raw = source.messages.map((row) => ({
    info: { id: row.id, sessionID: sessionId, role: row.role, time: { created: row.created, completed: row.completed } },
    parts: [{ type: "text", text: row.text }],
}));
raw[0].info.time.completed = 0;
const fixture = {
    request: { kind: "transform", v: 2, serializer_profile: "opencode-aisdk", session_id: sessionId, render_config: "cfg0", tool_present: true, auto_search_enabled: false, messages: encodeOpenCodeMessagesToCk(raw) },
    ts_users: source.served_users,
    rust_users: ["§2§ <!-- +10m -->\nquestion", "§3§ <!-- +10m -->\nfollow up", "§4§ nearby"],
};
writeFileSync(resolve(import.meta.dir, "../../../testdata/temporal-mode-switch.json"), JSON.stringify(fixture, null, 2) + "\n");
console.log(`Captured ${fixture.request.messages.length} CK messages for the mode-switch fixture`);

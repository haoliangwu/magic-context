import { homedir } from "node:os";
import { writeFileSync } from "node:fs";
import { isolate, instructionB, instructionC } from "./bootstrap";
const liveHome = homedir();
const root = isolate();
process.env.TMPDIR = root;
const { OpenCodeCaller } = await import("./host-adapter");
const records: unknown[] = [];
for (const variant of ["A", "B", "C", "D"] as const) {
    process.env.SELF_TAG_HEAD_FIXTURE = "1";
    const caller = await OpenCodeCaller.mock(root, variant, liveHome);
    try {
        await caller.start();
        caller.script([{ text: "§2§ RAW_SENTINEL", usage: { input_tokens: 100, output_tokens: 8 } }]);
        const first = await caller.send("Reply with a short fixture summary.") as any[];
        caller.script([{ text: "Second reply", usage: { input_tokens: 110, output_tokens: 5 } }]);
        const second = await caller.send("What was your previous summary?") as any[];
        const raw = first.find(e => e.kind === "raw")?.text;
        const stripped = first.find(e => e.kind === "stripped")?.text;
        const replay = second.filter(e => e.kind === "wire").flatMap(e => e.messages).flatMap(m => m.parts).find(p => p.text === raw)?.text;
        if (raw !== "§2§ RAW_SENTINEL" || stripped !== "RAW_SENTINEL" || replay !== raw) throw new Error(`Persistence/retag mismatch: ${JSON.stringify({ raw, stripped, replay })}`);
        const systems = first.filter(e => e.kind === "system").flatMap(e => e.system).join("\n");
        if (systems.includes(instructionB) !== (variant === "B")) throw new Error("Guidance variant not applied");
        if (systems.includes(instructionC) !== (variant === "C" || variant === "D")) throw new Error("C guidance variant not applied");
        caller.script([
            { content: [{ type: "text", text: "§6§ Inspecting fixtures." },
                { type: "tool_use", id: "read-1", name: "trial_read", input: {} },
                { type: "tool_use", id: "list-1", name: "trial_list", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 120, output_tokens: 15 } },
            { text: "Seven fruit.", usage: { input_tokens: 150, output_tokens: 5 } },
        ]);
        const mixed = await caller.send("Read and list the fixtures in parallel, then summarize.") as any[];
        if (mixed.filter(e => e.kind === "tool").length !== 2) throw new Error("Parallel fake tools did not run");
        const wireText = JSON.stringify(mixed.filter(e => e.kind === "wire"));
        if (!wireText.includes("apples=3") || !wireText.includes("README.md") || !wireText.includes("§9001§")) throw new Error("Fixture tools or literal head missing");
        const flush = await caller.flush();
        records.push({ variant, raw, stripped, replay, events: [...first, ...second, ...mixed, ...flush], isolation: caller.isolation(), requests: caller.harness.requests().map((r: { body: unknown }) => r.body) });
    } finally { await caller.close(); }
}
const out = process.argv[2] ?? `${root}/host-probe.json`;
writeFileSync(out, JSON.stringify({ root, version: "1.18.30", realModelCalls: 0, records }, null, 2));
const rows = (records as any[]).flatMap(record => record.events.filter((e: any) => e.kind === "raw").map((raw: any, index: number) => {
    const part = record.events.filter((e: any) => e.kind === "wire").flatMap((e: any) => e.messages)
        .filter((m: any) => m.info.id === raw.input.messageID).flatMap((m: any) => m.parts).find((p: any) => p.id === raw.input.partID);
    const assigned = part ? /^§(\d+)§ /.exec(part.text) : null;
    const prefix = /^§(\d+)§ /.exec(raw.text);
    return { model: "mock-provider-not-a-model", variant: record.variant, session: raw.input.sessionID, position: index + 1,
        rawFirst60: raw.text.slice(0, 60), raw: raw.text, assignedTag: assigned ? Number(assigned[1]) : null,
        wellFormed: !!prefix, correct: assigned ? prefix?.[1] === assigned[1] : null,
        delta: assigned && prefix ? Number(prefix[1]) - Number(assigned[1]) : null,
        byteIdentity: part ? part.text === raw.text : null, outcome: part ? "next-pass-observed" : "pending-next-pass" };
}));
writeFileSync(out.replace(/\.json$/, "-rows.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
console.log(`Host mock proof passed for A, B, C and D; root=${root}; real model calls=0`);

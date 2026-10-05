import { existsSync, readFileSync } from "node:fs";
import { instructionB, instructionC } from "./bootstrap";
const base = process.argv[2] ?? "docs/reports/issue-582-self-tag";
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const summaries = ["live-c", "supplement-c", "live-d", "supplement-d", "controls-c"].map(phase => read(`${base}-${phase}-summary.json`));
for (const summary of summaries) {
    if (!summary.completed || !summary.copiedCredentialDeleted) throw new Error("Incomplete trial or remaining auth copy");
    if (existsSync(`${summary.root}/data/opencode/auth.json`)) throw new Error("Auth copy still exists");
    if (summary.isolationBefore.forbidden.length) throw new Error("Live-store violation");
    for (const session of summary.sessions) {
        if (!session.completed || !session.providerHookTextEqual || !session.parallelSeen || session.isolation.forbidden.length) throw new Error("Session did not satisfy host/stream/isolation invariants");
        const calls = summary.calls.slice(session.providerCallStart, session.providerCallEnd);
        if (calls.length !== session.replies) throw new Error("Reply/call count differs");
        for (const call of calls) {
            if (call.model !== "deepseek-flash" || call.responseModel !== "deepseek-flash" || call.status !== 200) throw new Error("Wrong provider identity/status");
            if (call.thinking !== (session.variant === "D" ? "enabled" : "disabled") || call.maxTokens !== (session.variant === "D" ? 4096 : 512)) throw new Error("Wrong generation settings");
            if (session.variant === "D" && call.reasoningTokens === null) throw new Error("Missing reasoning token count");
        }
        const system = session.guidance.join("\n");
        if (system.includes(instructionB) !== (session.variant === "B")) throw new Error("B instruction mismatch");
        if (system.includes(instructionC) !== (["C", "D"].includes(session.variant))) throw new Error("C instruction mismatch");
        if (summary.cohort === "reduction-supplement") {
            if (session.lastCompletedTurn !== 18 || !session.placeholderSeen || !session.providerSawReductionTarget || session.reductionStatus !== "dropped") throw new Error("Supplement lacks 18 turns or independent dropped-history proof");
            if (!calls.some((call: any) => call.servedDroppedTags.includes(session.reductionTarget))) throw new Error("Target never reached outgoing provider tool messages");
        } else if (session.lastCompletedTurn !== 16) throw new Error("Wrong primary turn count");
    }
}
for (const variant of ["C", "D"]) {
    const sessions = summaries.flatMap(s => s.sessions).filter(s => s.variant === variant);
    if (sessions.length !== 7) throw new Error("Expected seven sessions per variant");
    if (sessions.filter(s => s.scenario === "fresh").length !== 2 || sessions.filter(s => s.scenario === "literal-head").length !== 2 || sessions.filter(s => s.scenario === "reduced").length !== 3) throw new Error("Scenario balance differs");
    const rows = readFileSync(`${base}-all-${variant.toLowerCase()}.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
    if (rows.some(r => r.byteIdentity === null)) throw new Error("Unobserved next pass counted");
    const texts = rows.filter(r => !r.toolOnly);
    if (texts.some(r => r.byteIdentity !== (r.raw === r.retagged))) throw new Error("Byte identity calculation differs from raw replay");
    const aggregate = read(`${base}-aggregate-${variant.toLowerCase()}.json`);
    if (aggregate.pooled[0].identical !== texts.filter(r => r.raw === r.retagged).length) throw new Error("Aggregate denominator mismatch");
    if (aggregate.firstMixed.length !== 7 || aggregate.firstMixed.some((r: any) => r.position === null)) throw new Error("Missing first mixed reply");
}
console.log("Follow-up session balance, generation settings, independent replay, guidance, reasoning usage, dropped-history and isolation checks passed");

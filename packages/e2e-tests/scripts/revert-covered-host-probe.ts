// Run with bun from the repository root. All host data is allocated by the e2e harnesses.
import { execFileSync } from "node:child_process";
import { Database } from "bun:sqlite";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PiTestHarness } from "../src/pi-harness";
import { TestHarness } from "../src/harness";
import { OpenCode2TestHarness } from "../src/opencode2-harness";
import { RustTestHarness } from "../src/rust-harness";
import { buildMockHistorianPayload, historianRangeInRequest } from "../src/mock-historian";

type Harness = PiTestHarness | TestHarness | OpenCode2TestHarness | RustTestHarness;
const kind = process.argv[2];
if (!["pi-fork", "pi-tree", "pi-edit", "opencode", "opencode2", "opencode-rust"].includes(kind)) throw new Error("Expected pi-fork, opencode or opencode2");
const root = process.env.MC_REVERT_PROBE_ROOT;
if (!root || root !== process.env.TMPDIR || !root.includes("/magic-context/")) {
  throw new Error("Set TMPDIR and MC_REVERT_PROBE_ROOT to the same throwaway magic-context task root");
}
const usage = { input_tokens: 90_000, output_tokens: 20, cache_creation_input_tokens: 90_000, cache_read_input_tokens: 0 };
const config = { execute_threshold_percentage: 40, dreamer: { disable: true }, compressor: { enabled: false }, memory: { auto_promote: false, auto_search: { enabled: false } } };
const isHistorian = (body: Record<string, unknown>) => JSON.stringify(body.system ?? "").includes("the hippocampus of a long-running coding agent");
const rows = (h: Harness, id: string) => {
  const db = h instanceof RustTestHarness ? new Database(join(h.env.dataDir, "cortexkit", "magic-context", "store.db"), { readonly: true }) : h.contextDb();
  try {
    return db.prepare(`SELECT sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1 FROM ${h instanceof RustTestHarness ? "mc_compartments" : "compartments"} WHERE session_id = ? ORDER BY sequence`).all(id);
  } finally { if (h instanceof RustTestHarness) db.close(); }
};
const output: Record<string, unknown> = { kind, snapshots: [] };
let h: Harness | undefined;
try {
  h = kind.startsWith("pi-") ? await PiTestHarness.create({ modelContextLimit: 100_000, magicContextConfig: config, extensionsBeforeMagicContext: [join(import.meta.dir, "pi-covered-tree-extension.mjs")] })
    : kind === "opencode-rust" ? await RustTestHarness.create({ modelContextLimit: 100_000, magicContextConfig: config, historianRunner: "host" })
    : kind === "opencode" ? await TestHarness.create({ modelContextLimit: 100_000, magicContextConfig: config })
    : await OpenCode2TestHarness.create({ modelContextLimit: 100_000, magicContextConfig: config });
  const pid = h instanceof PiTestHarness ? (h as unknown as { rpc: { pid?: number } }).rpc.pid
    : h.opencode.pid;
  if (!pid) throw new Error("Host pid unavailable: cannot prove isolation by lsof");
  const opened = execFileSync("lsof", ["-Fn", "-p", String(pid)], { encoding: "utf8" });
  const liveRoots = [".local/share/opencode", ".local/share/cortexkit/magic-context", ".config/opencode", ".config/cortexkit", ".pi/agent"].map(path => join(homedir(), path));
  const forbidden = opened.split("\n").filter(line => line.startsWith("n/") && liveRoots.some(path => line.slice(1).startsWith(`${path}/`)));
  if (forbidden.length) throw new Error(`Live-store open paths: ${forbidden.join(", ")}`);
  const hostRoot = h instanceof PiTestHarness ? h.env.baseDir : h instanceof OpenCode2TestHarness ? h.opencode.root : h.opencode.env.dataDir;
  if (!realpathSync(hostRoot).startsWith(`${realpathSync(root)}/`)) throw new Error(`Host store escaped task root: ${hostRoot}`);
  output.isolation = { pid, root: hostRoot, openPaths: opened.split("\n").filter(x => /^n\//.test(x) && /(?:\.db|\.jsonc)$/.test(x)), forbidden };
  h.mock.setDefault({ text: "mock assistant", usage });
  let historianCalls = 0;
  h.mock.addMatcher((body) => {
    if (!isHistorian(body)) return null;
    const range = historianRangeInRequest(body);
    historianCalls++;
    if (!range) throw new Error(`Historian request ${historianCalls} lacks ordinal range`);
    const prompt = JSON.stringify(body.messages ?? body.input ?? "");
    const chunk = prompt.match(/<new_messages>([\s\S]*?)<\/new_messages>/)?.[1] ?? "";
    const markers = [...new Set(chunk.match(/(?:OLD|NEW)-\d{2}/g) ?? [])].join(" ");
    return { text: buildMockHistorianPayload({ ...range, title: `probe-${historianCalls}`, body: `Historian pass ${historianCalls}; markers ${markers || "none"}` }), usage: { input_tokens: 500, output_tokens: 200, cache_creation_input_tokens: 500 } };
  });
  let session = await h.createSession();
  output.session = session;
  async function turn(marker: string) {
    if (!h) throw new Error("Disposed");
    await h.sendPrompt(session, `${kind === "pi-edit" && marker === "NEW-01" ? "EDITED-OLD-02 " : ""}${marker} distinct branch content ${h.ballast(2400)}`, { timeoutMs: 120_000 });
    if (h instanceof RustTestHarness) await Bun.sleep(500);
    else await h.waitForMockQuiescence({ label: marker });
    const requests = h.requests();
    const latest = [...requests].reverse().find(r => !isHistorian(r.body));
    (output.snapshots as unknown[]).push({ marker, historianCalls, rows: rows(h, session), wire: latest?.body, allRequests: requests.slice(-4).map(r => ({ historian: isHistorian(r.body), body: r.body })) });
    writeFileSync(join(root!, `${kind}.json`), JSON.stringify(output, null, 2));
    console.log(JSON.stringify({ marker, compartments: rows(h, session).length, historianCalls, requests: requests.length }));
  }
  for (let i = 1; i <= 15 && rows(h, session).length < 3; i++) await turn(`OLD-${String(i).padStart(2, "0")}`);
  if (rows(h, session).length < 3) throw new Error("Three compartments did not publish after 15 turns");
  const second = rows(h, session)[1] as { start_message_id: string; end_message_id: string };
  if (kind.startsWith("pi-")) {
    const pi = h as PiTestHarness;
    const rpc = (pi as unknown as { rpc: { sendCommand: (method: string, args?: Record<string, unknown>) => Promise<{ success: boolean; data?: unknown; error?: string }> } }).rpc;
    const tree = await rpc.sendCommand("get_tree");
    output.treeBefore = tree;
    const entryId = second.start_message_id;
    if (kind === "pi-fork") {
      output.navigation = await rpc.sendCommand("fork", { entryId });
      if (!(output.navigation as { success: boolean }).success) throw new Error(`Pi fork failed: ${JSON.stringify(output.navigation)}`);
      output.originRowsAfterFork = rows(h, session);
      session = (await pi.getState()).sessionId!;
      output.forkSession = session;
      output.forkRowsAtStart = rows(h, session);
    } else {
      await pi.invokeExtensionCommand(`e2e-covered-tree ${entryId}`);
      output.navigation = { command: "navigateTree", entryId, state: await pi.getState() };
      output.treeRowsAfterNavigation = rows(h, session);
    }
  } else if (kind === "opencode" || kind === "opencode-rust") {
    const oc = h as TestHarness | RustTestHarness;
    const response = await fetch(`${oc.opencode.url}/session/${session}/revert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageID: second.start_message_id }) });
    output.navigation = { status: response.status, body: await response.text() };
    if (!response.ok) throw new Error(`Revert failed: ${response.status}`);
  } else {
    const oc = h as OpenCode2TestHarness;
    const client = (oc as unknown as { clientInstance: { session: { revert: { stage: (arg: { sessionID: string; messageID: string }) => Promise<unknown>; commit: (arg: { sessionID: string }) => Promise<void> } } } }).clientInstance;
    const stage = await client.session.revert.stage({ sessionID: session, messageID: second.start_message_id });
    await client.session.revert.commit({ sessionID: session });
    output.navigation = { stage, committed: true };
  }
  await Bun.sleep(1000);
  for (let i = 1; i <= 8; i++) await turn(`NEW-${String(i).padStart(2, "0")}`);
  output.completed = true;
} catch (error) {
  output.error = error instanceof Error ? error.stack : String(error);
  if (h instanceof RustTestHarness) output.rustDiagnostics = h.diagnosticLog().slice(-20000);
  console.error(output.error);
  process.exitCode = 1;
} finally {
  if (root) writeFileSync(join(root!, `${kind}.json`), JSON.stringify(output, null, 2));
  await h?.dispose();
}

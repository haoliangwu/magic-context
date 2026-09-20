import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { LIGHT_TOOL_DESCRIPTIONS } from "../../../plugin/src/shared/prompt-surface-runtime";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

const sha = (value: unknown) =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("v2 ctx_* descriptions are model-keyed and identical across three defer passes", async () => {
	const root = mkdtempSync(join(tmpdir(), "mc-s6-surface-"));
	const plugin = join(root, "observer");
	mkdirSync(plugin);
	const trace = join(root, "trace.jsonl");
	writeFileSync(trace, "");
	writeFileSync(
		join(plugin, "index.js"),
		`import { appendFileSync } from "node:fs";
export default { id: "s6-surface", async setup(context) {
  await context.tool.transform((editor) => {
    for (const name of ["ctx_reduce","ctx_expand","ctx_note","ctx_memory","ctx_search"]) {
      editor.add({
        name,
        description: "full-" + name,
        input: { type: "object", properties: {} },
        async execute() { return { content: "ok" }; },
      });
    }
  });
  await context.session.hook("context", async (draft) => {
    const fromDraft = Object.fromEntries(Object.entries(draft.tools ?? {}).filter(([name]) => name.startsWith("ctx_")));
    const fromEditor = {};
    if (context.tool?.transform) await context.tool.transform((editor) => {
      for (const tool of editor.list?.() ?? []) {
        const id = tool.id ?? tool.name;
        if (String(id).startsWith("ctx_")) fromEditor[id] = { description: tool.description };
      }
    });
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify({
      model: draft.model,
      tools: Object.keys(fromDraft).length ? fromDraft : fromEditor,
    }) + "\\n");
  });
}};`,
	);
	const host = await spawnOpencode2({
		probePlugin: plugin,
		additionalModelIDs: ["mock-light"],
	});
	try {
		const configDir = join(host.env.XDG_CONFIG_HOME!, "cortexkit");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(
			join(configDir, "magic-context.jsonc"),
			JSON.stringify({
				auto_update: false,
				memory: { enabled: false },
				historian: { disable: true },
				dreamer: { disable: true },
				prompt_surface: {
					default: "full",
					models: { "openai/mock-light": "light" },
				},
			}),
		);
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);
		host.mock.setDefault({
			text: "surface reply",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		const turn = async (text: string) => {
			await client.session.prompt({ sessionID: session.id, text });
			await client.session.wait(
				{ sessionID: session.id },
				{ signal: AbortSignal.timeout(20_000) },
			);
		};
		await turn("pass-1");
		await turn("pass-2");
		await turn("pass-3");
		const frames = readFileSync(trace, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { model: { id: string }; tools: Record<string, { description: string; input: unknown }> });
		const sameModel = frames.filter((frame) => frame.model.id === "mock-model");
		expect(sameModel.length).toBeGreaterThanOrEqual(3);
		const hashes = sameModel.slice(0, 3).map((frame) => sha(frame.tools));
		expect(new Set(hashes).size).toBe(1);
		await client.session.switchModel({
			sessionID: session.id,
			model: { providerID: "openai", id: "mock-light" },
		});
		await turn("pass-light");
		const light = readFileSync(trace, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { model: { id: string }; tools: Record<string, { description: string }> })
			.findLast((frame) => frame.model.id === "mock-light");
		expect(light?.tools.ctx_search?.description).toBe(LIGHT_TOOL_DESCRIPTIONS.ctx_search);
	} finally {
		await host.stop();
	}
}, 60_000);

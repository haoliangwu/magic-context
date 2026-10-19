#!/usr/bin/env bun
// Reproduce delayed lifecycle notifications during provider retries on exact
// Oh My Pi 18.9.2/18.10.3 npm versions, with a mock provider and throwaway stores.
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	piMatchesPreparedStructure,
	piPreparedStructure,
} from "../packages/pi-plugin/src/pi-dispatch-structure";

const root = realpathSync(process.env.MC673_RUN_ROOT!);
if (!root.includes("/magic-context/issue-673/"))
	throw new Error("throwaway issue-673 root required");
const isolated = {
	HOME: root,
	CFFIXED_USER_HOME: root,
	TMPDIR: root,
	XDG_CONFIG_HOME: join(root, "config"),
	XDG_DATA_HOME: join(root, "data"),
	XDG_CACHE_HOME: join(root, "cache"),
	XDG_STATE_HOME: join(root, "state"),
	XDG_RUNTIME_DIR: join(root, "runtime"),
	PI_CODING_AGENT_DIR: join(root, ".omp/agent"),
	MAGIC_CONTEXT_STORAGE_DIR: join(root, "data/cortexkit/magic-context"),
	OPENCODE_DB: join(root, "data/opencode/opencode.db"),
};
for (const [key, value] of Object.entries(isolated)) {
	if (process.env[key] !== value)
		throw new Error(`${key} must be isolated before host startup`);
	if (key !== "OPENCODE_DB") mkdirSync(value, { recursive: true });
}
const install = process.env.MC673_HOST!;
const host = join(install, "node_modules/@oh-my-pi/pi-coding-agent");
const version = JSON.parse(
	readFileSync(join(host, "package.json"), "utf8"),
).version;
const expectedVersion = process.env.MC673_VERSION ?? "18.9.2";
if (
	!["18.9.2", "18.10.3"].includes(expectedVersion) ||
	version !== expectedVersion
)
	throw new Error(`expected pinned OMP ${expectedVersion}, got ${version}`);
const mode = process.argv[2] ?? "late-retry";
if (
	![
		"normal",
		"late-retry",
		"goal-late-retry",
		"goal-raw-retry",
		"goal-cache-retry",
		"transform-proof",
		"transform-stale-first",
	].includes(mode)
)
	throw new Error("unknown mode");
const goalMode = mode.startsWith("goal-");
const rawRetry = mode === "goal-raw-retry";
const cacheRetry = mode === "goal-cache-retry";
const staleFirst = mode === "transform-stale-first";
const transformProof = mode === "transform-proof" || staleFirst;
if (goalMode && version !== "18.10.3")
	throw new Error("goal probe requires OMP 18.10.3");
const audit = (value: unknown) =>
	appendFileSync(
		join(root, "audit.jsonl"),
		JSON.stringify({ at: Date.now(), ...(value as object) }) + "\n",
	);
const isolation = (label: string) => {
	const text = execFileSync("/usr/sbin/lsof", ["-p", String(process.pid)], {
		encoding: "utf8",
	});
	writeFileSync(join(root, `lsof-${label}.txt`), text);
	const stores = text
		.split("\n")
		.filter((line) =>
			/(?:\.db(?:[- ]|$)|\/\.omp\/|\/\.pi\/|\/\.config\/)/.test(line),
		);
	if (stores.some((line) => !line.includes(root)))
		throw new Error("live store descriptor found");
	audit({ phase: "isolation", label, pid: process.pid, stores });
};
const { MockProvider } = await import(
	"../packages/e2e-tests/src/mock-provider/server"
);
const mock = new MockProvider();
const { baseURL } = await mock.start();
mock.setDefault({
	text: "mock reply",
	usage: { input_tokens: 1000, output_tokens: 10 },
});
let rejected = false;
let wireCount = 0;
mock.addMatcher((body) => {
	audit({ phase: "wire", body });
	wireCount++;
	if (goalMode && wireCount === 1)
		return {
			content: [
				{
					type: "tool_use",
					id: "goal-progress",
					name: "_bash",
					input: { command: "printf 'progress674\\n'", timeout: 5 },
				},
			],
			stop_reason: "tool_use",
			usage: { input_tokens: 1000, output_tokens: 10 },
		};
	if (
		(mode === "late-retry" || goalMode) &&
		!rejected &&
		(goalMode ? wireCount === 3 : JSON.stringify(body).includes("SECOND673"))
	) {
		rejected = true;
		(globalThis as any).__mc673ReleaseEnd();
		return {
			error: {
				status: 400,
				type: "invalid_request_error",
				message: cacheRetry
					? "cache_control is not supported"
					: "structured_outputs not supported",
			},
		};
	}
	if (goalMode && wireCount === 4)
		void session.goalRuntime.completeGoalFromTool();
	return null;
});
writeFileSync(
	join(isolated.PI_CODING_AGENT_DIR, "config.yml"),
	JSON.stringify({
		defaultProvider: "mock",
		defaultModel: "mock-model",
		enabledModels: ["mock/mock-model"],
		tools: { xdev: false, intentTracing: false },
		compaction: { enabled: false },
		advisor: { enabled: false },
		autolearn: { enabled: false },
		retry: { enabled: false },
		goal: { enabled: true, continuationModes: ["rpc"] },
		secrets: { enabled: transformProof },
		snapcompact: {
			systemPrompt: transformProof ? "all" : "none",
			toolResults: transformProof,
		},
		quietStartup: true,
		enableInstallTelemetry: false,
	}),
);
writeFileSync(
	join(isolated.PI_CODING_AGENT_DIR, "models.json"),
	JSON.stringify({
		providers: {
			mock: {
				api: "anthropic-messages",
				baseUrl: baseURL,
				apiKey: "test-key-not-real",
				models: [
					{
						id: "mock-model",
						name: "Mock Model",
						input: transformProof ? ["text", "image"] : ["text"],
						contextWindow: 1000000,
						maxTokens: 8192,
						reasoning: false,
						...(transformProof ? { tokenizer: "o200k" } : {}),
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	}),
);
mkdirSync(join(root, "config/cortexkit"), { recursive: true });
writeFileSync(
	join(root, "config/cortexkit/magic-context.jsonc"),
	JSON.stringify({
		enabled: true,
		memory: { enabled: false },
		embedding: { provider: "off" },
		dreamer: { disable: true },
	}),
);
const plugin =
	process.env.MC673_PLUGIN ??
	resolve(import.meta.dir, "../packages/pi-plugin/dist/index.js");
const proofSecret = "FAKE_PROOF_SECRET_673_abcdefghijklmnopqrstuvwxyz";
if (transformProof)
	writeFileSync(
		join(isolated.PI_CODING_AGENT_DIR, "secrets.yml"),
		JSON.stringify([
			{
				type: "plain",
				content: proofSecret,
				mode: "obfuscate",
				friendlyName: "PROOF",
			},
		]),
	);
const probe = join(root, "probe.mjs");
writeFileSync(
	probe,
	`
import { appendFileSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import magic from ${JSON.stringify(plugin)};
const log = value => appendFileSync(${JSON.stringify(join(root, "hooks.jsonl"))}, JSON.stringify({at:Date.now(),...value})+'\\n');
export default async pi => {
  let ends=0, attempts=0, providerPayloads=0, firstPayload, releaseEnd, endDelivered;
  const heldEnd=new Promise(resolve=>{releaseEnd=resolve;});
  const delivered=new Promise(resolve=>{endDelivered=resolve;});
  globalThis.__mc673ReleaseEnd=releaseEnd;
  pi.on('agent_end',async event=>{
    if(++ends===1 && ${JSON.stringify(mode)}!=='normal' && !${transformProof}) {
      log({phase:'held-earlier-end',messages:event.messages});
      await heldEnd;
    }
  });
  const proxy = new Proxy(pi, {get(target,key) {
    if(key==='on') return (name,handler)=>target.on(name,async (event,ctx)=>{
      if(name==='before_provider_request' && JSON.stringify(event.payload).includes(${JSON.stringify(goalMode ? "GOAL674" : "SECOND673")}) && ++attempts===${goalMode ? 4 : 2} && ${JSON.stringify(mode)}!=='normal') await delivered;
       if(name==='context') globalThis.__mc674Raw=structuredClone(event.messages);
       if(name==='before_provider_request') {
         if(++providerPayloads===1) firstPayload=structuredClone(event.payload);
         else if(${staleFirst}) {event.payload=structuredClone(firstPayload);log({phase:'stale-first-substituted'});}
       }
      if(name==='before_provider_request' && attempts===4 && ${rawRetry}) event.payload.messages=(await globalThis.__mc674BuildRaw()).messages;
      if(['agent_start','agent_end','context','before_provider_request'].includes(name)) log({phase:name,messages:event.messages,payload:event.payload,willContinue:event.willContinue,idle:ctx.isIdle(),agent:ctx.agent,sessionId:ctx.sessionManager.getSessionId(),branch:name!=='agent_start'?ctx.sessionManager.getBranch():undefined});
      const wrapped = Object.defineProperties(Object.create(ctx), {
        abort: {value:()=>{log({phase:'abort',hook:name});return ctx.abort();}},
        ui: {value:Object.defineProperty(Object.create(ctx.ui),'notify',{value:(text,level)=>{log({phase:'notice',text,level});return ctx.ui.notify(text,level);}})},
      });
      const result = await handler(event,wrapped);
      if(name==='context' && result?.messages) {
        const db=new Database(process.env.MAGIC_CONTEXT_STORAGE_DIR+'/context.db',{readonly:true});
        try { log({phase:'lkg-publication',rows:db.query('SELECT session_id, captured_at, capture_sequence, input_id_seq, json_prefix_hash FROM lkg_slots').all()}); }
        finally {db.close();}
      }
      if(['agent_start','agent_end','context','before_provider_request'].includes(name)) log({phase:name+'-end',messages:result?.messages});
      return result;
    });
    if(key==='appendEntry') return (type,data)=>{log({phase:'entry',type,data});return target.appendEntry(type,data);};
    const value=target[key];return typeof value==='function'?value.bind(target):value;
  }});
  await magic(proxy);
  pi.on('agent_end',()=>{if(ends===1) {log({phase:'earlier-end-delivered'});endDelivered();}});
};
`,
);
const { prepareContextDatabase } = await import(
	"../packages/e2e-tests/src/prepare-context-db"
);
prepareContextDatabase(isolated.XDG_DATA_HOME);
process.title = "omp";
const { createAgentSession } = await import(join(host, "src/sdk.ts"));
if (transformProof) {
	const { SnapcompactInlineTransformer, estimateInlineSavings } = await import(
		join(host, "src/session/snapcompact-inline.ts")
	);
	const original = SnapcompactInlineTransformer.prototype.transform;
	SnapcompactInlineTransformer.prototype.transform = async function (
		context: any,
		model: any,
	) {
		const options = {
			renderSystemPrompt: this.options.renderSystemPrompt,
			renderToolResults: this.options.renderToolResults,
			shape: this.options.shape,
		};
		audit({
			phase: "native-snapcompact-plan",
			options,
			modelInput: model.input,
			estimate: estimateInlineSavings({
				options,
				model,
				systemPrompt: context.systemPrompt,
				messages: context.messages,
			}),
		});
		return await original.call(this, context, model);
	};
}
const { initializeExtensions } = await import(
	join(host, "src/modes/runtime-init.ts")
);
let session: any;
let goalController: any;
let goalEnds = 0;
let finishGoal!: () => void;
const goalFinished = new Promise<void>((resolve) => {
	finishGoal = resolve;
});
try {
	audit({ phase: "host", version, bun: Bun.version, root, plugin, mode });
	({ session } = await createAgentSession({
		cwd: root,
		agentDir: isolated.PI_CODING_AGENT_DIR,
		additionalExtensionPaths: [probe],
		disableExtensionDiscovery: true,
		...(transformProof
			? {
					systemPrompt: `Proof instructions and dense reference data: ${Array.from({ length: 1500 }, (_, i) => ((i * 2654435761) >>> 0).toString(16).padStart(8, "0")).join("")}`,
				}
			: {}),
	}));
	await initializeExtensions(session, {
		mode: "rpc",
		reportRuntimeError: (error: unknown) =>
			audit({ phase: "runtime-error", error: String(error) }),
		reportSendError: (_action: string, error: unknown) =>
			audit({ phase: "send-error", error: String(error) }),
	});
	session.subscribe((event: any) => {
		goalController?.observe(event);
		if (goalMode && event.type === "agent_end" && ++goalEnds === 2)
			finishGoal();
		if (["agent_start", "agent_end"].includes(event.type))
			audit({ phase: "public-" + event.type, messages: event.messages });
	});
	isolation("start");
	if (transformProof) {
		const png =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1kAAAAASUVORK5CYII=";
		const stamp = Date.now() - 10000;
		const assistant = (id: string, timestamp: number) => ({
			role: "assistant",
			content: [
				{ type: "toolCall", id, name: "bash", arguments: { command: "proof" } },
			],
			api: "anthropic-messages",
			provider: "mock",
			model: "mock-model",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp,
		});
		const history = [
			{ role: "user", content: "TRANSFORM_SEED", timestamp: stamp },
			assistant("proof-large", stamp + 1),
			{
				role: "toolResult",
				toolCallId: "proof-large",
				toolName: "bash",
				isError: false,
				content: [
					{
						type: "text",
						text: Array.from({ length: 1500 }, (_, i) =>
							((i * 2246822519) >>> 0).toString(16).padStart(8, "0"),
						).join(""),
					},
					{ type: "image", data: png, mimeType: "image/png" },
				],
				timestamp: stamp + 2,
			},
			assistant("proof-recent", stamp + 3),
			{
				role: "toolResult",
				toolCallId: "proof-recent",
				toolName: "bash",
				isError: false,
				content: [{ type: "text", text: "recent result" }],
				timestamp: stamp + 4,
			},
			{
				role: "user",
				content: "TRANSFORM_STEER",
				steering: true,
				attribution: "agent",
				timestamp: stamp + 5,
			},
		];
		for (const message of history) {
			await session.sessionManager.appendMessage(message);
			session.agent.appendMessage(message);
		}
	}
	if (goalMode) {
		if (rawRetry) {
			const { convertToLlm } = await import(
				join(host, "src/session/messages.ts")
			);
			const { streamSimple } = await import(
				join(install, "node_modules/@oh-my-pi/pi-ai/src/index.ts")
			);
			(globalThis as any).__mc674BuildRaw = async () => {
				const controller = new AbortController();
				let rawPayload: any;
				const options = {
					...session.prepareSimpleStreamOptions(
						{ apiKey: "test-key-not-real", maxTokens: 128 },
						session.model.provider,
					),
					signal: controller.signal,
					onPayload: (payload: unknown) => {
						rawPayload = structuredClone(payload);
						controller.abort();
						return payload;
					},
				};
				const result = await streamSimple(
					session.model,
					{
						messages: convertToLlm((globalThis as any).__mc674Raw),
						systemPrompt: "raw adapter reference",
					},
					options,
				).result();
				audit({
					phase: "raw-adapter-reference",
					stopped: result.stopReason,
					payload: rawPayload,
				});
				if (!rawPayload || result.stopReason !== "aborted")
					throw new Error("raw reference was not cancelled before HTTP");
				return rawPayload;
			};
		}
		const { RpcGoalController } = await import(
			join(host, "src/modes/rpc/rpc-goal.ts")
		);
		goalController = new RpcGoalController(session);
		await goalController.handle({
			op: "create",
			objective: "GOAL674 make measurable progress",
			token_budget: 100000,
		});
		await goalFinished;
		await session.waitForIdle();
		await goalController.settled();
	} else {
		await session.prompt(`FIRST673${transformProof ? ` ${proofSecret}` : ""}`);
		await session.prompt(`SECOND673${transformProof ? ` ${proofSecret}` : ""}`);
	}
	await session.flushToDisk();
	isolation("end");
	const hooks = readFileSync(join(root, "hooks.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const wires = readFileSync(join(root, "audit.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((e) => e.phase === "wire");
	const check = (name: string, ok: boolean) => {
		audit({ phase: "check", name, passed: ok });
		if (!ok) throw new Error(`FAIL ${name}`);
	};
	if (rawRetry)
		check("raw provider retry never reaches HTTP", wires.length === 3);
	check(
		goalMode
			? "all goal HTTP requests contain managed context"
			: "all HTTP requests contain managed ordinal tags",
		wires.every((e) =>
			goalMode
				? JSON.stringify(e.body).includes("<session-history>")
				: /§\d+§ (?:FIRST|SECOND)673/.test(JSON.stringify(e.body)),
		),
	);
	if (mode !== "normal" && !transformProof) {
		check(
			"retried context pass publishes a durable LKG slot before dispatch",
			hooks.filter((e) => e.phase === "lkg-publication").at(-1)?.rows.length ===
				1,
		);
		const attempts = hooks
			.filter(
				(e) =>
					e.phase === "before_provider_request" &&
					JSON.stringify(e.payload).includes(
						goalMode ? "GOAL674" : "SECOND673",
					),
			)
			.slice(goalMode ? 2 : 0);
		const initialEntries = attempts[0]?.branch.filter(
			(e: any) => e.type === "message" || e.type === "custom_message",
		);
		const retryEntries = attempts[1]?.branch.filter(
			(e: any) => e.type === "message" || e.type === "custom_message",
		);
		check(
			goalMode
				? "retry retains the persisted prefix anchor while its final custom message persists"
				: "retry keeps the same native anchor and original transcript",
			attempts.length === 2 &&
				(goalMode
					? initialEntries.length >
							hooks.find((e) => e.phase === "held-earlier-end").messages
								.length &&
						initialEntries.every(
							(e: any, i: number) =>
								JSON.stringify(e) === JSON.stringify(retryEntries[i]),
						)
					: JSON.stringify(attempts[0].branch) ===
						JSON.stringify(attempts[1].branch)),
		);
		if (goalMode) {
			check(
				"goal continuation runs fresh context but its provider fallback does not",
				hooks.filter((e) => e.phase === "context").length === 3 &&
					hooks.filter((e) => e.phase === "before_provider_request").length ===
						4,
			);
			check(
				"goal runs share the parent session and main agent identity",
				new Set(
					hooks.filter((e) => e.phase === "context").map((e) => e.sessionId),
				).size === 1 &&
					hooks
						.filter((e) => e.phase === "agent_end")
						.every((e) => e.agent?.kind === "main"),
			);
		}
		check(
			rawRetry
				? "raw retry carries no Magic Context managed prefix"
				: cacheRetry
					? "cache fallback preserves managed conversation text"
					: "strict fallback reuses exactly the same managed messages",
			rawRetry
				? !JSON.stringify(attempts[1].payload.messages).includes(
						"<session-history>",
					)
				: cacheRetry
					? wires.length === 4
					: wires.length === (goalMode ? 4 : 3) &&
						JSON.stringify(wires[goalMode ? 2 : 1].body.messages) ===
							JSON.stringify(wires[goalMode ? 3 : 2].body.messages),
		);
		check(
			rawRetry
				? "unmanaged retry is refused once for content mismatch"
				: "late earlier end causes no refusal",
			rawRetry
				? hooks.filter(
						(e) =>
							e.phase === "entry" && e.type === "magic-context-turn-refused",
					).length === 1 &&
						hooks.some(
							(e) =>
								e.phase === "entry" &&
								e.data.message.includes(
									"does not match this pass's managed dispatch",
								),
						)
				: !hooks.some(
						(e) =>
							e.phase === "entry" && e.type === "magic-context-turn-refused",
					),
		);
	}
	let preparedMessages: unknown[] | undefined;
	let structureMatches = true;
	const structureEvidence: unknown[] = [];
	for (const hook of hooks) {
		if (hook.phase === "context-end" && Array.isArray(hook.messages))
			preparedMessages = hook.messages;
		if (hook.phase !== "before_provider_request" || !preparedMessages) continue;
		const matches = piMatchesPreparedStructure(
			hook.payload,
			piPreparedStructure(preparedMessages),
		);
		structureMatches &&= matches;
		structureEvidence.push({
			at: hook.at,
			prepared: piPreparedStructure(preparedMessages),
			matches,
		});
	}
	audit({ phase: "prepared-structure-proof", attempts: structureEvidence });
	if (staleFirst)
		check(
			"an older managed body is refused as the replacement pass's first send before HTTP",
			wires.length === 1 &&
				structureEvidence.length === 2 &&
				!structureMatches &&
				hooks.filter(
					(e) => e.phase === "entry" && e.type === "magic-context-turn-refused",
				).length === 1 &&
				hooks.some(
					(e) =>
						e.phase === "entry" &&
						e.data?.message?.includes("prepared turn structure"),
				),
		);
	else if (!rawRetry)
		check(
			"every first send and retry preserves prepared turns and ordered tool IDs",
			structureMatches && structureEvidence.length === wires.length,
		);
	if (transformProof) {
		const serialized = JSON.stringify(wires.map((e) => e.body));
		check(
			"secret obfuscation changes fake secret without losing managed signature",
			hooks.some(
				(e) =>
					e.phase === "context" &&
					JSON.stringify(e.messages).includes(proofSecret),
			) && !serialized.includes(proofSecret),
		);
		check(
			"native steering is wrapped after context",
			serialized.includes("TRANSFORM_STEER") &&
				serialized.includes("User interjection during work: priority"),
		);
		check(
			"date cwd reminder reaches the managed wire",
			serialized.includes("Today:") && serialized.includes(root),
		);
		check(
			"snapcompact renders system prompt into frames",
			serialized.includes("Full operating instructions: PNG"),
		);
		check(
			"snapcompact renders historical tool output and preserves image content",
			serialized.includes("compacted PNG frame") &&
				serialized.includes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"),
		);
		check(
			staleFirst
				? "the transformed initial send is admitted and stale replacement is not"
				: "all transformed first sends remain admitted",
			staleFirst
				? wires.length === 1
				: wires.length === 2 &&
						!hooks.some(
							(e) =>
								e.phase === "entry" && e.type === "magic-context-turn-refused",
						),
		);
	}
	console.log(
		`Bun ${Bun.version}; OMP ${version}; ${transformProof ? 8 : rawRetry ? 8 : goalMode ? 8 : mode === "late-retry" ? 6 : 2} checks passed; evidence ${root}`,
	);
} finally {
	await session?.dispose();
	await mock.stop();
}

// Independent randomized cache-safety driver for the bounded signed-thinking
// hold (issue 729) on Pi. Skipped unless MC_REVIEW_729=1.
//
// The same random event stream runs, in lockstep, through this checkout's
// context handler and, when MC_REVIEW_729_BASE names a checkout of the base
// revision, through that base's handler as a separate module graph with its
// own database. Oracles per side:
// - strict binding: every served signed thinking block has, in front of it,
//   the bytes of the request whose response produced it (a gap-free run of the
//   oldest thinking blocks may be missing; nothing else may differ);
// - open-turn completeness: the open turn serves all its signed blocks, none,
//   or all but a gap-free oldest run;
// - quiet-pass stability: a pass whose logs show no permission to change the
//   prefix has the same provider-visible view as on the preceding pass.
import { expect, spyOn, test } from "bun:test";
import { join, resolve } from "node:path";

const ENABLED = process.env.MC_REVIEW_729 === "1";
const BASE_ROOT = process.env.MC_REVIEW_729_BASE;
const HEAD_ROOT = resolve(import.meta.dir, "../../..");
const PASSES = Number(process.env.MC_REVIEW_729_PASSES ?? 420);
const SEED = Number(process.env.MC_REVIEW_729_SEED ?? 9729);
const MODEL = process.env.MC_REVIEW_729_MODEL ?? "claude-opus-5-5";

type PiMsg = Record<string, unknown> & { role: string; content?: unknown };
type View = { role: unknown; parts: string[] };

type Graph = {
	name: string;
	handlerModule: {
		registerPiContextHandler: (pi: unknown, options: unknown) => void;
		clearContextHandlerSession: (id: string) => void;
		signalPiHistoryRefresh: (id: string) => void;
		signalPiPendingMaterialization: (id: string, origin: string) => void;
	};
	ledger: { clearPiServedArraySession: (id: string) => void };
	utils: {
		createTestDb: () => {
			close: () => void;
			prepare: (sql: string) => { run: (...a: unknown[]) => unknown };
		};
		createFakePi: () => {
			pi: Record<string, unknown>;
			handlers: Map<string, (...a: unknown[]) => unknown>;
		};
		fakeContext: (...a: unknown[]) => Record<string, unknown>;
	};
	storage: {
		getOrCreateSessionMeta: (
			db: unknown,
			id: string,
		) => Record<string, unknown>;
		updateSessionMeta: (
			db: unknown,
			id: string,
			patch: Record<string, unknown>,
		) => void;
		queuePendingOp: (db: unknown, id: string, tag: number, op: string) => void;
		getTagsBySession: (
			db: unknown,
			id: string,
		) => Array<{ type: string; status: string; tagNumber: number }>;
	};
	compartments: {
		appendCompartments: (db: unknown, id: string, rows: unknown[]) => void;
	};
	meta: { clearCachedM0M1: (db: unknown, id: string) => void };
	logger: { sessionLog: (...a: unknown[]) => void };
	visible: { providerVisiblePiPart: (part: unknown) => unknown };
};

async function loadGraph(root: string, name: string): Promise<Graph> {
	const pi = join(root, "packages/pi-plugin/src");
	const core = join(root, "packages/plugin/src");
	const [
		handlerModule,
		ledger,
		utils,
		storage,
		compartments,
		meta,
		logger,
		visible,
	] = await Promise.all([
		import(join(pi, "context-handler.ts")),
		import(join(pi, "served-array-ledger.ts")),
		import(join(pi, "test-utils.test.ts")),
		import(join(core, "features/magic-context/storage.ts")),
		import(join(core, "features/magic-context/compartment-storage.ts")),
		import(join(core, "features/magic-context/storage-meta-shared.ts")),
		import(join(core, "shared/logger.ts")),
		import(join(pi, "provider-visible-parts-pi.ts")),
	]);
	return {
		name,
		handlerModule,
		ledger,
		utils,
		storage,
		compartments,
		meta,
		logger,
		visible,
	} as unknown as Graph;
}

function rng(seed: number) {
	let x = seed >>> 0 || 1;
	return () => {
		x ^= x << 13;
		x >>>= 0;
		x ^= x >>> 17;
		x ^= x << 5;
		x >>>= 0;
		return x / 4294967296;
	};
}

const parts = (m: PiMsg): Array<Record<string, unknown>> =>
	Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : [];
const isSigned = (p: Record<string, unknown>) =>
	p.type === "thinking" && typeof p.thinkingSignature === "string";

function makeView(graph: Graph) {
	return (m: PiMsg): View => ({
		role: m.role,
		parts:
			typeof m.content === "string"
				? [JSON.stringify(m.content)]
				: parts(m)
						.filter((p) => !(p.type === "text" && p.text === ""))
						.map((p) =>
							isSigned(p)
								? `THINK:${String(p.thinkingSignature)}:${String(p.thinking)}`
								: JSON.stringify(graph.visible.providerVisiblePiPart(p)),
						),
	});
}

function bindingProblem(birth: View[], now: View[]): string | null {
	if (birth.length !== now.length)
		return `prefix length ${birth.length} -> ${now.length}`;
	const born: string[] = [];
	const kept: string[] = [];
	for (let i = 0; i < birth.length; i++) {
		const a = birth[i]!;
		const b = now[i]!;
		if (a.role !== b.role) return `message ${i} role`;
		const ao = a.parts.filter((p) => !p.startsWith("THINK:"));
		const bo = b.parts.filter((p) => !p.startsWith("THINK:"));
		for (let k = 0; k < Math.max(ao.length, bo.length); k++)
			if (ao[k] !== bo[k]) {
				const x = String(ao[k]);
				const y = String(bo[k]);
				let d = 0;
				while (d < x.length && x[d] === y[d]) d++;
				return `message ${i} part ${k} @${d}: ${x.slice(Math.max(0, d - 50), d + 50)} => ${y.slice(Math.max(0, d - 50), d + 50)}`;
			}
		born.push(...a.parts.filter((p) => p.startsWith("THINK:")));
		kept.push(...b.parts.filter((p) => p.startsWith("THINK:")));
	}
	const offset = born.length - kept.length;
	if (offset < 0) return "prefix gained thinking";
	for (let i = 0; i < kept.length; i++)
		if (born[offset + i] !== kept[i])
			return "thinking removed from the middle or edited";
	return null;
}

const PERMISSION_LOG =
	/WILL APPLY|WILL RUN|executed=true|rematerialized=true|thinking strip|strip|binding|LKG|lkg_|first_render|released|EMERGENCY|bust/i;

/**
 * A pass is quiet when its drain was denied and nothing else announced a
 * prefix change: such a pass must have the same provider-visible view as
 * the preceding pass.
 */
const isQuiet = (lines: string[]) =>
	lines.some((l) => l.includes("pending ops WILL NOT APPLY")) &&
	!lines.some((l) =>
		/pending ops WILL APPLY|heuristics WILL RUN|executed=true|m1Refreshed=true|rematerialized=true|thinking strip|LKG replay|lkg_replay|released|REFUSED/.test(
			l,
		),
	);

type Side = {
	graph: Graph;
	db: ReturnType<Graph["utils"]["createTestDb"]>;
	handler: (event: unknown, ctx: unknown) => Promise<unknown>;
	register: () => void;
	view: (m: PiMsg) => View;
	births: Map<string, View[]>;
	previous: View[] | null;
	lastServed: PiMsg[] | null;
	lines: string[];
	counts: Record<string, number>;
	problems: string[];
};

async function runPiDriver() {
	const random = rng(SEED);
	const pick = <T>(items: readonly T[]): T =>
		items[Math.floor(random() * items.length)]!;
	const sessionId = "r729-pi";
	let percent = 30;
	const graphs: Graph[] = [await loadGraph(HEAD_ROOT, "head")];
	if (BASE_ROOT) graphs.push(await loadGraph(BASE_ROOT, "base"));
	const sides: Side[] = graphs.map((graph) => {
		const db = graph.utils.createTestDb();
		graph.storage.getOrCreateSessionMeta(db, sessionId);
		graph.storage.updateSessionMeta(db, sessionId, {
			piStableIdScheme: 1,
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const side: Side = {
			graph,
			db,
			handler: async () => undefined,
			register: () => {},
			view: makeView(graph),
			births: new Map(),
			previous: null,
			lastServed: null,
			lines: [],
			counts: {
				passes: 0,
				servedPasses: 0,
				refusals: 0,
				strictChecks: 0,
				strictBroken: 0,
				partialTurn: 0,
				quietPasses: 0,
				prefixChanged: 0,
				prefixChangedUnexplained: 0,
			},
			problems: [],
		};
		spyOn(graph.logger, "sessionLog").mockImplementation(
			(...args: unknown[]) => {
				side.lines.push(args.slice(1).map(String).join(" "));
			},
		);
		return side;
	});
	// Each side registers its own handler with its own graph's tagger; a
	// restart registers a fresh one on the same database.
	for (const side of sides) {
		const root = side.graph.name === "head" ? HEAD_ROOT : BASE_ROOT!;
		const tagger = await import(
			join(root, "packages/plugin/src/features/magic-context/tagger.ts")
		);
		side.register = () => {
			const fake = side.graph.utils.createFakePi();
			Object.assign(fake.pi, {
				getAllTools: () => [
					{
						name: "bash",
						description: "Run a command",
						parameters: { type: "object" },
					},
				],
				getActiveTools: () => ["bash"],
			});
			side.graph.handlerModule.registerPiContextHandler(fake.pi, {
				db: side.db,
				tagger: tagger.createTagger(),
				protectedTokens: 1500,
				injection: {
					injectionBudgetTokens: 1000,
					memoryEnabled: false,
					injectDocs: false,
				},
				heuristics: { keepReasoningTokens: 6_000 },
				scheduler: { executeThresholdPercentage: 65 },
			});
			side.handler = fake.handlers.get("context") as Side["handler"];
		};
		side.register();
	}

	const source: PiMsg[] = [];
	const ids: string[] = [];
	let clock = 1;
	let call = 0;
	let compartmentEnd = -1;
	let compartmentSequence = 0;
	let diverged = false;
	const divergence: string[] = [];
	const isRealUser = (m: PiMsg) =>
		m.role === "user" && !parts(m).every((p) => p.synthetic === true);
	const user = (synthetic = false) => {
		source.push({
			role: "user",
			content: synthetic
				? [
						{
							type: "text",
							text: "Continue with the todo list.",
							synthetic: true,
						},
					]
				: [{ type: "text", text: `task ${clock}` }],
			timestamp: clock++,
		});
		ids.push(`${synthetic ? "cont" : "user"}-${clock}`);
	};
	const usage = (reasoning: number) => ({
		input: 0,
		output: 100,
		reasoning,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	});
	const step = (kind: "heavy-recorded" | "heavy-text" | "light" | "final") => {
		const id = ++call;
		const content: Array<Record<string, unknown>> = [
			{
				type: "thinking",
				thinking:
					kind === "heavy-text"
						? `t${id} ${"consider each branch of the plan ".repeat(260)}`
						: `t${id} plan`,
				thinkingSignature: `s${id}`,
			},
		];
		if (kind === "final") content.push({ type: "text", text: `done ${id}` });
		else
			content.push({
				type: "toolCall",
				id: `c${id}`,
				name: "bash",
				arguments: { command: `step ${id}` },
			});
		source.push({
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: MODEL,
			usage: usage(
				kind === "heavy-recorded" ? 1_501 + Math.floor(random() * 3000) : 0,
			),
			stopReason: kind === "final" ? "stop" : "toolUse",
			timestamp: clock++,
		});
		ids.push(`a${id}`);
		if (kind !== "final") {
			source.push({
				role: "toolResult",
				toolCallId: `c${id}`,
				toolName: "bash",
				content: [
					{ type: "text", text: `${id} ${"x = f(y); // line\n".repeat(12)}` },
				],
				isError: false,
				timestamp: clock++,
			});
			ids.push(`r${id}`);
		}
		return `s${id}`;
	};

	try {
		user();
		for (let pass = 0; pass < PASSES; pass++) {
			const events: string[] = [];
			if (pass > 0) {
				const r = random();
				if (r < 0.06) {
					user();
					events.push("user");
				} else if (r < 0.14) {
					user(true);
					events.push("continuation");
				}
				if (random() < 0.25) {
					percent = pick([
						10, 30, 50, 60, 64, 66, 70, 74, 75, 76, 80, 84, 85, 86, 90, 95, 96,
					]);
					events.push(`usage=${percent}`);
				}
				const dropDraw = random();
				const flushDraw = random();
				const compDraw = random();
				const idleDraw = random();
				const firstRenderDraw = random();
				const restartDraw = random();
				const dropPick = random();
				if (dropDraw < 0.22) events.push("drop");
				if (flushDraw < 0.06) events.push("flush");
				if (compDraw < 0.06) events.push("compartment");
				if (idleDraw < 0.03) events.push("idle");
				if (firstRenderDraw < 0.025) events.push("first-render");
				if (restartDraw < 0.03) events.push("restart");
				let compartment: unknown = null;
				if (events.includes("compartment")) {
					const ends: number[] = [];
					const midTurn = random() < 0.5;
					for (let i = compartmentEnd + 2; i < source.length - 4; i++) {
						const next = source[i + 1]!;
						if (
							(midTurn
								? next.role === "user" || next.role === "assistant"
								: isRealUser(next)) &&
							source[i]!.role !== "assistant"
						)
							ends.push(i);
					}
					if (ends.length > 0) {
						const end = ends[Math.floor(random() * ends.length)]!;
						compartment = {
							sequence: compartmentSequence++,
							startMessage: compartmentEnd + 2,
							endMessage: end + 1,
							startMessageId: ids[compartmentEnd + 1],
							endMessageId: ids[end],
							title: `history ${pass}`,
							content: `U: summarized up to pass ${pass}`,
						};
						compartmentEnd = end;
					}
				}
				for (const side of sides) {
					const g = side.graph;
					if (events.includes("drop")) {
						const tags = g.storage
							.getTagsBySession(side.db, sessionId)
							.filter((t) => t.type === "tool" && t.status === "active");
						const target = tags[Math.floor(dropPick * tags.length)];
						if (target)
							g.storage.queuePendingOp(
								side.db,
								sessionId,
								target.tagNumber,
								"drop",
							);
					}
					if (events.includes("flush"))
						g.handlerModule.signalPiPendingMaterialization(
							sessionId,
							"user_flush",
						);
					if (compartment) {
						g.compartments.appendCompartments(side.db, sessionId, [
							compartment,
						]);
						g.handlerModule.signalPiHistoryRefresh(sessionId);
					}
					if (events.includes("idle")) {
						side.db
							.prepare(
								"UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
							)
							.run(Date.now() - 3 * 60 * 60 * 1000, sessionId);
						g.storage.updateSessionMeta(side.db, sessionId, {
							lastResponseTime: Date.now() - 2 * 60 * 60 * 1000,
						});
					}
					if (events.includes("first-render"))
						g.meta.clearCachedM0M1(side.db, sessionId);
					if (events.includes("restart")) {
						g.handlerModule.clearContextHandlerSession(sessionId);
						g.ledger.clearPiServedArraySession(sessionId);
						side.register();
					}
				}
			}
			const served: Array<PiMsg[] | null> = [];
			for (const side of sides) {
				side.lines.length = 0;
				side.counts.passes++;
				const messages = structuredClone(source);
				const ctx = {
					...side.graph.utils.fakeContext(
						sessionId,
						process.cwd(),
						[...ids],
						messages,
					),
					getSystemPrompt: () => "You are a coding agent.",
					model: {
						provider: "anthropic",
						id: MODEL,
						api: "anthropic-messages",
						contextWindow: 200_000,
					},
					getContextUsage: () => ({
						tokens: percent * 2000,
						percent,
						contextWindow: 200_000,
					}),
				};
				try {
					const result = (await side.handler({ messages }, ctx)) as
						| { messages: PiMsg[] }
						| undefined;
					served.push(result?.messages ?? messages);
				} catch (error) {
					side.counts.refusals++;
					side.lines.push(
						`REFUSED ${(error as Error).name}: ${(error as Error).message}`,
					);
					served.push(null);
				}
				await new Promise((r) => setImmediate(r));
			}
			if (
				(process.env.MC_REVIEW_729_DUMP ?? "").split(",").includes(String(pass))
			)
				for (const side of sides)
					console.log(
						`DUMP ${side.graph.name} pass ${pass} [${events}]\n${side.lines.join("\n")}`,
					);
			sides.forEach((side, index) => {
				const out = served[index];
				if (!out) return;
				side.counts.servedPasses++;
				const views = out.map(side.view);
				for (let i = 0; i < out.length; i++)
					for (const part of parts(out[i]!)) {
						if (!isSigned(part)) continue;
						const birth = side.births.get(String(part.thinkingSignature));
						if (!birth) continue;
						side.counts.strictChecks++;
						const problem = bindingProblem(birth, views.slice(0, i));
						if (problem) {
							side.counts.strictBroken++;
							if (side.problems.length < 40)
								side.problems.push(
									`pass ${pass} [${events.join(",")}] usage=${percent} ${String(part.thinkingSignature)}: ${problem} | ${side.lines
										.filter((l) => PERMISSION_LOG.test(l))
										.slice(0, 5)
										.join(" || ")
										.slice(0, 500)}`,
								);
						}
					}
				let start = source.length;
				for (let i = source.length - 1; i >= 0; i--)
					if (isRealUser(source[i]!)) {
						start = i + 1;
						break;
					}
				const turnSigs = source.slice(start).flatMap((m) =>
					parts(m)
						.filter(isSigned)
						.map((p) => String(p.thinkingSignature)),
				);
				const servedSigs = new Set(
					out.flatMap((m) =>
						parts(m)
							.filter(isSigned)
							.map((p) => String(p.thinkingSignature)),
					),
				);
				const kept = turnSigs.filter((s) => servedSigs.has(s));
				if (kept.length > 0 && kept.length !== turnSigs.length) {
					side.counts.partialTurn++;
					const first = turnSigs.indexOf(kept[0]!);
					if (
						!turnSigs.slice(first).every((s) => servedSigs.has(s)) &&
						side.problems.length < 40
					)
						side.problems.push(
							`pass ${pass}: open turn serves a middle gap ${JSON.stringify(turnSigs.map((s) => (servedSigs.has(s) ? s : "_")))}`,
						);
				}
				if (side.previous) {
					const changed = side.previous.some(
						(v, i) => JSON.stringify(v) !== JSON.stringify(views[i]),
					);
					const explained = !isQuiet(side.lines);
					if (changed) side.counts.prefixChanged++;
					if (!explained) side.counts.quietPasses++;
					if (changed && !explained) {
						side.counts.prefixChangedUnexplained++;
						if (side.problems.length < 40)
							side.problems.push(
								`pass ${pass} [${events.join(",")}]: prefix changed with no permission log`,
							);
					}
				}
				side.previous = views;
				side.lastServed = out;
			});
			if (sides.length === 2 && !diverged) {
				const [h, b] = served;
				const same =
					(h === null && b === null) ||
					(h !== null &&
						b !== null &&
						JSON.stringify(h.map(sides[0]!.view)) ===
							JSON.stringify(b.map(sides[1]!.view)));
				if (!same) {
					diverged = true;
					divergence.push(
						`pass ${pass} [${events.join(",")}] usage=${percent}: head ${h ? "served" : "refused"} / base ${b ? "served" : "refused"}; head: ${sides[0]!.lines
							.filter((l) => /hold|strip|WILL|REFUSED/.test(l))
							.slice(0, 4)
							.join(" || ")
							.slice(0, 400)}`,
					);
				}
			}
			if (served.some((s) => s !== null)) {
				const draw = random();
				const kind =
					draw < 0.1
						? "heavy-recorded"
						: draw < 0.16
							? "heavy-text"
							: draw < 0.22
								? "final"
								: "light";
				const signature = step(kind);
				sides.forEach((side, index) => {
					const out = served[index] ?? side.lastServed;
					if (out) side.births.set(signature, out.map(side.view));
				});
				for (const side of sides)
					side.graph.storage.updateSessionMeta(side.db, sessionId, {
						lastResponseTime: Date.now(),
					});
				if (kind === "final" && random() < 0.6) user();
			}
		}
		return {
			head: sides[0]!.counts,
			base: sides[1]?.counts,
			headProblems: sides[0]!.problems,
			baseProblems: sides[1]?.problems ?? [],
			divergence,
		};
	} finally {
		for (const side of sides) {
			side.graph.handlerModule.clearContextHandlerSession(sessionId);
			side.graph.ledger.clearPiServedArraySession(sessionId);
			side.db.close();
		}
	}
}

test.skipIf(!ENABLED)(
	`Pi: randomized strict-binding driver (${PASSES} passes)`,
	async () => {
		const result = await runPiDriver();
		console.log(
			`[r729-driver] pi ${MODEL} seed=${SEED} ${JSON.stringify(result, null, 1)}`,
		);
		expect(result.head.passes).toBe(PASSES);
		expect(result.headProblems).toEqual([]);
	},
	1_800_000,
);

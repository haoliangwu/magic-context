// Independent randomized cache-safety driver for Pi's signed-thinking
// safeguards in compaction-off mode (GitHub issue 729): a first render with no
// cached m[0]/m[1] strips signed thinking unless the rendered head equals the
// last served one. Skipped unless MC_REVIEW_729F=1.
//
// Compared with review-729-driver.test.ts it adds, per pass at random:
// switches between managed and compaction-off mode (a restart, or an
// in-process re-registration that keeps the served-array ledger, as Pi's
// extension reload does), project-memory and project-docs edits (so a first
// render really changes the head), cleared cached m[0]/m[1], restarts, idle
// expiry, history blocks, drops and flushes.
//
// The same random stream runs in lockstep through this checkout (HEAD) and,
// when MC_REVIEW_729F_BASE names a checkout of the base revision, through that
// base as a separate module graph with its own database. Oracles per side are
// those of review-729-driver.test.ts (strict binding, open-turn completeness,
// quiet-pass stability). Passes where HEAD drops signed blocks that base kept
// validly are counted, to find strips the head comparison takes needlessly.
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

const ENABLED = process.env.MC_REVIEW_729F === "1";
const BASE_ROOT = process.env.MC_REVIEW_729F_BASE;
const HEAD_ROOT = resolve(import.meta.dir, "../../..");
const PASSES = Number(process.env.MC_REVIEW_729F_PASSES ?? 420);
const SEED = Number(process.env.MC_REVIEW_729F_SEED ?? 7291);
const MODEL = "claude-opus-5-5";

type PiMsg = Record<string, unknown> & { role: string; content?: unknown };
type View = { role: unknown; parts: string[] };
// biome-ignore lint/suspicious/noExplicitAny: two module graphs of one shape
type Mod = any;
type Graph = {
	name: string;
	handlerModule: Mod;
	ledger: Mod;
	utils: Mod;
	storage: Mod;
	compartments: Mod;
	meta: Mod;
	logger: Mod;
	visible: Mod;
	memory: Mod;
	workspaces: Mod;
	identity: Mod;
	tagger: Mod;
};

async function loadGraph(root: string, name: string): Promise<Graph> {
	const pi = join(root, "packages/pi-plugin/src");
	const core = join(root, "packages/plugin/src");
	const paths: Record<string, string> = {
		handlerModule: join(pi, "context-handler.ts"),
		ledger: join(pi, "served-array-ledger.ts"),
		utils: join(pi, "test-utils.test.ts"),
		storage: join(core, "features/magic-context/storage.ts"),
		compartments: join(core, "features/magic-context/compartment-storage.ts"),
		meta: join(core, "features/magic-context/storage-meta-shared.ts"),
		logger: join(core, "shared/logger.ts"),
		visible: join(pi, "provider-visible-parts-pi.ts"),
		memory: join(core, "features/magic-context/memory/storage-memory.ts"),
		workspaces: join(core, "features/magic-context/workspaces.ts"),
		identity: join(core, "features/magic-context/memory/project-identity.ts"),
		tagger: join(core, "features/magic-context/tagger.ts"),
	};
	const entries = await Promise.all(
		Object.entries(paths).map(async ([key, path]) => [key, await import(path)]),
	);
	return { name, ...Object.fromEntries(entries) } as Graph;
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
	/WILL APPLY|WILL RUN|executed=true|rematerialized=true|thinking strip|strip|binding|LKG|lkg_|first_render|released|EMERGENCY|bust|frozen|compaction/i;

const isQuiet = (lines: string[]) =>
	lines.some((l) => l.includes("pending ops WILL NOT APPLY")) &&
	!lines.some((l) =>
		/pending ops WILL APPLY|heuristics WILL RUN|executed=true|m1Refreshed=true|rematerialized=true|thinking strip|LKG replay|lkg_replay|released|REFUSED|first_render/i.test(
			l,
		),
	);

type Side = {
	graph: Graph;
	home: string;
	db: Mod;
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
	const sessionId = "r729f-pi";
	const tmpRoot = join(
		process.env.TMPDIR ?? tmpdir(),
		"magic-context",
		"729f-review",
	);
	mkdirSync(tmpRoot, { recursive: true });
	const root = createTestTempDirFromPath(join(tmpRoot, `pi-${SEED}-`));
	const project = join(root, "project");
	mkdirSync(project, { recursive: true });
	writeFileSync(join(project, "ARCHITECTURE.md"), "# Architecture\n\nv0\n");
	let compactionOff = random() < 0.5;
	let percent = 30;
	const graphs: Graph[] = [await loadGraph(HEAD_ROOT, "head")];
	if (BASE_ROOT) graphs.push(await loadGraph(BASE_ROOT, "base"));
	const useHome = (side: Side) => {
		process.env.XDG_DATA_HOME = side.home;
	};
	const sides: Side[] = graphs.map((graph) => {
		const home = join(root, `${graph.name}-home`);
		mkdirSync(home, { recursive: true });
		process.env.XDG_DATA_HOME = home;
		const db = graph.utils.createTestDb();
		graph.storage.getOrCreateSessionMeta(db, sessionId);
		graph.storage.updateSessionMeta(db, sessionId, {
			piStableIdScheme: 1,
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const side: Side = {
			graph,
			home,
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
				strictBrokenOpenTurn: 0,
				partialTurn: 0,
				quietPasses: 0,
				prefixChanged: 0,
				prefixChangedUnexplained: 0,
				offPasses: 0,
				offStrips: 0,
				switches: 0,
				strippedWhereBaseKeptValidly: 0,
				brokenPasses: 0,
				headOnlyBrokenPasses: 0,
			},
			problems: [],
		};
		spyOn(graph.logger, "sessionLog").mockImplementation(
			(...args: unknown[]) => {
				side.lines.push(args.slice(1).map(String).join(" "));
			},
		);
		side.register = () => {
			const fake = graph.utils.createFakePi();
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
			graph.handlerModule.registerPiContextHandler(fake.pi, {
				db,
				tagger: graph.tagger.createTagger(),
				protectedTokens: 1500,
				...(compactionOff ? { compactionOff: true } : {}),
				injection: {
					injectionBudgetTokens: 1500,
					memoryEnabled: true,
					injectDocs: true,
				},
				heuristics: { keepReasoningTokens: 6_000 },
				scheduler: { executeThresholdPercentage: 65 },
			});
			side.handler = fake.handlers.get("context") as Side["handler"];
		};
		side.register();
		return side;
	});

	const source: PiMsg[] = [];
	const ids: string[] = [];
	let clock = 1;
	let call = 0;
	let compartmentEnd = -1;
	let compartmentSequence = 0;
	let diverged = false;
	const divergence: string[] = [];
	const headOnly: string[] = [];
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
				const d = Array.from({ length: 12 }, () => random());
				if (d[0]! < 0.22) events.push("drop");
				if (d[1]! < 0.06) events.push("flush");
				if (d[2]! < 0.06) events.push("compartment");
				if (d[3]! < 0.03) events.push("idle");
				if (d[4]! < 0.05) events.push("first-render");
				if (d[5]! < 0.03) events.push("restart");
				if (d[6]! < 0.04) events.push(d[7]! < 0.5 ? "switch" : "switch-warm");
				if (d[8]! < 0.05) events.push("memory");
				if (d[9]! < 0.05) events.push("docs");
				const dropPick = d[10]!;
				if (events.includes("switch") || events.includes("switch-warm"))
					compactionOff = !compactionOff;
				if (events.includes("docs"))
					writeFileSync(
						join(project, "ARCHITECTURE.md"),
						`# Architecture\n\nrevision ${pass}\n`,
					);
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
					useHome(side);
					const g = side.graph;
					if (events.includes("drop")) {
						const tags = (
							g.storage.getTagsBySession(side.db, sessionId) as Array<{
								type: string;
								status: string;
								tagNumber: number;
							}>
						).filter((t) => t.type === "tool" && t.status === "active");
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
					if (events.includes("memory")) {
						const row = side.db
							.prepare(
								"SELECT cached_m0_project_identity AS id FROM session_meta WHERE session_id = ?",
							)
							.get(sessionId) as { id: string | null } | undefined;
						const identity =
							row?.id ?? g.identity.resolveProjectIdentity(project);
						g.memory.insertMemory(side.db, {
							projectPath: identity,
							category: "PROJECT_RULES",
							content: `Rule from pass ${pass}`,
							importance: 90,
						});
						g.workspaces.bumpEpochsForWorkspaceMembers(side.db, identity);
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
					if (events.includes("restart") || events.includes("switch")) {
						g.handlerModule.clearContextHandlerSession(sessionId);
						g.ledger.clearPiServedArraySession(sessionId);
						side.register();
					} else if (events.includes("switch-warm")) side.register();
					if (events.includes("switch") || events.includes("switch-warm"))
						side.counts.switches++;
				}
			}
			const served: Array<PiMsg[] | null> = [];
			for (const side of sides) {
				useHome(side);
				side.lines.length = 0;
				side.counts.passes++;
				if (compactionOff) side.counts.offPasses++;
				const messages = structuredClone(source);
				const ctx = {
					...side.graph.utils.fakeContext(
						sessionId,
						project,
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
				(process.env.MC_REVIEW_729F_DUMP ?? "")
					.split(",")
					.includes(String(pass))
			)
				for (const side of sides)
					console.log(
						`DUMP ${side.graph.name} pass ${pass} [${events}] off=${compactionOff}\n${side.lines.join("\n")}`,
					);
			const signedServed = served.map(
				(out) =>
					new Set(
						(out ?? []).flatMap((m) =>
							parts(m)
								.filter(isSigned)
								.map((p) => String(p.thinkingSignature)),
						),
					),
			);
			const brokenThisPass: boolean[] = [];
			sides.forEach((side, index) => {
				const out = served[index];
				brokenThisPass.push(false);
				if (
					compactionOff &&
					side.lines.some((l) => /proactive thinking strip/i.test(l))
				)
					side.counts.offStrips++;
				if (!out) return;
				side.counts.servedPasses++;
				const views = out.map(side.view);
				let openStart = source.length;
				for (let i = source.length - 1; i >= 0; i--)
					if (isRealUser(source[i]!)) {
						openStart = i + 1;
						break;
					}
				const openTurn = new Set(
					source.slice(openStart).flatMap((m) =>
						parts(m)
							.filter(isSigned)
							.map((p) => String(p.thinkingSignature)),
					),
				);
				for (let i = 0; i < out.length; i++)
					for (const part of parts(out[i]!)) {
						if (!isSigned(part)) continue;
						const birth = side.births.get(String(part.thinkingSignature));
						if (!birth) continue;
						side.counts.strictChecks++;
						const problem = bindingProblem(birth, views.slice(0, i));
						if (problem) {
							side.counts.strictBroken++;
							if (openTurn.has(String(part.thinkingSignature)))
								side.counts.strictBrokenOpenTurn++;
							brokenThisPass[index] = true;
							if (side.problems.length < 40)
								side.problems.push(
									`pass ${pass} [${events.join(",")}] off=${compactionOff} usage=${percent} ${String(part.thinkingSignature)}${openTurn.has(String(part.thinkingSignature)) ? "(open)" : "(old)"}: ${problem} | ${side.lines
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
				const servedSigs = signedServed[index]!;
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
								`pass ${pass} [${events.join(",")}] off=${compactionOff}: prefix changed with no permission log`,
							);
					}
				}
				side.previous = views;
				side.lastServed = out;
			});
			sides.forEach((side, index) => {
				if (brokenThisPass[index]) side.counts.brokenPasses++;
			});
			if (
				sides.length === 2 &&
				brokenThisPass[0] &&
				served[1] &&
				!brokenThisPass[1]
			) {
				sides[0]!.counts.headOnlyBrokenPasses++;
				headOnly.push(`pass ${pass} [${events.join(",")}]`);
			}
			if (sides.length === 2 && served[0] && served[1] && !brokenThisPass[1]) {
				const headSigs = signedServed[0]!;
				const lost = [...signedServed[1]!].filter((s) => !headSigs.has(s));
				if (lost.length > 0) {
					sides[0]!.counts.strippedWhereBaseKeptValidly++;
					if (sides[0]!.problems.length < 40)
						sides[0]!.problems.push(
							`INFO pass ${pass} [${events.join(",")}] off=${compactionOff}: head dropped ${lost.length} signed blocks base kept validly | ${sides[0]!.lines
								.filter((l) => /strip|first_render|frozen|hold/i.test(l))
								.slice(0, 4)
								.join(" || ")
								.slice(0, 400)}`,
						);
				}
			}
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
						`pass ${pass} [${events.join(",")}] off=${compactionOff} usage=${percent}: head ${h ? "served" : "refused"} / base ${b ? "served" : "refused"}; head: ${sides[0]!.lines
							.filter((l) =>
								/hold|strip|WILL|REFUSED|frozen|first_render/i.test(l),
							)
							.slice(0, 5)
							.join(" || ")
							.slice(0, 600)}`,
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
			headOnly,
		};
	} finally {
		for (const side of sides) {
			side.graph.handlerModule.clearContextHandlerSession(sessionId);
			side.graph.ledger.clearPiServedArraySession(sessionId);
			side.db.close();
		}
		rmSync(root, { recursive: true, force: true });
	}
}

test.skipIf(!ENABLED)(
	`Pi: randomized follow-up driver (${PASSES} passes, modes, head edits)`,
	async () => {
		const result = await runPiDriver();
		const clip = (lines: string[], n: number, width: number) =>
			lines.slice(0, n).map((line) => line.slice(0, width));
		console.log(
			`[r729f-driver] pi seed=${SEED}\n head=${JSON.stringify(result.head)}\n base=${JSON.stringify(result.base)}\n headProblems(${result.headProblems.length})=${JSON.stringify(clip(result.headProblems, 12, 420), null, 1)}\n baseProblems(${result.baseProblems.length})=${JSON.stringify(clip(result.baseProblems, 2, 300))}\n divergence=${JSON.stringify(clip(result.divergence, 1, 900))}\n headOnly=${JSON.stringify(result.headOnly.slice(0, 20))}`,
		);
		expect(result.head.passes).toBe(PASSES);
		// Fails only on a pass where HEAD served an invalid signed block and base,
		// on the same event stream, did not. Breaks both sides share are gaps
		// that predate HEAD; they are counted and printed, not asserted.
		expect(result.headOnly).toEqual([]);
	},
	1_800_000,
);

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, utimesSync } from "node:fs";
import { resolve } from "node:path";

// The original implementation is staged in Git; each temporary mutation is restored from that staged baseline after its test.
const root = resolve(import.meta.dir, "../../../..");
const plugin = "packages/plugin/";
const owner = `${plugin}src/v2/fold/owner.ts`;
const context = `${plugin}src/v2/hooks/context.ts`;
const foldTest = "I6a I7 I8 I9 R39 provider: host fold costs zero requests and restores unarchived tail";
const markerTest = "I10 real-host counters: v2 fold plus historian publication plus ten turns invoke no v1 marker members; v1 control invokes all four";
interface Control { name: string; path: string; from: string; to: string; test: string; file: string; unit?: boolean }
const unit = (name: string, from: string, to: string, test: string): Control => ({ name, path: owner, from, to, test, file: "src/v2/fold/owner.test.ts", unit: true });
const fold = (name: string, path: string, from: string, to: string): Control => ({ name, path, from, to, test: foldTest, file: "tests/opencode2/fold-s3-owner.test.ts" });
const controls: Control[] = [
    unit("same-watermark replay", "if (same) return previous;", "if (false && same) return previous;", "R3a same-watermark provisional firing replays submitted SHA without materializing"),
    unit("later provisional supersession", "previous.watermark === args.watermark", "true", "R3a later provisional watermark supersedes the earlier fold"),
    unit("boot actual-cut binding", "state.cutSeq = args.cutSeq;", "state.cutSeq = state.watermark;", "R3a boot rebinds persisted provisional to actual cut and pins render separately"),
    unit("cut-before-watermark refusal", "args.cutSeq < state.watermark", "false", "R3a cut before provisional watermark is a HARD divergence and is not bound"),
    unit("local same-cut replay", "previous.cutSeq === args.runningCut", "false", "R3 local same-cut replay and later-cut fresh materialization"),
    unit("render divergence notification", "args.onHard(reason);", "void reason;", "I8 mutated host render forces one HARD and never replaces the pinned identity"),
    { name: "stable raw ordinals", path: `${plugin}src/v2/hooks/store.ts`, from: "history.filter(isRawRow)", to: "rows.filter(isRawRow)", test: "R39 post-fold raw window retains pre-fold ordinals", file: "src/v2/fold/ordinals.test.ts", unit: true },
    fold("restored defer metadata stability", `${plugin}src/v2/fold/restore.ts`, "const data = row.data;", "const data = { ...row.data, metadata: { nonce: Date.now() } };"),
    fold("SOFT mutation gate", context, "percentage: (inputTokens / limit) * 100", "percentage: 0"),
    fold("persisted render pin", context, "checkpoint = structuredClone(identity.rendered ?? incoming);", "checkpoint = structuredClone(incoming);"),
    fold("unarchived source restoration", `${plugin}src/v2/fold/restore.ts`, "const data = row.data;", "return []; const data = row.data;"),
    fold("baseline-only host summary", context, "draft.result = { summary: fold.submitted };", "draft.result = { summary: fold.submitted + ' UNARCHIVED-ALPHA-41' };"),
    fold("zero host compaction requests", context, "draft.result = { summary: fold.submitted };", "await context.session.generate!({sessionID: draft.sessionID, prompt: 'extra compaction request'}); draft.result = { summary: fold.submitted };"),
    fold("HARD rendered checkpoint update", context, "`<summary>\\n${baseline}\\n</summary>`", "`<summary>\\n${submitted}\\n</summary>`"),
    { name: "all four marker counters", path: context, from: "compactionMarkerStrategy: v2CompactionMarkerStrategy,", to: "compactionMarkerStrategy: undefined,", test: markerTest, file: "tests/opencode2/marker-s3-runtime.test.ts" },
    { name: "organic historian availability", path: context, from: "hiddenCompletionExecutor !== undefined && config.historian?.disable !== true", to: "false", test: "R36 automatic pressure schedules one historian generate on real GA without a test hook", file: "tests/opencode2/automatic-s3-paths.test.ts" },
    { name: "organic dream event carrier", path: `${plugin}src/v2/hooks/dream-trigger.ts`, from: 'event.type !== "session.execution.succeeded"', to: 'event.type !== "never-matching-event"', test: "R22 automatic execution-ended event dispatches due classify through real GA generate", file: "tests/opencode2/automatic-s3-paths.test.ts" },
    { name: "compress-cues executor transport", path: `${plugin}src/features/magic-context/mural/compress-cues.ts`, from: "args.hiddenCompletionExecutor ??", to: "undefined ??", test: "R38 compress-cues executes one metered generate and applies its cue on real GA", file: "tests/opencode2/hidden-s3-executor.test.ts" },
    { name: "calibrated own system", path: `${plugin}src/v2/hidden-completion.ts`, from: 'text: typeof body.system === "string" ? body.system : attempt.run.identity.system,', to: 'text: "wrong system",', test: "R33 calibration: v1 child and v2 own/session-system arms preserve prompt bytes and record validator verdicts", file: "tests/opencode2/hidden-s3-executor.test.ts" },
];
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const report: unknown[] = [];
const output = process.env.MC_S3_MUTATION_OUTPUT ?? "/tmp/mc-s3-mutations.json";
const selected = process.argv[2] ? controls.filter(control => control.name === process.argv[2]) : controls;
for (const control of selected) {
    git("add", "--", control.path);
    if (git("diff", "--stat")) throw new Error("Unstaged changes must be staged before mutation");
    const path = resolve(root, control.path);
    const source = readFileSync(path, "utf8");
    if (source.split(control.from).length !== 2) throw new Error(`Ambiguous mutation: ${control.name}`);
    let during = "", restored = "", result: ReturnType<typeof spawnSync> | undefined;
    try {
        writeFileSync(path, `// NON-VACUITY BREAK: ${control.name}\n${source.replace(control.from, control.to)}`);
        during = git("diff", "--stat");
        if (!during) throw new Error("Mutant was not applied");
        if (!control.unit) {
            const build = spawnSync("bun", ["run", "build"], { cwd: resolve(root, plugin), encoding: "utf8", timeout: 120000 });
            // Mutants can intentionally violate static narrowing; the bundle must still exist and run.
            if (!`${build.stdout}${build.stderr}`.includes("server.js")) throw new Error("Mutant did not build its host bundle");
        }
        result = spawnSync("bun", ["test", control.file, "--test-name-pattern", control.test.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")], { cwd: resolve(root, control.unit ? plugin : "packages/e2e-tests"), encoding: "utf8", timeout: 240000 });
        writeFileSync(`${output}.${controls.indexOf(control)}.log`, `${result.stdout}${result.stderr}`);
    } finally {
        git("checkout", "--", control.path);
        const now = new Date(); utimesSync(path, now, now);
        restored = git("diff", "--stat");
        if (restored) throw new Error("Mutation restoration left an unstaged diff");
    }
    const text = `${result?.stdout}${result?.stderr}`;
    const failures = text.split("\n").filter(line => line.startsWith("(fail)"));
    const reddened = failures.length === 1 && failures[0].includes(control.test);
    const entry = { control: control.name, expected_red: control.test, captured_output: failures.join("\n").slice(0, 400), applied_evidence: `${control.path}: during=${during}; after=${restored || "empty git diff --stat"}`, outcome: reddened ? "reddened" : result?.error ? "hung" : result?.status === 0 ? "undefended" : "not_reached" };
    report.push(entry); writeFileSync(output, JSON.stringify(report, null, 2)); console.log(JSON.stringify(entry));
    if (!reddened) throw new Error(`Mutation did not fail only its named test: ${control.name}`);
}
const rebuild = spawnSync("bun", ["run", "build"], { cwd: resolve(root, plugin), encoding: "utf8", timeout: 120000 });
if (rebuild.status !== 0) throw new Error(`Restored build failed: ${rebuild.stderr}`);

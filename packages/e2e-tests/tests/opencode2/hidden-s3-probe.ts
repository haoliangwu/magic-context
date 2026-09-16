import { calibrationChunk, calibrationPrompt } from "./calibration-s3-fixture";
import { runValidatedHistorianPass } from "../../../plugin/src/hooks/magic-context/compartment-runner-historian";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireCompartmentLease, releaseCompartmentLease } from "../../../plugin/src/features/magic-context/compartment-lease";
import { getCompartments } from "../../../plugin/src/features/magic-context/compartment-storage";
import { createDreamTaskExecutor } from "../../../plugin/src/features/magic-context/dreamer/task-executor";
import { getDreamRuns } from "../../../plugin/src/features/magic-context/dreamer/storage-dream-runs";
import { leaseKeyFor } from "../../../plugin/src/features/magic-context/dreamer/task-registry";
import { insertMemory } from "../../../plugin/src/features/magic-context/memory";
import { openDatabase } from "../../../plugin/src/features/magic-context/storage";
import { runCompartmentAgent } from "../../../plugin/src/hooks/magic-context/compartment-runner-incremental";
import { resolveWrapupProtectedTailBoundary } from "../../../plugin/src/hooks/magic-context/protected-tail-boundary";
import { setRawMessageProvider } from "../../../plugin/src/hooks/magic-context/read-session-chunk";
import { getDataDir } from "../../../plugin/src/shared/data-path";
import { createV2HiddenCompletionExecutor } from "../../../plugin/src/v2/hidden-completion";
import { v2CompactionMarkerStrategy } from "../../../plugin/src/v2/fold/markers";
import { rawMessages } from "../../../plugin/src/v2/hooks/store";
import { gaDatabasePath, V2StoreReader } from "../../../plugin/src/v2/store-reader";

export default {
    id: "mc-hidden-s3-proof",
    async setup(context: any) {
        let warmingBefore: string | undefined;
        let calibrationSystem: any[] | undefined;
        const text = (draft: any) => draft.messages.at(-1)?.content?.[0]?.text;
        const save = (value: unknown) => writeFileSync(join(context.location.directory, "s3-proof.json"), JSON.stringify(value));
        await context.session.hook("generate", async (draft: any) => {
            if (text(draft) === "S3_WARMING") warmingBefore = JSON.stringify(draft);
        });
        const executor = await createV2HiddenCompletionExecutor(context.session, async (sessionID) => {
            const session = await context.session.get({ sessionID });
            return session.model ? { providerID: session.model.providerID, modelID: session.model.id } : null;
        });
        await context.session.hook("generate", async (draft: any) => {
            const command = text(draft);
            if (command === calibrationPrompt && calibrationSystem) { draft.system = structuredClone(calibrationSystem); return; }
            if (command === "S3_WARMING") { save({ before: warmingBefore, after: JSON.stringify(draft) }); return; }
            if (command !== "S3_HISTORIAN" && command !== "S3_MODEL_REFUSE" && command !== "S3_TOOLS_REFUSE" && command !== "S3_COMPRESS" && command !== "S3_CALIBRATE_OWN" && command !== "S3_CALIBRATE_SESSION") return;
            const db = openDatabase();
            if (!db) throw new Error("Proof database did not open");
            if (command === "S3_CALIBRATE_OWN" || command === "S3_CALIBRATE_SESSION") {
                calibrationSystem = command === "S3_CALIBRATE_SESSION" ? structuredClone(draft.system) : undefined;
                try {
                    const result = await runValidatedHistorianPass({ client: undefined, hiddenCompletionExecutor: executor, db, parentSessionId: draft.sessionID, sessionDirectory: context.location.directory, prompt: calibrationPrompt, chunk: calibrationChunk, priorCompartments: [], sequenceOffset: 0, dumpLabelBase: "calibration", timeoutMs: 10000 });
                    save({ ok: result.ok, error: result.ok ? null : result.error });
                } finally { calibrationSystem = undefined; }
            } else if (command === "S3_MODEL_REFUSE") {
                try {
                    await executor.open({ parentSessionId: draft.sessionID, agent: "historian", kind: "historian", system: "bounded system", model: "openai/cheap", configuredModels: ["openai/cheap"], timeoutMs: 5000, title: "proof", directory: context.location.directory });
                    save({ unexpected: "model accepted" });
                } catch (error) { save({ error: String(error), code: (error as any).code }); }
            } else if (command === "S3_COMPRESS") {
                const project = context.location.directory;
                const id = insertMemory(db, { projectPath: project, category: "ARCHITECTURE", content: "The fold uses stable source ordinals.", sourceSessionId: draft.sessionID });
                const execute = createDreamTaskExecutor({ sessionDirectory: project, parentSessionId: draft.sessionID, hiddenCompletionExecutor: executor, openOpenCodeDb: () => null, mural: { enabled: true } });
                const result = await execute({ task: "compress-cues", schedule: "0 4 * * *", timeoutMinutes: 5 }, { db, projectIdentity: project, holderId: "s3-cues", leaseKey: leaseKeyFor("compress-cues", project) });
                save({ id, result, rows: getDreamRuns(db, project), cues: db.prepare("SELECT mural_cue FROM memories WHERE project_path = ?").all(project) });
            } else if (command === "S3_TOOLS_REFUSE") {
                const project = context.location.directory;
                let dispatches = 0;
                const forbiddenClient = new Proxy({}, { get() { dispatches++; throw new Error("Unexpected child transport dispatch"); } });
                const execute = createDreamTaskExecutor({ client: forbiddenClient as never, sessionDirectory: project, parentSessionId: draft.sessionID, hiddenCompletionExecutor: executor, openOpenCodeDb: () => null });
                const result = await execute({ task: "curate", schedule: "0 4 * * 0", timeoutMinutes: 1 }, { db, projectIdentity: project, holderId: "s3-proof-dreamer", leaseKey: leaseKeyFor("curate", project) });
                save({ result, rows: getDreamRuns(db, project), dispatches });
            } else {
                const reader = new V2StoreReader(gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"));
                const source = rawMessages(reader.history(draft.sessionID));
                reader.close();
                const release = setRawMessageProvider(draft.sessionID, { readMessages: () => source });
                const holder = "s3-proof-historian";
                if (!acquireCompartmentLease(db, draft.sessionID, holder)) throw new Error("proof lease unavailable");
                try {
                    const plan = resolveWrapupProtectedTailBoundary({ db, sessionId: draft.sessionID, mode: "manual-wrapup", contextLimit: 16000, executeThresholdPercentage: 65, usage: { percentage: 0, inputTokens: 100 }, usageSource: "live", messagesToKeep: 1 });
                    await runCompartmentAgent({ client: undefined, hiddenCompletionExecutor: executor, compactionMarkerStrategy: v2CompactionMarkerStrategy, db, sessionId: draft.sessionID, directory: context.location.directory, historianChunkTokens: 20000, historianTimeoutMs: 10000, boundarySnapshot: plan.snapshot, compartmentLeaseHolderId: holder, forceKeepLastCompartment: true, forceDrainQuota: true, memoryEnabled: false });
                    save({ source, boundary: plan.snapshot, compartments: getCompartments(db, draft.sessionID), runs: db.prepare("SELECT harness, status FROM historian_runs WHERE session_id = ?").all(draft.sessionID), markers: db.prepare("SELECT compaction_marker_state, pending_compaction_marker_state FROM session_meta WHERE session_id = ? AND (coalesce(compaction_marker_state, '') != '' OR pending_compaction_marker_state IS NOT NULL)").all(draft.sessionID) });
                } finally { release(); releaseCompartmentLease(db, draft.sessionID, holder); }
            }
            // The probe's outer generate is a control request, not a second completion.
            throw new Error("S3_PROOF_COMPLETE");
        });
    },
};

import { describe, expect, it } from "bun:test";

import { MagicContextConfigSchema } from "../../../config/schema/magic-context";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { buildDreamTaskRuntimeConfigs } from "./task-config";
import { evaluateTaskGate } from "./task-gates";

describe("per-harness dream task runtime config", () => {
    it("defaults partial promotion task blocks and preserves explicit and absent task defaults", () => {
        const parsed = MagicContextConfigSchema.parse({
            dreamer: {
                tasks: {
                    "promote-primers": { schedule: "15 8 * * *" },
                    "review-user-memories": { schedule: "15 8 * * *" },
                },
            },
        });
        expect(parsed.dreamer.tasks["promote-primers"].promotion_threshold).toBe(2);
        expect(parsed.dreamer.tasks["review-user-memories"].promotion_threshold).toBe(3);
        expect(
            MagicContextConfigSchema.parse({
                dreamer: {
                    tasks: {
                        "promote-primers": { schedule: "15 8 * * *", promotion_threshold: 4 },
                        "review-user-memories": {
                            schedule: "15 8 * * *",
                            promotion_threshold: 5,
                        },
                    },
                },
            }).dreamer.tasks["promote-primers"].promotion_threshold,
        ).toBe(4);
        expect(
            MagicContextConfigSchema.parse({
                dreamer: {
                    tasks: {
                        "review-user-memories": {
                            schedule: "15 8 * * *",
                            promotion_threshold: 5,
                        },
                    },
                },
            }).dreamer.tasks["review-user-memories"].promotion_threshold,
        ).toBe(5);
        const defaults = MagicContextConfigSchema.parse({ dreamer: { tasks: {} } }).dreamer.tasks;
        expect(defaults["promote-primers"].promotion_threshold).toBe(2);
        expect(defaults["review-user-memories"].promotion_threshold).toBe(3);
    });

    it("threads promotion defaults from parsed config into runtime gate values", () => {
        const dreamer = MagicContextConfigSchema.parse({
            dreamer: {
                tasks: {
                    "promote-primers": { schedule: "15 8 * * *" },
                    "review-user-memories": { schedule: "15 8 * * *" },
                },
            },
        }).dreamer;
        const configs = buildDreamTaskRuntimeConfigs(dreamer, "opencode");
        expect(configs.find((entry) => entry.task === "promote-primers")?.promotionThreshold).toBe(
            2,
        );
        expect(
            configs.find((entry) => entry.task === "review-user-memories")?.promotionThreshold,
        ).toBe(3);

        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);
            const projectIdentity = "/repo/two-primer-candidates";
            for (let index = 0; index < 2; index += 1) {
                db.prepare(`INSERT INTO primer_candidates
                    (project_path, harness, session_id, question, normalized_question,
                     source_message_time, created_at)
                    VALUES (?, 'opencode', ?, ?, ?, ?, ?)`).run(
                    projectIdentity,
                    `s${index}`,
                    `question ${index}`,
                    `question ${index}`,
                    (index + 1) * 86_400_000,
                    Date.now(),
                );
            }
            const threshold = configs.find(
                (entry) => entry.task === "promote-primers",
            )?.promotionThreshold;
            expect(threshold).toBe(2);
            expect(
                evaluateTaskGate("promote-primers", {
                    db,
                    projectIdentity,
                    lastRunAt: null,
                    promotionThreshold: threshold,
                }),
            ).toBe(true);
        } finally {
            db.close();
        }
    });
    it("applies the 20-minute default independently in each harness", () => {
        const dreamer = {
            tasks: {
                verify: { schedule: "0 3 * * *" },
                curate: { schedule: "0 4 * * *" },
            },
            opencode: {
                model: "anthropic/claude-sonnet",
                tasks: { verify: { timeout_minutes: 35 } },
            },
            pi: {
                model: "github-copilot/gpt-5",
                tasks: { curate: { timeout_minutes: 27 } },
            },
        };

        const opencode = buildDreamTaskRuntimeConfigs(dreamer, "opencode");
        const pi = buildDreamTaskRuntimeConfigs(dreamer, "pi");
        const timeout = (
            configs: ReturnType<typeof buildDreamTaskRuntimeConfigs>,
            task: "verify" | "curate",
        ) => configs.find((config) => config.task === task)?.timeoutMinutes;

        expect(timeout(opencode, "verify")).toBe(35);
        expect(timeout(pi, "verify")).toBe(20);
        expect(timeout(opencode, "curate")).toBe(20);
        expect(timeout(pi, "curate")).toBe(27);
    });

    it("threads retrospective recency metadata into both harness runtimes", () => {
        const dreamer = {
            tasks: {
                retrospective: { schedule: "0 5 * * *", recency_days: 14 },
            },
        };

        for (const harness of ["opencode", "pi"] as const) {
            const retrospective = buildDreamTaskRuntimeConfigs(dreamer, harness).find(
                (config) => config.task === "retrospective",
            );
            expect(retrospective?.retrospectiveRecencyDays).toBe(14);
        }
    });
});

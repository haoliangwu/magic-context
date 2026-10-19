/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    buildPrimerClusters,
    clusterEligibleForPromotion,
    summarizePrimerCluster,
} from "./primer-clustering";
import type { PrimerCandidate } from "./storage-primers";

function candidate(overrides: Partial<PrimerCandidate>): PrimerCandidate {
    return {
        id: overrides.id ?? 1,
        projectPath: overrides.projectPath ?? "git:abc",
        harness: overrides.harness ?? "opencode",
        sessionId: overrides.sessionId ?? "ses",
        question: overrides.question ?? "How does caching work?",
        normalizedQuestion: overrides.normalizedQuestion ?? "how does caching work",
        sourceCompartmentStart: overrides.sourceCompartmentStart ?? 1,
        sourceCompartmentEnd: overrides.sourceCompartmentEnd ?? 5,
        sourceStartMessageId: overrides.sourceStartMessageId ?? `start_${overrides.id ?? 1}`,
        sourceEndMessageId: overrides.sourceEndMessageId ?? `end_${overrides.id ?? 1}`,
        sourceMessageTime: overrides.sourceMessageTime ?? Date.UTC(2026, 0, 1),
        questionEmbedding: overrides.questionEmbedding ?? new Float32Array([1, 0]),
        questionEmbeddingModelId: overrides.questionEmbeddingModelId ?? "model-a",
        createdAt: overrides.createdAt ?? Date.UTC(2026, 0, 1),
    };
}

describe("primer clustering", () => {
    it("counts recurrence by unique UTC occurrence days, not raw candidate rows", () => {
        const clusters = buildPrimerClusters({
            activePrimers: [],
            candidates: [
                candidate({
                    id: 2,
                    sourceMessageTime: Date.UTC(2026, 0, 8),
                    sourceStartMessageId: "s2",
                    sourceEndMessageId: "e2",
                }),
                candidate({
                    id: 1,
                    sourceMessageTime: Date.UTC(2026, 0, 1),
                    sourceStartMessageId: "s1",
                    sourceEndMessageId: "e1",
                }),
                candidate({
                    id: 3,
                    sourceMessageTime: Date.UTC(2026, 0, 1, 12),
                    sourceStartMessageId: "s3",
                    sourceEndMessageId: "e3",
                }),
            ],
        });

        expect(clusters).toHaveLength(1);
        const summary = summarizePrimerCluster(clusters[0]);
        expect(summary.support).toBe(2);
        expect(summary.spanDays).toBe(7);
        expect(clusterEligibleForPromotion(summary, 2, 7)).toBe(true);
    });

    it("orders candidates by Unicode code unit, including separators and accents", () => {
        const clusters = buildPrimerClusters({
            activePrimers: [],
            candidates: [
                candidate({ id: 1, sourceStartMessageId: "s10", sourceEndMessageId: "a" }),
                candidate({ id: 2, sourceStartMessageId: "s1", sourceEndMessageId: "a" }),
                candidate({ id: 3, sourceStartMessageId: "a", sourceEndMessageId: "a" }),
                candidate({ id: 4, sourceStartMessageId: "A", sourceEndMessageId: "a" }),
                candidate({ id: 5, sourceStartMessageId: "é", sourceEndMessageId: "a" }),
                candidate({ id: 6, sourceStartMessageId: "z", sourceEndMessageId: "a" }),
            ],
        });

        expect(clusters).toHaveLength(1);
        expect(clusters[0].candidates.map((item) => item.id)).toEqual([4, 3, 2, 1, 6, 5]);
    });

    it("is deterministic regardless of input order", () => {
        const inputs = [
            candidate({ id: 1, sourceStartMessageId: "a", sourceEndMessageId: "b" }),
            candidate({ id: 2, sourceStartMessageId: "c", sourceEndMessageId: "d" }),
            candidate({
                id: 3,
                questionEmbedding: new Float32Array([0, 1]),
                normalizedQuestion: "how do leases work",
                sourceStartMessageId: "e",
                sourceEndMessageId: "f",
            }),
        ];
        const a = buildPrimerClusters({ activePrimers: [], candidates: inputs });
        const b = buildPrimerClusters({ activePrimers: [], candidates: inputs.slice().reverse() });

        expect(a.map((cluster) => cluster.candidates.map((c) => c.id))).toEqual(
            b.map((cluster) => cluster.candidates.map((c) => c.id)),
        );
    });

    it("keeps Primers cache-neutral in v1", () => {
        const inject = readFileSync(
            join(import.meta.dir, "../../hooks/magic-context/inject-compartments.ts"),
            "utf8",
        );
        expect(inject).not.toContain("primer");
        expect(inject).not.toContain("Primer");
    });
});

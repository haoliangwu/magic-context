import { cosineSimilarity } from "./memory/cosine-similarity";
import type { Primer, PrimerCandidate } from "./storage-primers";
import { primerOccurrenceKey, primerOccurrenceUtcDay } from "./storage-primers";

export const PRIMER_CLUSTER_THRESHOLD = 0.85;
export const PRIMER_CLUSTER_HYSTERESIS = 0.02;
export const PRIMER_PROMOTION_THRESHOLD = 2;
export const PRIMER_MIN_SPAN_DAYS = 7;

export interface PrimerCluster {
    primer: Primer | null;
    candidates: PrimerCandidate[];
    centroid: Float32Array | null;
    modelId: string | null;
}

export interface PrimerClusterSummary {
    candidates: PrimerCandidate[];
    support: number;
    spanDays: number;
    lastObservedAt: number;
    sourceCandidateIds: number[];
    centroid: Float32Array | null;
    modelId: string | null;
}

function cloneVector(vector: Float32Array | null): Float32Array | null {
    return vector ? new Float32Array(vector) : null;
}

function averageVectors(vectors: Float32Array[]): Float32Array | null {
    if (vectors.length === 0) return null;
    const dims = vectors[0].length;
    if (dims === 0) return null;
    const out = new Float32Array(dims);
    for (const vector of vectors) {
        if (vector.length !== dims) return null;
        for (let i = 0; i < dims; i += 1) out[i] += vector[i];
    }
    for (let i = 0; i < dims; i += 1) out[i] /= vectors.length;
    return out;
}

function candidateSortKey(candidate: PrimerCandidate): string {
    return `${primerOccurrenceKey(candidate)}\u001f${candidate.id}`;
}

function sameEmbeddingSpace(candidate: PrimerCandidate, modelId: string | null): boolean {
    return Boolean(
        candidate.questionEmbedding &&
            candidate.questionEmbeddingModelId &&
            modelId &&
            candidate.questionEmbeddingModelId === modelId,
    );
}

function candidateAlreadyInPrimer(candidate: PrimerCandidate, primer: Primer): boolean {
    return primer.sourceCandidateIds.includes(candidate.id);
}

function recomputeClusterCentroid(cluster: PrimerCluster): void {
    const modelId = cluster.modelId;
    const vectors = cluster.candidates
        .filter((candidate) => sameEmbeddingSpace(candidate, modelId))
        .map((candidate) => candidate.questionEmbedding)
        .filter((vector): vector is Float32Array => Boolean(vector));
    if (vectors.length > 0) {
        cluster.centroid = averageVectors(vectors);
        return;
    }
    if (cluster.primer?.questionEmbedding) {
        cluster.centroid = cloneVector(cluster.primer.questionEmbedding);
    }
}

function normalizedTextMatches(candidate: PrimerCandidate, cluster: PrimerCluster): boolean {
    const first = cluster.candidates[0];
    if (first) return first.normalizedQuestion === candidate.normalizedQuestion;
    return cluster.primer?.question.toLowerCase().trim() === candidate.normalizedQuestion;
}

export function buildPrimerClusters(args: {
    candidates: PrimerCandidate[];
    activePrimers: Primer[];
    threshold?: number;
    hysteresis?: number;
}): PrimerCluster[] {
    const threshold = args.threshold ?? PRIMER_CLUSTER_THRESHOLD;
    const hysteresis = args.hysteresis ?? PRIMER_CLUSTER_HYSTERESIS;
    const clusters: PrimerCluster[] = args.activePrimers
        .slice()
        .sort((a, b) => a.id - b.id)
        .map((primer) => ({
            primer,
            candidates: [],
            centroid: cloneVector(primer.questionEmbedding),
            modelId: primer.questionEmbeddingModelId,
        }));

    // Code-unit order keeps U+001F significant, so "s1\u001fa" precedes "s10\u001fa".
    const sorted = args.candidates.slice().sort((a, b) => {
        const left = candidateSortKey(a);
        const right = candidateSortKey(b);
        return left < right ? -1 : left > right ? 1 : 0;
    });

    for (const candidate of sorted) {
        let best: { cluster: PrimerCluster; score: number } | null = null;
        for (const cluster of clusters) {
            let score = Number.NEGATIVE_INFINITY;
            if (
                candidate.questionEmbedding &&
                cluster.centroid &&
                sameEmbeddingSpace(candidate, cluster.modelId)
            ) {
                score = cosineSimilarity(candidate.questionEmbedding, cluster.centroid);
            } else if (normalizedTextMatches(candidate, cluster)) {
                score = 1;
            }
            const stickierThreshold =
                cluster.primer && candidateAlreadyInPrimer(candidate, cluster.primer)
                    ? threshold - hysteresis
                    : threshold;
            if (score >= stickierThreshold && (!best || score > best.score)) {
                best = { cluster, score };
            }
        }

        if (best) {
            best.cluster.candidates.push(candidate);
            recomputeClusterCentroid(best.cluster);
            continue;
        }

        clusters.push({
            primer: null,
            candidates: [candidate],
            centroid: cloneVector(candidate.questionEmbedding),
            modelId: candidate.questionEmbeddingModelId,
        });
    }

    return clusters;
}

export function summarizePrimerCluster(cluster: PrimerCluster): PrimerClusterSummary {
    const occurrenceByDay = new Map<string, PrimerCandidate>();
    const byKey = new Map<string, PrimerCandidate>();
    for (const candidate of cluster.candidates) {
        const key = primerOccurrenceKey(candidate);
        if (!byKey.has(key)) byKey.set(key, candidate);
    }
    for (const candidate of byKey.values()) {
        const day = primerOccurrenceUtcDay(candidate.sourceMessageTime);
        const existing = occurrenceByDay.get(day);
        if (!existing || candidate.sourceMessageTime < existing.sourceMessageTime) {
            occurrenceByDay.set(day, candidate);
        }
    }
    const distinct = [...occurrenceByDay.values()].sort(
        (a, b) => a.sourceMessageTime - b.sourceMessageTime || a.id - b.id,
    );
    const first = distinct[0]?.sourceMessageTime ?? 0;
    const last = distinct[distinct.length - 1]?.sourceMessageTime ?? first;
    const supportIds = new Set<number>(cluster.primer?.sourceCandidateIds ?? []);
    for (const candidate of cluster.candidates) supportIds.add(candidate.id);
    return {
        candidates: cluster.candidates,
        support: distinct.length,
        spanDays: distinct.length <= 1 ? 0 : Math.floor((last - first) / (24 * 60 * 60 * 1000)),
        lastObservedAt: last || Date.now(),
        sourceCandidateIds: [...supportIds].sort((a, b) => a - b),
        centroid: cluster.centroid,
        modelId: cluster.modelId,
    };
}

export function clusterEligibleForPromotion(
    summary: PrimerClusterSummary,
    threshold = PRIMER_PROMOTION_THRESHOLD,
    minSpanDays = PRIMER_MIN_SPAN_DAYS,
): boolean {
    return summary.support >= threshold && summary.spanDays >= minSpanDays;
}

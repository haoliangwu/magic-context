/** Assign whole files longest-first using per-file seconds to balance total duration across runners. */
export function selectWeightedShard(files: string[], spec: string, seconds: Record<string, number>, fallbackSeconds?: number): string[] {
    const match = /^(\d+)\/(\d+)$/.exec(spec);
    if (!match) throw new Error(`invalid shard: ${spec} (expected i/n)`);
    const index = Number(match[1]);
    const count = Number(match[2]);
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || count < 1 || count > files.length || index >= count) {
        throw new Error(`invalid shard: ${spec} (expected 0 <= i < n <= file count)`);
    }
    if (new Set(files).size !== files.length) throw new Error("duplicate shard input file");
    const measured = Object.values(seconds).sort((a, b) => a - b);
    if (measured.length === 0 || measured.some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new Error("shard durations must be positive finite seconds");
    }
    const fallback = fallbackSeconds ?? measured[Math.floor(measured.length / 2)]!;
    if (!Number.isFinite(fallback) || fallback <= 0) throw new Error("fallback duration must be positive finite seconds");
    const weight = (file: string) => seconds[file] ?? fallback;
    const ordered = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
    const shards = Array.from({ length: count }, () => ({ files: [] as string[], seconds: 0 }));
    for (const file of ordered) {
        const lightest = shards.reduce((best, shard) => shard.seconds < best.seconds ? shard : best);
        lightest.files.push(file);
        lightest.seconds += weight(file);
    }
    return shards[index]!.files.sort();
}

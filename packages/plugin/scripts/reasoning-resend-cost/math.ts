/** Offline regression only: negative residuals are evidence, not values to clamp away. */
export interface Observation {
    session: string;
    x: number;
    y: number;
    body: number;
    wrappers: number;
}

export function quantile(values: number[], p: number): number | null {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const at = (sorted.length - 1) * p;
    const lo = Math.floor(at);
    return sorted[lo] + (sorted[Math.ceil(at)] - sorted[lo]) * (at - lo);
}

export function exampleIndices(length: number): number[] {
    if (length <= 0) return [];
    return [...new Set([0.1, 0.5, 0.9].map((p) => Math.round((length - 1) * p)))];
}

export function fit(rows: Observation[]) {
    if (rows.length < 3) return null;
    const mx = rows.reduce((a, b) => a + b.x, 0) / rows.length;
    const my = rows.reduce((a, b) => a + b.y, 0) / rows.length;
    const sxx = rows.reduce((a, b) => a + (b.x - mx) ** 2, 0);
    if (sxx === 0) return null;
    const k = rows.reduce((a, b) => a + (b.x - mx) * (b.y - my), 0) / sxx;
    const c = my - k * mx;
    const residuals = rows.map((b) => b.y - k * b.x - c);
    const sse = residuals.reduce((a, b) => a + b * b, 0);
    const syy = rows.reduce((a, b) => a + (b.y - my) ** 2, 0);
    // Session-cluster sandwich SE handles overlapping pairs and within-session correlation.
    const scores = new Map<string, number>();
    rows.forEach((b, i) => {
        scores.set(b.session, (scores.get(b.session) ?? 0) + (b.x - mx) * residuals[i]);
    });
    const clusters = scores.size;
    const se = clusters < 2 ? null : Math.sqrt(
        [...scores.values()].reduce((a, b) => a + b * b, 0) / (sxx * sxx) *
        (clusters / (clusters - 1)) * ((rows.length - 1) / (rows.length - 2)),
    );
    // Uniform and adversarial sensitivity to an assumed 20% body error. The latter
    // lets each error take the sign most damaging to k, plus all guessed wrappers.
    const uniformBodyShift = rows.reduce((a, b) => a + (b.x - mx) * b.body * 0.2, 0) / sxx;
    const adversarialShift = rows.reduce(
        (a, b) => a + Math.abs(b.x - mx) * (b.body * 0.2 + b.wrappers), 0,
    ) / sxx;
    return {
        n: rows.length, sessions: clusters, k, c,
        cluster95: se === null ? null : [k - 1.96 * se, k + 1.96 * se],
        r2: syy === 0 ? null : 1 - sse / syy,
        residualQ10Q50Q90: [0.1, 0.5, 0.9].map((p) => quantile(residuals, p)),
        ratioQ10Q50Q90: [0.1, 0.5, 0.9].map((p) => quantile(rows.filter((r) => r.x >= 64).map((r) => r.y / r.x), p)),
        medianBody: quantile(rows.map((r) => r.body), 0.5),
        uniform20PercentBodyShift: uniformBodyShift,
        adversarial20PercentBodyAndWrappersShift: adversarialShift,
    };
}

/** y = k * latest + h * previous + c; h near -k suggests latest-only replacement. */
export function fitLag(rows: Array<Observation & { previous: number }>) {
    if (rows.length < 5) return null;
    const means = ["x", "previous", "y"].map((key) => rows.reduce(
        (a, b) => a + b[key as "x" | "previous" | "y"], 0,
    ) / rows.length);
    let xx = 0, pp = 0, xp = 0, xy = 0, py = 0;
    for (const b of rows) {
        const x = b.x - means[0], p = b.previous - means[1], y = b.y - means[2];
        xx += x * x; pp += p * p; xp += x * p; xy += x * y; py += p * y;
    }
    const det = xx * pp - xp * xp;
    if (det <= 1e-10) return null;
    const k = (xy * pp - py * xp) / det;
    const h = (py * xx - xy * xp) / det;
    return { n: rows.length, k, h, c: means[2] - k * means[0] - h * means[1] };
}

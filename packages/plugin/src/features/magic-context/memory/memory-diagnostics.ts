import type { MemoryImportanceHistogram } from "../../../shared/rpc-types";
import type { Database } from "../../../shared/sqlite";

export function emptyMemoryImportanceHistogram(): MemoryImportanceHistogram {
    return {
        total: 0,
        unclassified: 0,
        bands: {
            "0-19": 0,
            "20-39": 0,
            "40-59": 0,
            "60-79": 0,
            "80-100": 0,
        },
    };
}

interface HistogramRow {
    total: number;
    unclassified: number;
    band_0_19: number;
    band_20_39: number;
    band_40_59: number;
    band_60_79: number;
    band_80_100: number;
}

function readHistogramRow(
    db: Database,
    projectPath: string,
    classifiedColumn: boolean,
): HistogramRow {
    const unclassified = classifiedColumn
        ? "SUM(CASE WHEN classified_at IS NULL THEN 1 ELSE 0 END)"
        : "COUNT(*)";
    return db
        .prepare<[string], HistogramRow>(
            `SELECT COUNT(*) AS total,
                    ${unclassified} AS unclassified,
                    SUM(CASE WHEN COALESCE(importance, 50) BETWEEN 0 AND 19 THEN 1 ELSE 0 END) AS band_0_19,
                    SUM(CASE WHEN COALESCE(importance, 50) BETWEEN 20 AND 39 THEN 1 ELSE 0 END) AS band_20_39,
                    SUM(CASE WHEN COALESCE(importance, 50) BETWEEN 40 AND 59 THEN 1 ELSE 0 END) AS band_40_59,
                    SUM(CASE WHEN COALESCE(importance, 50) BETWEEN 60 AND 79 THEN 1 ELSE 0 END) AS band_60_79,
                    SUM(CASE WHEN COALESCE(importance, 50) BETWEEN 80 AND 100 THEN 1 ELSE 0 END) AS band_80_100
               FROM memories
              WHERE project_path = ? AND status = 'active'`,
        )
        .get(projectPath) as HistogramRow;
}

/** Read the ACTIVE pool only; permanent/archived rows do not enter the denominator. */
export function getActiveMemoryImportanceHistogram(
    db: Database,
    projectPath: string,
): MemoryImportanceHistogram {
    let row: HistogramRow;
    try {
        row = readHistogramRow(db, projectPath, true);
    } catch (error) {
        if (!String(error).includes("no such column: classified_at")) throw error;
        // A pre-classification schema has no evidence that any row was classified.
        row = readHistogramRow(db, projectPath, false);
    }
    return {
        total: Number(row.total ?? 0),
        unclassified: Number(row.unclassified ?? 0),
        bands: {
            "0-19": Number(row.band_0_19 ?? 0),
            "20-39": Number(row.band_20_39 ?? 0),
            "40-59": Number(row.band_40_59 ?? 0),
            "60-79": Number(row.band_60_79 ?? 0),
            "80-100": Number(row.band_80_100 ?? 0),
        },
    };
}

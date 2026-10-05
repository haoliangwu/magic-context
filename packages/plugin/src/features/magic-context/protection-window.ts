import type { Database } from "../../shared/sqlite";
import { sessionDecisionCalibration } from "./session-decision-calibration";
import { TAG_SELECT_COLUMNS } from "./storage-tags";

export type CoordinateSpace = "tag-number" | "row-identity";

export interface ProtectionWindowRow {
    tag_number?: number;
    tagNumber?: number;
    row_identity?: number | string;
    id?: number | string;
    kind?: string;
    type?: string;
    token_count?: number | null;
    tokenCount?: number | null;
    input_token_count?: number | null;
    inputTokenCount?: number | null;
    status?: string;
    message_id?: string;
    messageId?: string;
}

export interface TagNumberProjection {
    coordinateSpace: "tag-number";
    tagNumbers: Set<number>;
}

export interface RowIdentityProjection<T = number | string> {
    coordinateSpace: "row-identity";
    rowIdentities: Set<T>;
}

export interface OrdinalCutoffProjection {
    coordinateSpace: "tag-number";
    cutoff: number | null;
}

export interface ProtectionWindowStatus {
    floor: number;
    protectedCount: number;
    protectedMass: number;
}

export interface ProtectionWindowResult<TRow = ProtectionWindowRow, TIdentity = number | string> {
    memberRows: TRow[];
    memberRowKeys: Set<string>;
    tagNumberSet: TagNumberProjection;
    rowIdentitySet: RowIdentityProjection<TIdentity>;
    ordinalCutoff: OrdinalCutoffProjection;
    cutoff: number | null;
    protectedTagNumbers: Set<number>;
    protectedRowIdentities: Set<TIdentity>;
    status: ProtectionWindowStatus;
    isProtected: (row: ProtectionWindowRow) => boolean;
}

/**
 * Window mass unit is COALESCE(token_count, 0) only — input_token_count is excluded.
 * This single shared helper computes the mass contribution of a walked row.
 */
export function rowWindowMass(row: ProtectionWindowRow): number {
    const raw = row.token_count ?? row.tokenCount;
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
        return raw;
    }
    return 0;
}

export function getRowKind(row: ProtectionWindowRow): string {
    return (row.kind ?? row.type ?? "").toLowerCase();
}

export function getRowTagNumber(row: ProtectionWindowRow): number {
    const num = row.tag_number ?? row.tagNumber;
    if (typeof num === "number" && Number.isFinite(num)) {
        return num;
    }
    return 0;
}

export function getRowIdentity(row: ProtectionWindowRow): number | string {
    const id = row.row_identity ?? row.id;
    if (id !== undefined && id !== null) {
        return id;
    }
    return getRowTagNumber(row);
}

export function rowKey(row: ProtectionWindowRow): string {
    return `${getRowTagNumber(row)}:${getRowIdentity(row)}`;
}

export function compareRowsAscending(a: ProtectionWindowRow, b: ProtectionWindowRow): number {
    const tagDiff = getRowTagNumber(a) - getRowTagNumber(b);
    if (tagDiff !== 0) return tagDiff;
    const idA = getRowIdentity(a);
    const idB = getRowIdentity(b);
    if (typeof idA === "number" && typeof idB === "number") {
        return idA - idB;
    }
    return String(idA).localeCompare(String(idB));
}

/**
 * Pure canonical protection window walk.
 *
 * Traversal: deterministic total order ascending (tag_number, row_identity) walked in REVERSE.
 * Mass accumulation: COALESCE(token_count, 0) accumulated until sum >= floor.
 * Stop: tie-group atomic (a whole duplicate-tag_number group is accumulated before testing floor).
 * Structural minimum: newest min(3, N) tool-kind tags by tag_number descending.
 * Cutoff: min(mass_cutoff, newest3_cutoff).
 * Canonical membership: union row set (all tool rows with tag_number >= cutoff).
 */
export function computeProtectionWindow<TRow extends ProtectionWindowRow = ProtectionWindowRow>(
    rows: readonly TRow[],
    floor: number,
    toolsRatio = 1,
): ProtectionWindowResult<TRow> {
    // Only persisted TOOL rows are considered
    const toolRows = rows.filter((r) => getRowKind(r) === "tool");

    if (toolRows.length === 0) {
        return {
            memberRows: [],
            memberRowKeys: new Set<string>(),
            tagNumberSet: { coordinateSpace: "tag-number", tagNumbers: new Set<number>() },
            rowIdentitySet: {
                coordinateSpace: "row-identity",
                rowIdentities: new Set<number | string>(),
            },
            ordinalCutoff: { coordinateSpace: "tag-number", cutoff: null },
            cutoff: null,
            protectedTagNumbers: new Set<number>(),
            protectedRowIdentities: new Set<number | string>(),
            status: {
                floor,
                protectedCount: 0,
                protectedMass: 0,
            },
            isProtected: () => false,
        };
    }

    // Sort ascending by (tag_number, row_identity)
    const sortedAsc = [...toolRows].sort(compareRowsAscending);

    // Group into tie groups (rows sharing the same tag_number) in descending order (reverse traversal)
    const tieGroupsDescending: TRow[][] = [];
    let currentGroup: TRow[] = [];
    let currentTagNumber: number | null = null;

    for (let i = sortedAsc.length - 1; i >= 0; i--) {
        const row = sortedAsc[i];
        const tagNum = getRowTagNumber(row);
        if (currentTagNumber === null || tagNum === currentTagNumber) {
            currentGroup.push(row);
            currentTagNumber = tagNum;
        } else {
            tieGroupsDescending.push(currentGroup);
            currentGroup = [row];
            currentTagNumber = tagNum;
        }
    }
    if (currentGroup.length > 0) {
        tieGroupsDescending.push(currentGroup);
    }

    // Walk in reverse accumulating mass with tie-group atomic stop
    const massWindowRows: TRow[] = [];
    let cumulativeMass = 0;

    for (const group of tieGroupsDescending) {
        for (const row of group) {
            massWindowRows.push(row);
            cumulativeMass += rowWindowMass(row);
        }
        if (Math.ceil(cumulativeMass * toolsRatio) >= floor) {
            break;
        }
    }

    // The walk is descending, so the last row pushed carries the smallest tag_number. A spread
    // over the member list would hit the engine argument-count ceiling on sessions with tens of
    // thousands of tool tags.
    const mass_cutoff =
        massWindowRows.length > 0
            ? getRowTagNumber(massWindowRows[massWindowRows.length - 1] as TRow)
            : null;

    // Structural minimum: newest min(3, N) tool-kind tags by tag_number descending
    const distinctToolTagNumbers = tieGroupsDescending.map((g) => getRowTagNumber(g[0]));
    const minCount = Math.min(3, distinctToolTagNumbers.length);
    const newest3_cutoff = minCount > 0 ? distinctToolTagNumbers[minCount - 1] : null;

    // Exact cutoff by construction
    const cutoff =
        mass_cutoff !== null && newest3_cutoff !== null
            ? Math.min(mass_cutoff, newest3_cutoff)
            : (mass_cutoff ?? newest3_cutoff);

    // Canonical membership: tool rows with tag_number >= cutoff
    const memberRows =
        cutoff !== null ? sortedAsc.filter((row) => getRowTagNumber(row) >= cutoff) : [];

    const memberRowKeys = new Set(memberRows.map(rowKey));
    const protectedTagNumbers = new Set(memberRows.map(getRowTagNumber));
    const protectedRowIdentities = new Set(memberRows.map(getRowIdentity));

    const protectedCount = memberRows.length;
    const protectedMass = Math.ceil(
        memberRows.reduce((sum, row) => sum + rowWindowMass(row), 0) * toolsRatio,
    );

    const isProtected = (row: ProtectionWindowRow): boolean => {
        return getRowKind(row) === "tool" && cutoff !== null && getRowTagNumber(row) >= cutoff;
    };

    return {
        memberRows,
        memberRowKeys,
        tagNumberSet: {
            coordinateSpace: "tag-number",
            tagNumbers: protectedTagNumbers,
        },
        rowIdentitySet: {
            coordinateSpace: "row-identity",
            rowIdentities: protectedRowIdentities,
        },
        ordinalCutoff: {
            coordinateSpace: "tag-number",
            cutoff,
        },
        cutoff,
        protectedTagNumbers,
        protectedRowIdentities,
        status: {
            floor,
            protectedCount,
            protectedMass,
        },
        isProtected,
    };
}

/**
 * Read the snapshotted epoch floor from session_meta.
 * On defer passes this module reads the snapshot and never recomputes the floor.
 */
export function readEpochFloorSnapshot(db: Database, sessionId: string): number | null {
    try {
        const row = db
            .prepare("SELECT protected_tokens_effective FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { protected_tokens_effective?: number | null } | undefined;
        if (
            row &&
            typeof row.protected_tokens_effective === "number" &&
            Number.isFinite(row.protected_tokens_effective)
        ) {
            return row.protected_tokens_effective;
        }
    } catch {
        // Table or column may not exist in pre-migration database
    }
    return null;
}

/**
 * Read only the persisted tool suffix needed for protection. A tag-number group
 * can span pages, so test the stopping condition only when the next group starts.
 * Dropped rows still contribute to chronology and mass, just as in the pure walk.
 */
export function getProtectionWindowForSession(
    db: Database,
    sessionId: string,
    floor?: number | null,
): ProtectionWindowResult {
    const effectiveFloor =
        typeof floor === "number" && Number.isFinite(floor)
            ? floor
            : (readEpochFloorSnapshot(db, sessionId) ?? 0);

    const toolsRatio = sessionDecisionCalibration(db, sessionId).toolsRatio;
    const pageSize = 256;
    // Exclude the tool-owner partial index from planning: without ANALYZE it can
    // win over chronology and force a whole-session sort before each small page.
    const projection = `SELECT ${TAG_SELECT_COLUMNS} FROM tags
        WHERE session_id = ? AND +type = 'tool'`;
    const order = `ORDER BY tag_number DESC, id DESC LIMIT ${pageSize}`;
    let page = db.prepare(`${projection} ${order}`).all(sessionId) as ProtectionWindowRow[];
    const rows: ProtectionWindowRow[] = [];
    let mass = 0;
    let distinctTags = 0;
    let currentTag: number | null = null;

    while (page.length > 0) {
        for (const row of page) {
            const tagNumber = getRowTagNumber(row);
            if (tagNumber !== currentTag) {
                if (distinctTags >= 3 && Math.ceil(mass * toolsRatio) >= effectiveFloor) {
                    return computeProtectionWindow(rows, effectiveFloor, toolsRatio);
                }
                distinctTags++;
                currentTag = tagNumber;
            }
            rows.push(row);
            mass += rowWindowMass(row);
        }
        if (page.length < pageSize) break;
        const last = page[page.length - 1];
        page = db
            .prepare(`${projection} AND (tag_number, id) < (?, ?) ${order}`)
            .all(sessionId, getRowTagNumber(last), getRowIdentity(last)) as ProtectionWindowRow[];
    }

    return computeProtectionWindow(rows, effectiveFloor, toolsRatio);
}

/**
 * Workspace memory visibility and ownership, in one place.
 *
 * Two read/write predicates decide what a project may do with a memory row:
 *
 *  - VISIBLE (read): the project's own memories in every category, plus a
 *    workspace member's memories only while they are active, unexpired, marked
 *    shareable, scoped beyond the writing project, and in a category the
 *    workspace explicitly shares.
 *  - OWNED (mutate): only rows that resolve to this project's identity. A
 *    shared memory from another project is readable here and never writable
 *    here — sharing grants reading, not editing.
 *
 * The ctx_memory tool and the Rust-mode memory facade both need exactly these
 * predicates, and a second copy of the share policy would be a second place for
 * it to drift. Both import this factory instead.
 */

import type { Database } from "../../../shared/sqlite";
import {
    expandWorkspaceIdentitySetWithAliases,
    resolveStoredPathWorkspaceIdentity,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
    storedPathBelongsToWorkspace,
} from "../workspaces";
import { normalizeStoredProjectPath, storedPathBelongsToIdentity } from "./project-identity";

/** The memory fields the two predicates read. `Memory` satisfies this. */
export interface VisibilityCandidateMemory {
    projectPath: string;
    category: string;
    status: string;
    scope: string;
    /** SQLite INTEGER boolean: 1 = shareable, 0 = private. */
    shareable: number;
    expiresAt: number | null;
}

export interface MemoryVisibilityPolicy {
    /** True when this project is a member of a multi-project workspace. */
    readonly workspaced: boolean;
    /** Canonical workspace identity for a stored project path. */
    identityFor(storedProjectPath: string): string;
    /** READ contract: own memories always, foreign memories only when shared. */
    visible(memory: VisibilityCandidateMemory): boolean;
    /** WRITE contract: the row must resolve to this project's identity. */
    owned(memory: VisibilityCandidateMemory): boolean;
}

/**
 * Build the visibility/ownership predicates for `projectIdentity`.
 *
 * Reads the workspace membership, identity aliases and share categories once,
 * so a caller can classify a batch of ids without re-querying per row.
 */
export function createMemoryVisibilityPolicy(
    db: Database,
    projectIdentity: string,
): MemoryVisibilityPolicy {
    const identitySet = resolveWorkspaceIdentitySet(db, projectIdentity);
    const workspaced = identitySet.identities.length > 1;
    const expanded = expandWorkspaceIdentitySetWithAliases(db, identitySet.identities);
    const visibleIdentities = workspaced ? expanded.expandedIdentities : identitySet.identities;
    // The workspace's share-category policy matches the render path. null means
    // there is no workspace filter; a workspaced caller gets an explicit list
    // where [] shares no foreign categories.
    const shareCategories = workspaced
        ? resolveWorkspaceShareCategories(db, projectIdentity)
        : null;

    const identityFor = (storedProjectPath: string): string =>
        workspaced
            ? (resolveStoredPathWorkspaceIdentity(
                  storedProjectPath,
                  identitySet.identities,
                  expanded.canonicalIdentityByStoredPath,
              ) ?? normalizeStoredProjectPath(storedProjectPath))
            : normalizeStoredProjectPath(storedProjectPath);

    const owned = (memory: VisibilityCandidateMemory): boolean =>
        workspaced
            ? identityFor(memory.projectPath) === projectIdentity
            : storedPathBelongsToIdentity(memory.projectPath, projectIdentity);

    const visible = (memory: VisibilityCandidateMemory): boolean => {
        if (!workspaced) return storedPathBelongsToIdentity(memory.projectPath, projectIdentity);
        if (
            !storedPathBelongsToWorkspace(
                memory.projectPath,
                identitySet.identities,
                visibleIdentities,
                expanded.canonicalIdentityByStoredPath,
            )
        ) {
            return false;
        }
        if (identityFor(memory.projectPath) === projectIdentity) return true;
        return (
            (memory.status === "active" || memory.status === "permanent") &&
            (memory.expiresAt === null || memory.expiresAt > Date.now()) &&
            memory.shareable === 1 &&
            ["project", "ecosystem", "universe"].includes(memory.scope) &&
            (shareCategories?.includes(memory.category) ?? false)
        );
    };

    return { workspaced, identityFor, visible, owned };
}

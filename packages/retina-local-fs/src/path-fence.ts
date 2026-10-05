import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ProviderError } from "./errors";

export interface ResolveProviderPathOptions {
    allowMissing: boolean;
    homeDirectory?: string;
    dataDirectory?: string;
    cwd?: string;
}

export async function resolveAndFenceProviderPath(
    configuredPath: string,
    options: ResolveProviderPathOptions,
): Promise<string> {
    const { home, dataDirectory, aliases } = await resolveFenceRoots(options);
    const expanded = configuredPath.startsWith("~/")
        ? join(home, configuredPath.slice(2))
        : configuredPath === "~"
          ? home
          : configuredPath;
    const absolute = isAbsolute(expanded)
        ? resolve(expanded)
        : resolve(options.cwd ?? process.cwd(), expanded);
    const canonical = await canonicalPath(absolute, options.allowMissing);
    if (
        fenceCandidates(canonical, aliases).some((candidate) =>
            isFencedPath(candidate, home, dataDirectory),
        )
    ) {
        throw new ProviderError("fenced_path", `Refusing fenced path: ${canonical}`);
    }
    return canonical;
}

export async function revalidateProviderPath(
    canonicalPath: string,
    options: ResolveProviderPathOptions,
): Promise<string> {
    const revalidated = await resolveAndFenceProviderPath(canonicalPath, options);
    if (revalidated !== canonicalPath) {
        throw new ProviderError(
            "fenced_path",
            `Refusing path changed after fence check: ${canonicalPath}`,
        );
    }
    return revalidated;
}

/** Top-level CortexKit data directories whose contents are fenced. */
const FENCED_CORTEXKIT_ROOTS = ["plexus", "claustrum", "staging", "run", "magic-context"];

/**
 * A CortexKit location reached through a symlink: `logical` is where the fence
 * expects it (under the data directory), `canonical` is where it really is.
 */
interface FenceAlias {
    logical: string;
    canonical: string;
}

async function resolveFenceRoots(
    options: ResolveProviderPathOptions,
): Promise<{ home: string; dataDirectory: string; aliases: FenceAlias[] }> {
    const configuredHomePath = resolve(options.homeDirectory ?? process.env.HOME ?? homedir());
    let home: string;
    try {
        home = await realpath(configuredHomePath);
    } catch (error) {
        throw fsError(configuredHomePath, error);
    }

    // Runtime storage is rooted at XDG_DATA_HOME. Canonicalize the configured data
    // root before checking paths, so a symlinked data directory is checked by its real path.
    const configuredDataDirectory = resolve(
        options.dataDirectory ?? process.env.XDG_DATA_HOME ?? join(home, ".local", "share"),
    );
    const dataDirectory = await canonicalPath(configuredDataDirectory, true);

    // The watched path is fully resolved, so a `cortexkit` directory (or one of
    // its fenced roots) that is a symlink, common when data is moved to another
    // disk, resolves outside `<data>/cortexkit` and would skip the fence.
    // Record where each of them really lives so a resolved path can be mapped
    // back to its logical location before the fence check.
    const aliases: FenceAlias[] = [];
    const logicalCortexkit = join(dataDirectory, "cortexkit");
    for (const logical of [
        logicalCortexkit,
        ...FENCED_CORTEXKIT_ROOTS.map((root) => join(logicalCortexkit, root)),
    ]) {
        const canonical = await canonicalPath(logical, true);
        if (canonical !== logical) aliases.push({ logical, canonical });
    }
    return { home, dataDirectory, aliases };
}

/** The resolved path plus its logical location under every alias containing it. */
function fenceCandidates(canonical: string, aliases: readonly FenceAlias[]): string[] {
    const candidates = [canonical];
    for (const alias of aliases) {
        const relativeToAlias = relative(alias.canonical, canonical);
        const inside =
            relativeToAlias === "" ||
            (relativeToAlias !== ".." &&
                !relativeToAlias.startsWith(`..${sep}`) &&
                !isAbsolute(relativeToAlias));
        if (inside) candidates.push(join(alias.logical, relativeToAlias));
    }
    return candidates;
}

async function canonicalPath(path: string, allowMissing: boolean): Promise<string> {
    try {
        return await realpath(path);
    } catch (error) {
        if (!allowMissing || !isMissingError(error)) {
            throw fsError(path, error);
        }

        const suffix: string[] = [];
        let candidate = path;
        while (true) {
            try {
                const metadata = await lstat(candidate);
                if (metadata.isSymbolicLink()) {
                    const target = await readlink(candidate);
                    const resolvedTarget = resolve(dirname(candidate), target);
                    return canonicalPath(join(resolvedTarget, ...suffix), true);
                }
            } catch (candidateError) {
                if (!isMissingError(candidateError)) {
                    throw fsError(path, candidateError);
                }
            }

            const parent = dirname(candidate);
            if (parent === candidate) {
                throw fsError(path, error);
            }
            suffix.unshift(basename(candidate));
            candidate = parent;
            try {
                return join(await realpath(candidate), ...suffix);
            } catch (parentError) {
                if (!isMissingError(parentError)) {
                    throw fsError(path, parentError);
                }
            }
        }
    }
}

export function isFencedPath(
    canonicalPath: string,
    homeDirectory: string,
    dataDirectory = process.env.XDG_DATA_HOME ?? join(resolve(homeDirectory), ".local", "share"),
): boolean {
    const cortexkitRoot = join(resolve(dataDirectory), "cortexkit");
    const relativeToCortexkit = relative(cortexkitRoot, canonicalPath);
    const insideCortexkit =
        relativeToCortexkit !== "" &&
        relativeToCortexkit !== ".." &&
        !relativeToCortexkit.startsWith(`..${sep}`) &&
        !isAbsolute(relativeToCortexkit);
    const parts = insideCortexkit ? relativeToCortexkit.split(sep) : [];
    const pathParts = canonicalPath.split(sep).filter(Boolean);
    const name = basename(canonicalPath);

    const catalogDirectoryCarveIn = pathParts.includes("catalog");
    const moduleBinCarveIn = parts.length >= 2 && parts[1] === "bin";
    const catalogJsonCarveIn = name.endsWith(".json") && name.includes("catalog");
    const rootWithoutCarveIns =
        insideCortexkit && (parts[0] === "run" || parts[0] === "magic-context");
    if (
        !rootWithoutCarveIns &&
        (catalogDirectoryCarveIn || moduleBinCarveIn || catalogJsonCarveIn)
    ) {
        return false;
    }

    const inFencedRoot = insideCortexkit && FENCED_CORTEXKIT_ROOTS.includes(parts[0] ?? "");
    const fencedBasename = name.includes("binding-key") || name.endsWith(".handle");
    const plexusStore = insideCortexkit && parts[0] === "plexus" && name.startsWith("store.db");
    return inFencedRoot || fencedBasename || plexusStore;
}

function fsError(path: string, error: unknown): ProviderError {
    const message = error instanceof Error ? error.message : String(error);
    return new ProviderError("unreadable_path", `Could not read ${path}: ${message}`);
}

function isMissingError(error: unknown): boolean {
    return (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        ((error as { code?: unknown }).code === "ENOENT" ||
            (error as { code?: unknown }).code === "ENOTDIR")
    );
}

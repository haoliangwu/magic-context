import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { detectConfigFile, parseJsoncRecovering } from "../shared/jsonc-parser";
import {
    cortexKitProjectConfigBasePath,
    cortexKitUserConfigBasePath,
} from "./migrate-config-location";

export interface ConfigSnapshot<T> {
    readonly generation: number;
    readonly digest: string;
    readonly adoptedAt: number;
    readonly effective: T;
}

export interface ConfigReloadFailure {
    readonly path: string;
    readonly message: string;
    readonly digest: string;
}

interface FileState {
    metadata: string;
    digest: string;
}

/**
 * Publishes a project configuration only after the user and project files parse
 * and the loader assembles the final effective configuration successfully.
 */
export class LiveConfigReader<T> {
    private snapshot: ConfigSnapshot<T>;
    private files = new Map<string, FileState>();
    private initialized = false;
    private warned = new Set<string>();
    private failure: ConfigReloadFailure | undefined;

    constructor(
        private readonly directory: string,
        initial: T,
        private readonly load: () => T,
        // Callers pass the host's log sink; the default is silent so a caller that
        // forgets never writes into the host process's stderr.
        private readonly onLog: (message: string) => void = () => {},
        private readonly changedKeys: (previous: T, next: T) => readonly string[] = (
            previous,
            next,
        ) =>
            Object.keys(next as object).filter(
                (key) =>
                    JSON.stringify((previous as Record<string, unknown>)[key]) !==
                    JSON.stringify((next as Record<string, unknown>)[key]),
            ),
    ) {
        this.snapshot = {
            generation: 1,
            digest: "initial",
            adoptedAt: Date.now(),
            effective: initial,
        };
    }

    current(): ConfigSnapshot<T> {
        return this.snapshot;
    }

    lastFailure(): ConfigReloadFailure | undefined {
        return this.failure;
    }

    poll(): ConfigSnapshot<T> {
        const paths = [
            cortexKitUserConfigBasePath(),
            cortexKitProjectConfigBasePath(this.directory),
        ].map((base) => detectConfigFile(base).path);
        const next = new Map<string, FileState>();
        let changed = paths.some((path) => !this.files.has(path));
        for (const path of paths) {
            let metadata: string;
            try {
                const stat = statSync(path);
                metadata = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    this.reportFailure(path, String(error), error);
                    return this.snapshot;
                }
                metadata = "absent";
            }
            const previous = this.files.get(path);
            if (previous?.metadata === metadata) {
                next.set(path, previous);
                continue;
            }
            let content: string;
            try {
                content = metadata === "absent" ? "" : readFileSync(path, "utf8");
            } catch (error) {
                this.reportFailure(path, String(error), error);
                return this.snapshot;
            }
            const digest = createHash("sha256").update(content).digest("hex");
            if (metadata !== "absent") {
                const parsed = parseJsoncRecovering(content);
                if (
                    parsed.issues.length ||
                    !parsed.value ||
                    typeof parsed.value !== "object" ||
                    Array.isArray(parsed.value)
                ) {
                    const issue = parsed.issues[0];
                    this.reportFailure(
                        path,
                        digest,
                        issue
                            ? `${issue.line}:${issue.column}: ${issue.message}`
                            : "expected an object",
                    );
                    return this.snapshot;
                }
            }
            next.set(path, { metadata, digest });
            changed ||= previous?.digest !== digest;
        }
        if (!changed) {
            this.files = next;
            return this.snapshot;
        }
        let effective: T;
        try {
            effective = this.load();
        } catch (error) {
            this.reportFailure(paths[0] ?? this.directory, "load", error);
            return this.snapshot;
        }
        // The loader reads both tiers again. A concurrent writer must not let it
        // publish a mixed user/project pair under the metadata staged above.
        for (const path of paths) {
            let metadata = "absent";
            try {
                const stat = statSync(path);
                metadata = `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    this.reportFailure(path, String(error), error);
                    return this.snapshot;
                }
            }
            if (metadata !== next.get(path)?.metadata) return this.snapshot;
        }
        const digest = createHash("sha256")
            .update(paths.map((path) => `${path}:${next.get(path)?.digest}`).join("\n"))
            .digest("hex");
        this.files = next;
        this.failure = undefined;
        if (!this.initialized) {
            this.initialized = true;
            this.snapshot = {
                generation: 1,
                digest,
                adoptedAt: this.snapshot.adoptedAt,
                effective,
            };
        } else if (this.snapshot.digest !== digest) {
            const keys = this.changedKeys(this.snapshot.effective, effective);
            this.snapshot = {
                generation: this.snapshot.generation + 1,
                digest,
                adoptedAt: Date.now(),
                effective,
            };
            // A file can change (a save, a comment edit) without any setting changing;
            // only a real change is worth a line.
            if (keys.length > 0) {
                this.onLog(
                    `config reloaded gen=${this.snapshot.generation} keys=[${keys.join(",")}]`,
                );
            }
        }
        return this.snapshot;
    }

    private reportFailure(path: string, digest: string, error: unknown): void {
        const message = error instanceof Error ? error.message : String(error);
        this.failure = { path, message, digest };
        if (this.warned.has(`${path}:${digest}`)) return;
        this.warned.add(`${path}:${digest}`);
        this.onLog(`config reload failed ${path}: ${message}`);
    }
}

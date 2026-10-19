import { createHash, randomUUID } from "node:crypto";
import {
    chmodSync,
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const FALLBACK_EXECUTABLE_ROOT = "/tmp/magic-context-exec";

/** Stage a child executable on the internal disk under a digest of its source bytes. */
export function stageExecutable(source: string, name: string, identifier: string): string {
    if (!name || name !== name.split(/[\\/]/).at(-1) || name === "." || name === "..") {
        throw new Error(`staged executable name must be a single path component: ${name}`);
    }
    const sourceBytes = readFileSync(source);
    const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
    const executableRoot = getExecutableRoot();
    ensurePrivateDirectory(executableRoot);
    const directory = join(executableRoot, sourceDigest);
    ensurePrivateDirectory(directory);
    const destination = join(directory, name);
    if (verifiedCopy(destination, sourceBytes, sourceDigest, identifier)) return destination;

    const temporary = join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    let fd: number | undefined;
    try {
        fd = openSync(temporary, "wx", 0o700);
        writeFileSync(fd, sourceBytes);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        chmodSync(temporary, 0o700);

        if (process.platform === "darwin") signExecutable(temporary, identifier);
        renameSync(temporary, destination);

        if (process.platform === "darwin") {
            if (!verifySignature(destination, identifier)) {
                throw new Error(`staged executable has an invalid signature: ${destination}`);
            }
            writeSignatureRecord(destination, sourceDigest, identifier);
        }
        return destination;
    } catch (error) {
        if (fd !== undefined) closeSync(fd);
        try {
            unlinkSync(temporary);
        } catch {
            // The temporary path is absent after a successful rename.
        }
        throw error;
    }
}

export function executableRootForTmpdir(tmpDir?: string, resolvedTmpDir?: string): string {
    if (!tmpDir || !resolvedTmpDir || isUnderMacOsTempFolders(resolvedTmpDir)) {
        return FALLBACK_EXECUTABLE_ROOT;
    }
    return join(tmpDir, "magic-context-exec");
}

function getExecutableRoot(): string {
    const tmpDir = process.env.TMPDIR;
    if (!tmpDir) return FALLBACK_EXECUTABLE_ROOT;
    try {
        return executableRootForTmpdir(tmpDir, realpathSync(tmpDir));
    } catch {
        return FALLBACK_EXECUTABLE_ROOT;
    }
}

function isUnderMacOsTempFolders(path: string): boolean {
    return ["/var/folders", "/private/var/folders"].some(
        (prefix) => path === prefix || path.startsWith(`${prefix}/`),
    );
}

function ensurePrivateDirectory(path: string): void {
    try {
        mkdirSync(path, { mode: 0o700 });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`staging path is not a real directory: ${path}`);
    }
    chmodSync(path, 0o700);
}

function verifiedCopy(
    destination: string,
    sourceBytes: Buffer,
    sourceDigest: string,
    identifier: string,
): boolean {
    if (!existsSync(destination)) return false;
    const info = lstatSync(destination);
    if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o777) !== 0o700) return false;
    const stagedBytes = readFileSync(destination);
    if (process.platform !== "darwin") return stagedBytes.equals(sourceBytes);

    const recordPath = join(directoryOf(destination), `.${nameOf(destination)}.sha256`);
    if (!existsSync(recordPath)) return false;
    const [recordedSource, recordedStaged, recordedIdentifier] = readFileSync(recordPath, "utf8").trim().split(" ");
    const stagedDigest = createHash("sha256").update(stagedBytes).digest("hex");
    return (
        recordedSource === sourceDigest &&
        recordedStaged === stagedDigest &&
        recordedIdentifier === identifier &&
        verifySignature(destination, identifier)
    );
}

function signExecutable(path: string, identifier: string): void {
    const result = spawnSync(
        "codesign",
        ["--force", "--sign", "-", "--options", "runtime", "--identifier", identifier, path],
        { encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`codesign failed for ${path}: ${(result.stderr ?? "").trim()}`);
    }
}

function verifySignature(path: string, identifier: string): boolean {
    const verification = spawnSync("codesign", ["--verify", "--strict", path], { encoding: "utf8" });
    if (verification.error || verification.status !== 0) return false;
    const details = spawnSync("codesign", ["-dv", "--verbose=2", path], { encoding: "utf8" });
    if (details.error || details.status !== 0) return false;
    const output = `${details.stdout ?? ""}\n${details.stderr ?? ""}`;
    const id = output.split(/\r?\n/).some((line) => line.trim() === `Identifier=${identifier}`);
    const hardened = /flags=0x[\da-f]+\([^)]*\bruntime\b[^)]*\)/i.test(output);
    return output.includes("Signature=adhoc") && id && hardened;
}

function writeSignatureRecord(path: string, sourceDigest: string, identifier: string): void {
    const stagedDigest = createHash("sha256").update(readFileSync(path)).digest("hex");
    const recordPath = join(directoryOf(path), `.${nameOf(path)}.sha256`);
    const temporary = `${recordPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, `${sourceDigest} ${stagedDigest} ${identifier}\n`, { mode: 0o600, flag: "wx" });
        renameSync(temporary, recordPath);
    } catch (error) {
        try {
            unlinkSync(temporary);
        } catch {
            // The temporary path is absent after a successful rename.
        }
        throw error;
    }
}

function directoryOf(path: string): string {
    return path.slice(0, path.lastIndexOf("/"));
}

function nameOf(path: string): string {
    return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Optional Magic Context Dashboard install at the end of `setup`.
 *
 * The dashboard is the Tauri desktop app in `packages/dashboard`. Its builds are
 * published as GitHub releases tagged `dashboard-v<version>` on
 * cortexkit/magic-context; `.github/workflows/dashboard-release.yml` names every
 * asset `magic-context-dashboard-<platform>-<arch><ext>` and, because the app
 * ships with the Tauri updater, uploads a minisign `.sig` next to every updater
 * artifact. Setup installs only an artifact that has such a signature and checks
 * it against the updater public key from `tauri.conf.json` before the bytes are
 * written anywhere that runs them. The `.dmg` has no signature, so macOS uses the
 * signed `.app.tar.gz` updater archive instead.
 *
 * A dashboard problem never fails setup: every error ends as one warning line
 * with the reason and a link to the release for a manual download.
 */
import { execFile } from "node:child_process";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import {
    accessSync,
    chmodSync,
    constants,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { confirm, isPromptCancelledError, log, type PromptLog } from "./prompts";

const execFileAsync = promisify(execFile);

export const DASHBOARD_RELEASES_PAGE = "https://github.com/cortexkit/magic-context/releases";
export const DASHBOARD_RELEASES_API =
    "https://api.github.com/repos/cortexkit/magic-context/releases?per_page=100";

/**
 * Tauri updater public key (base64 of a minisign public key file), copied from
 * `plugins.updater.pubkey` in packages/dashboard/src-tauri/tauri.conf.json. A
 * test keeps the two equal, so rotating the key there fails until it is copied
 * here as well.
 */
export const DASHBOARD_UPDATER_PUBLIC_KEY =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDY5MUNBMDIxNjUxMEM2MkYKUldRdnhoQmxJYUFjYVU0SlNNbzRWMGJ3MndKOENIVDR0N0N6b0Jyd1l6TUNFTlpZTzV3RXlRYkEK";

export const DASHBOARD_PRODUCT_NAME = "Magic Context Dashboard";
export const DASHBOARD_MAC_APP_NAME = `${DASHBOARD_PRODUCT_NAME}.app`;
export const DASHBOARD_APPIMAGE_NAME = "magic-context-dashboard.AppImage";

const USER_AGENT = "magic-context-setup";
const TAG_PATTERN = /^dashboard-v(\d+\.\d+\.\d+)$/;

export interface DashboardReleaseAsset {
    name: string;
    size: number;
    url: string;
}

export interface DashboardRelease {
    tag: string;
    version: string;
    htmlUrl: string;
    assets: DashboardReleaseAsset[];
}

export type DashboardPlatform = "macos" | "linux" | "windows";

export interface DashboardTarget {
    platform: DashboardPlatform;
    /** The release asset to install; its signature is `<assetName>.sig`. */
    assetName: string;
}

export interface InstalledDashboard {
    location: string;
    /** null when the install exists but its version cannot be read. */
    version: string | null;
}

export interface DashboardInstallDeps {
    log: PromptLog;
    confirm: (message: string, defaultYes: boolean) => Promise<boolean>;
    /** True when a person can answer a prompt (TTY, not CI). */
    interactive: boolean;
    platform: NodeJS.Platform;
    arch: string;
    homeDir: string;
    fetch: typeof fetch;
    releasesApiUrl: string;
    publicKey: string;
    apiTimeoutMs: number;
    downloadTimeoutMs: number;
    /** `/Applications`; tests point it into a temp directory. */
    macSystemApplicationsDir: string;
    /** Where the distribution `.deb`/`.rpm` packages put the binary. */
    linuxSystemBinaryPath: string;
    tempRoot: string;
    extractTarGz: (archive: string, destinationDir: string) => Promise<void>;
    runWindowsInstaller: (installerPath: string) => Promise<void>;
    readWindowsInstall: () => Promise<InstalledDashboard | null>;
}

export type DashboardChoice = "ask" | "install" | "skip-flag" | "skip-noninteractive";

/**
 * `--no-dashboard` always wins, `--dashboard` installs without asking, and
 * otherwise the question is asked only when a person can answer it (see
 * `isInteractiveTerminal`): CI and non-TTY runs skip the offer.
 */
export function resolveDashboardChoice(
    argv: readonly string[],
    interactive: boolean,
): DashboardChoice {
    if (argv.includes("--no-dashboard")) return "skip-flag";
    if (argv.includes("--dashboard")) return "install";
    return interactive ? "ask" : "skip-noninteractive";
}

/** The asset this machine installs, or null when no build exists for it. */
export function selectDashboardTarget(
    platform: NodeJS.Platform,
    arch: string,
): DashboardTarget | null {
    if (arch !== "x64" && arch !== "arm64") return null;
    switch (platform) {
        case "darwin":
            // The .dmg carries no updater signature; the .app.tar.gz does.
            return {
                platform: "macos",
                assetName: `magic-context-dashboard-darwin-${arch}.app.tar.gz`,
            };
        case "linux":
            // The AppImage installs per user without root and is what the
            // in-app updater replaces; the .deb/.rpm would need sudo.
            return {
                platform: "linux",
                assetName: `magic-context-dashboard-linux-${arch}.AppImage`,
            };
        case "win32":
            // The NSIS installer exists for x64 and ARM64 and installs per user;
            // the .msi exists only for x64.
            return {
                platform: "windows",
                assetName: `magic-context-dashboard-windows-${arch}.exe`,
            };
        default:
            return null;
    }
}

/** Compare dotted numeric versions; a pre-release suffix is ignored. */
export function compareVersions(a: string, b: string): number {
    const parts = (value: string) =>
        value
            .replace(/^v/, "")
            .split(/[-+]/)[0]
            .split(".")
            .map((part) => Number.parseInt(part, 10) || 0);
    const left = parts(a);
    const right = parts(b);
    for (let i = 0; i < Math.max(left.length, right.length, 3); i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

function formatSize(bytes: number): string {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        if (error.name === "TimeoutError") return "the request timed out";
        return error.message;
    }
    return String(error);
}

// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows.
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type SignatureVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Verify `data` against a Tauri updater signature.
 *
 * Both arguments are base64 of minisign text files, the way Tauri publishes
 * them. The public key line holds `Ed` + 8-byte key id + 32-byte Ed25519 key;
 * the signature line holds the algorithm (`ED` signs the BLAKE2b-512 hash of
 * the file, legacy `Ed` signs the file itself) + key id + 64-byte signature.
 * The trusted comment carries its own signature over (signature + comment),
 * which is checked too, as minisign does.
 */
export function verifyTauriSignature(
    data: Uint8Array,
    signatureFile: string,
    publicKeyFile: string,
): SignatureVerdict {
    const decodeLines = (value: string) =>
        Buffer.from(value.trim(), "base64")
            .toString("utf8")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

    const keyLine = decodeLines(publicKeyFile).find(
        (line) => !line.startsWith("untrusted comment:"),
    );
    const key = Buffer.from(keyLine ?? "", "base64");
    if (key.length !== 42 || key.subarray(0, 2).toString("latin1") !== "Ed") {
        return { ok: false, reason: "the public key is malformed" };
    }
    const keyId = key.subarray(2, 10);
    const publicKey = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, key.subarray(10)]),
        format: "der",
        type: "spki",
    });

    const lines = decodeLines(signatureFile);
    const [untrusted, signatureLine, trustedLine, globalLine] = lines;
    if (
        lines.length < 4 ||
        !untrusted?.startsWith("untrusted comment:") ||
        !trustedLine?.startsWith("trusted comment: ")
    ) {
        return { ok: false, reason: "the signature file is malformed" };
    }
    const signatureBlob = Buffer.from(signatureLine ?? "", "base64");
    const algorithm = signatureBlob.subarray(0, 2).toString("latin1");
    if (signatureBlob.length !== 74 || (algorithm !== "ED" && algorithm !== "Ed")) {
        return { ok: false, reason: "the signature file is malformed" };
    }
    if (!signatureBlob.subarray(2, 10).equals(keyId)) {
        return { ok: false, reason: "it was signed by a different key" };
    }
    const signature = signatureBlob.subarray(10);
    const message =
        algorithm === "ED" ? createHash("blake2b512").update(data).digest() : Buffer.from(data);
    if (!cryptoVerify(null, message, publicKey, signature)) {
        return { ok: false, reason: "the signature does not match the file" };
    }
    const trustedComment = Buffer.from(trustedLine.slice("trusted comment: ".length), "utf8");
    const globalSignature = Buffer.from(globalLine ?? "", "base64");
    if (
        globalSignature.length !== 64 ||
        !cryptoVerify(null, Buffer.concat([signature, trustedComment]), publicKey, globalSignature)
    ) {
        return { ok: false, reason: "the signature's trusted comment does not match" };
    }
    return { ok: true };
}

interface GitHubReleaseJson {
    tag_name?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    html_url?: unknown;
    assets?: Array<{ name?: unknown; size?: unknown; browser_download_url?: unknown }>;
}

/**
 * The newest published `dashboard-v*` release. The repository also publishes
 * the plugin's `v*` releases, and GitHub's "latest release" points at those, so
 * the list is filtered here instead of asking for `/releases/latest`.
 */
export async function fetchLatestDashboardRelease(
    deps: Pick<DashboardInstallDeps, "fetch" | "releasesApiUrl" | "apiTimeoutMs">,
): Promise<DashboardRelease> {
    const response = await deps.fetch(deps.releasesApiUrl, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(deps.apiTimeoutMs),
    });
    if (!response.ok) {
        throw new Error(`the GitHub releases API answered HTTP ${response.status}`);
    }
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body))
        throw new Error("the GitHub releases API returned an unexpected body");
    let best: DashboardRelease | null = null;
    for (const entry of body as GitHubReleaseJson[]) {
        if (entry.draft === true || entry.prerelease === true) continue;
        const tag = typeof entry.tag_name === "string" ? entry.tag_name : "";
        const match = TAG_PATTERN.exec(tag);
        if (!match?.[1]) continue;
        const version = match[1];
        if (best && compareVersions(version, best.version) <= 0) continue;
        const assets: DashboardReleaseAsset[] = [];
        for (const asset of entry.assets ?? []) {
            if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") {
                continue;
            }
            assets.push({
                name: asset.name,
                size: typeof asset.size === "number" ? asset.size : 0,
                url: asset.browser_download_url,
            });
        }
        best = {
            tag,
            version,
            htmlUrl:
                typeof entry.html_url === "string"
                    ? entry.html_url
                    : `${DASHBOARD_RELEASES_PAGE}/tag/${tag}`,
            assets,
        };
    }
    if (!best) throw new Error("no published dashboard-v* release was found");
    return best;
}

async function download(
    deps: Pick<DashboardInstallDeps, "fetch" | "downloadTimeoutMs">,
    asset: DashboardReleaseAsset,
): Promise<Buffer> {
    const response = await deps.fetch(asset.url, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(deps.downloadTimeoutMs),
    });
    if (!response.ok)
        throw new Error(`downloading ${asset.name} failed with HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

function readMacAppVersion(appPath: string): string | null {
    try {
        const plist = readFileSync(join(appPath, "Contents", "Info.plist"), "utf8");
        const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
            plist,
        );
        return match?.[1]?.trim() ?? null;
    } catch {
        return null;
    }
}

function macApplicationDirs(deps: DashboardInstallDeps): string[] {
    return [deps.macSystemApplicationsDir, join(deps.homeDir, "Applications")];
}

/**
 * Records the AppImage version setup installed. An AppImage cannot report its
 * version without being run, and setup never runs it.
 */
function linuxVersionMarkerPath(homeDir: string): string {
    return join(homeDir, ".local", "share", "cortexkit", "dashboard-appimage.json");
}

function linuxAppImagePath(homeDir: string): string {
    return join(homeDir, ".local", "bin", DASHBOARD_APPIMAGE_NAME);
}

export async function detectInstalledDashboard(
    target: DashboardTarget,
    deps: DashboardInstallDeps,
): Promise<InstalledDashboard | null> {
    switch (target.platform) {
        case "macos":
            for (const dir of macApplicationDirs(deps)) {
                const location = join(dir, DASHBOARD_MAC_APP_NAME);
                if (existsSync(location)) return { location, version: readMacAppVersion(location) };
            }
            return null;
        case "linux": {
            const location = linuxAppImagePath(deps.homeDir);
            if (existsSync(location)) {
                let version: string | null = null;
                try {
                    const marker = JSON.parse(
                        readFileSync(linuxVersionMarkerPath(deps.homeDir), "utf8"),
                    ) as { version?: unknown };
                    if (typeof marker.version === "string") version = marker.version;
                } catch {
                    version = null;
                }
                return { location, version };
            }
            if (existsSync(deps.linuxSystemBinaryPath)) {
                return { location: deps.linuxSystemBinaryPath, version: null };
            }
            return null;
        }
        case "windows":
            return deps.readWindowsInstall();
    }
}

function isWritableDir(path: string): boolean {
    try {
        if (!statSync(path).isDirectory()) return false;
        accessSync(path, constants.W_OK);
        return true;
    } catch {
        return false;
    }
}

function unsafeArchivePath(path: string): boolean {
    if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return true;
    return path.split(/[/\\]/).some((segment) => segment === "..");
}

function tarString(block: Buffer, start: number, length: number): string {
    const field = block.subarray(start, start + length);
    const end = field.indexOf(0);
    return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function tarSize(block: Buffer): number {
    const field = block.subarray(124, 136);
    // GNU base-256 encoding: high bit set, big-endian value in the remaining bytes.
    if ((field[0] ?? 0) & 0x80) {
        let value = (field[0] ?? 0) & 0x7f;
        for (const byte of field.subarray(1)) value = value * 256 + byte;
        return value;
    }
    const text = tarString(block, 124, 12).trim();
    return text === "" ? 0 : Number.parseInt(text, 8);
}

function paxRecords(data: Buffer): Map<string, string> {
    const records = new Map<string, string>();
    let offset = 0;
    while (offset < data.length) {
        const space = data.indexOf(0x20, offset);
        if (space === -1) break;
        const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
        if (!Number.isFinite(length) || length <= 0) break;
        const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
        const equals = record.indexOf("=");
        if (equals !== -1) records.set(record.slice(0, equals), record.slice(equals + 1));
        offset += length;
    }
    return records;
}

/**
 * Refuse a tar archive (already gunzipped) that could write outside the
 * directory it is extracted into, or null when every entry is safe.
 *
 * The app archive is signed, so this guards against a broken or hostile build
 * rather than a network attacker. Entry names and hard-link targets must be
 * relative with no `..` segment. Symbolic-link targets must also be relative
 * with no `..` segment: such a link can only point further down from its own
 * directory, so even a chain of links stays inside. Only files, directories,
 * links and the PAX/GNU long-name records that rename them are accepted; the
 * long names are applied before checking, as `tar` applies them.
 */
export function findUnsafeTarEntry(tar: Buffer): string | null {
    const globalPax = new Map<string, string>();
    let nextPax = new Map<string, string>();
    let longName: string | null = null;
    let longLink: string | null = null;
    let offset = 0;
    while (offset + 512 <= tar.length) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) return null;
        const size = tarSize(header);
        if (!Number.isFinite(size) || size < 0) return "an entry has an unreadable size";
        const dataStart = offset + 512;
        const data = tar.subarray(dataStart, dataStart + size);
        offset = dataStart + Math.ceil(size / 512) * 512;
        const type = String.fromCharCode(header[156] ?? 0);

        if (type === "x" || type === "g") {
            const records = paxRecords(data);
            const target = type === "g" ? globalPax : nextPax;
            for (const [key, value] of records) target.set(key, value);
            continue;
        }
        if (type === "L" || type === "K") {
            const value = tarString(data, 0, data.length);
            if (type === "L") longName = value;
            else longLink = value;
            continue;
        }

        const prefix = tarString(header, 345, 155);
        const isUstar = header.subarray(257, 262).toString("latin1") === "ustar";
        const headerName = tarString(header, 0, 100);
        const name =
            nextPax.get("path") ??
            longName ??
            globalPax.get("path") ??
            (isUstar && prefix ? `${prefix}/${headerName}` : headerName);
        const link =
            nextPax.get("linkpath") ??
            longLink ??
            globalPax.get("linkpath") ??
            tarString(header, 157, 100);
        nextPax = new Map();
        longName = null;
        longLink = null;

        if (unsafeArchivePath(name)) return `entry "${name}" points outside the archive`;
        switch (type) {
            case "0":
            case "\0":
            case "7":
            case "5":
                break;
            case "1":
            case "2":
                if (link === "" || unsafeArchivePath(link)) {
                    return `link "${name}" -> "${link}" points outside the archive`;
                }
                break;
            default:
                return `entry "${name}" has unsupported type "${type}"`;
        }
    }
    // Running out of bytes before the end-of-archive marker: accept only a clean
    // entry boundary, so a truncated entry is refused.
    return offset === tar.length ? null : "the archive is truncated";
}

async function installMac(
    data: Buffer,
    deps: DashboardInstallDeps,
    installed: InstalledDashboard | null,
): Promise<string> {
    let destinationDir: string;
    if (installed) {
        destinationDir = dirname(installed.location);
    } else if (isWritableDir(deps.macSystemApplicationsDir)) {
        destinationDir = deps.macSystemApplicationsDir;
    } else {
        destinationDir = join(deps.homeDir, "Applications");
        deps.log.info(
            `${deps.macSystemApplicationsDir} is not writable, so the app goes to ${destinationDir} (setup never asks for sudo).`,
        );
    }
    const unsafe = findUnsafeTarEntry(gunzipSync(data));
    if (unsafe) throw new Error(`the app archive is unsafe to extract: ${unsafe}`);
    mkdirSync(destinationDir, { recursive: true });
    // Stage inside the destination so the final move is a same-volume rename.
    const staging = mkdtempSync(join(destinationDir, ".magic-context-dashboard-"));
    try {
        const archive = join(staging, "dashboard.app.tar.gz");
        writeFileSync(archive, data);
        const extractDir = join(staging, "extracted");
        mkdirSync(extractDir);
        await deps.extractTarGz(archive, extractDir);
        const extracted = join(extractDir, DASHBOARD_MAC_APP_NAME);
        if (!existsSync(extracted)) {
            throw new Error(`the archive did not contain ${DASHBOARD_MAC_APP_NAME}`);
        }
        const finalPath = join(destinationDir, DASHBOARD_MAC_APP_NAME);
        const previous = join(staging, "previous.app");
        const hadPrevious = existsSync(finalPath);
        if (hadPrevious) renameSync(finalPath, previous);
        try {
            renameSync(extracted, finalPath);
        } catch (error) {
            if (hadPrevious) renameSync(previous, finalPath);
            throw error;
        }
        return finalPath;
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

function installLinux(data: Buffer, version: string, deps: DashboardInstallDeps): string {
    const finalPath = linuxAppImagePath(deps.homeDir);
    mkdirSync(dirname(finalPath), { recursive: true });
    const partial = `${finalPath}.partial-${process.pid}`;
    try {
        writeFileSync(partial, data, { mode: 0o755 });
        chmodSync(partial, 0o755);
        renameSync(partial, finalPath);
    } finally {
        rmSync(partial, { force: true });
    }
    const marker = linuxVersionMarkerPath(deps.homeDir);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, `${JSON.stringify({ version, path: finalPath }, null, 2)}\n`);
    return finalPath;
}

async function installWindows(
    data: Buffer,
    asset: DashboardReleaseAsset,
    deps: DashboardInstallDeps,
): Promise<string> {
    const dir = mkdtempSync(join(deps.tempRoot, "magic-context-dashboard-"));
    try {
        const installer = join(dir, asset.name);
        writeFileSync(installer, data);
        deps.log.info(
            "Running the dashboard installer (per-user install, no administrator rights).",
        );
        await deps.runWindowsInstaller(installer);
    } finally {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            // The installer can briefly hold its own file; a leftover temp file is harmless.
        }
    }
    const installed = await deps.readWindowsInstall().catch(() => null);
    return installed?.location ?? "the Start menu";
}

async function runOffer(
    argv: readonly string[],
    deps: DashboardInstallDeps,
    state: { link: string },
): Promise<void> {
    const choice = resolveDashboardChoice(argv, deps.interactive);
    if (choice === "skip-flag") {
        deps.log.info("Skipping the Magic Context Dashboard (--no-dashboard).");
        return;
    }
    if (choice === "skip-noninteractive") {
        deps.log.info(
            `Skipped the Magic Context Dashboard offer (non-interactive run). Pass --dashboard to install it, or download it from ${DASHBOARD_RELEASES_PAGE}`,
        );
        return;
    }
    const target = selectDashboardTarget(deps.platform, deps.arch);
    if (!target) {
        deps.log.info(
            `No Magic Context Dashboard build exists for ${deps.platform}/${deps.arch}; see ${DASHBOARD_RELEASES_PAGE}`,
        );
        return;
    }

    const release = await fetchLatestDashboardRelease(deps);
    state.link = release.htmlUrl;
    const asset = release.assets.find((candidate) => candidate.name === target.assetName);
    if (!asset) throw new Error(`release ${release.tag} has no ${target.assetName}`);
    const signatureAsset = release.assets.find(
        (candidate) => candidate.name === `${target.assetName}.sig`,
    );
    if (!signatureAsset) {
        throw new Error(
            `release ${release.tag} publishes no signature for ${target.assetName}, so it cannot be verified`,
        );
    }

    const installed = await detectInstalledDashboard(target, deps);
    const size = formatSize(asset.size);
    let question: string;
    if (installed) {
        if (installed.version === null) {
            deps.log.info(
                `Magic Context Dashboard is already installed at ${installed.location} (version unknown); it updates itself from inside the app.`,
            );
            return;
        }
        if (compareVersions(installed.version, release.version) >= 0) {
            deps.log.info(
                `Magic Context Dashboard v${installed.version} is already installed at ${installed.location} (latest release: v${release.version}).`,
            );
            return;
        }
        deps.log.info(
            `Magic Context Dashboard v${installed.version} is installed at ${installed.location}; v${release.version} is available.`,
        );
        question = `Update the Magic Context Dashboard to v${release.version}? (${size} download)`;
    } else {
        question = `Install the Magic Context Dashboard (desktop app for memories, sessions and settings)? v${release.version}, ${size} download`;
    }
    if (choice === "ask" && !(await deps.confirm(question, true))) {
        deps.log.info(`Skipped the Magic Context Dashboard. It is available at ${release.htmlUrl}`);
        return;
    }

    deps.log.step(`Downloading ${asset.name} (${size})…`);
    const [data, signature] = await Promise.all([
        download(deps, asset),
        download(deps, signatureAsset),
    ]);
    const verdict = verifyTauriSignature(data, signature.toString("utf8"), deps.publicKey);
    if (!verdict.ok) {
        throw new Error(
            `${asset.name} failed signature verification (${verdict.reason}); nothing was installed`,
        );
    }
    deps.log.info(`Verified ${asset.name} against the dashboard's updater signing key.`);

    let location: string;
    switch (target.platform) {
        case "macos":
            location = await installMac(data, deps, installed);
            break;
        case "linux":
            deps.log.info(
                "Installing the AppImage to ~/.local/bin: it needs no root, runs on any distribution, and is what the app's own updater replaces (the .deb/.rpm packages would need sudo).",
            );
            location = installLinux(data, release.version, deps);
            break;
        case "windows":
            location = await installWindows(data, asset, deps);
            break;
    }
    deps.log.success(`Installed Magic Context Dashboard v${release.version} → ${location}`);
}

/** A person can answer a prompt: stdin and stdout are terminals and `CI` is unset or false. */
export function isInteractiveTerminal(
    stdinIsTTY: boolean | undefined,
    stdoutIsTTY: boolean | undefined,
    env: NodeJS.ProcessEnv,
): boolean {
    const ci = env.CI?.trim().toLowerCase();
    const isCi = ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
    return Boolean(stdinIsTTY && stdoutIsTTY) && !isCi;
}

const WINDOWS_UNINSTALL_KEY = `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${DASHBOARD_PRODUCT_NAME}`;

/** The NSIS installer registers itself under the product name (per user, else per machine). */
async function readWindowsInstallFromRegistry(): Promise<InstalledDashboard | null> {
    for (const hive of ["HKCU", "HKLM"]) {
        const key = `${hive}\\${WINDOWS_UNINSTALL_KEY}`;
        try {
            const { stdout } = await execFileAsync("reg", ["query", key], { windowsHide: true });
            const values = new Map<string, string>();
            for (const line of stdout.split(/\r?\n/)) {
                const match = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
                if (match?.[1] && match[2] !== undefined) values.set(match[1], match[2].trim());
            }
            return {
                location: values.get("InstallLocation") || key,
                version: values.get("DisplayVersion") || null,
            };
        } catch {
            // Key absent in this hive.
        }
    }
    return null;
}

export function defaultDashboardInstallDeps(): DashboardInstallDeps {
    return {
        log,
        confirm: (message, defaultYes) => confirm(message, defaultYes),
        interactive: isInteractiveTerminal(process.stdin.isTTY, process.stdout.isTTY, process.env),
        platform: process.platform,
        arch: process.arch,
        homeDir: homedir(),
        fetch: globalThis.fetch,
        releasesApiUrl: DASHBOARD_RELEASES_API,
        publicKey: DASHBOARD_UPDATER_PUBLIC_KEY,
        apiTimeoutMs: 15_000,
        downloadTimeoutMs: 10 * 60_000,
        macSystemApplicationsDir: "/Applications",
        linuxSystemBinaryPath: "/usr/bin/magic-context-dashboard",
        tempRoot: tmpdir(),
        extractTarGz: async (archive, destinationDir) => {
            await execFileAsync("tar", ["-xzf", archive, "-C", destinationDir], {
                windowsHide: true,
            });
        },
        // `/P` is the Tauri NSIS installer's passive mode: progress only, no questions.
        runWindowsInstaller: async (installerPath) => {
            // GUI installer in passive mode: its progress window must stay visible.
            await execFileAsync(installerPath, ["/P"], { windowsHide: false });
        },
        readWindowsInstall: readWindowsInstallFromRegistry,
    };
}

/**
 * Offer the dashboard after a successful setup. Never throws and never changes
 * setup's exit code: a failure is one warning line with the reason and a link.
 */
export async function offerDashboardInstall(
    argv: readonly string[],
    overrides: Partial<DashboardInstallDeps> = {},
): Promise<void> {
    const deps: DashboardInstallDeps = { ...defaultDashboardInstallDeps(), ...overrides };
    const state = { link: DASHBOARD_RELEASES_PAGE };
    try {
        await runOffer(argv, deps, state);
    } catch (error) {
        if (isPromptCancelledError(error)) {
            deps.log.info("Skipped the Magic Context Dashboard.");
            return;
        }
        deps.log.warn(
            `Magic Context Dashboard was not installed: ${errorMessage(error)}. Install it manually from ${state.link}`,
        );
    }
}

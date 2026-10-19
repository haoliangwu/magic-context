/// <reference types="bun-types" />

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import {
    compareVersions,
    DASHBOARD_APPIMAGE_NAME,
    DASHBOARD_MAC_APP_NAME,
    DASHBOARD_UPDATER_PUBLIC_KEY,
    type DashboardInstallDeps,
    findUnsafeTarEntry,
    type InstalledDashboard,
    isInteractiveTerminal,
    offerDashboardInstall,
    resolveDashboardChoice,
    selectDashboardTarget,
    verifyTauriSignature,
} from "./dashboard-install";
import type { PromptLog } from "./prompts";

// ── Minisign/Tauri signing helpers ──────────────────────────────────────────
// Each key mirrors what `tauri signer generate` writes: base64 of a minisign
// public key file, and signatures as base64 of a minisign signature file.

interface TestKey {
    publicKeyFile: string;
    signFile: (data: Uint8Array) => string;
}

function makeKey(keyIdByte: number): TestKey {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
    const keyId = Buffer.alloc(8, keyIdByte);
    const publicKeyText = `untrusted comment: minisign public key: ${keyId.toString("hex").toUpperCase()}\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`;
    return {
        publicKeyFile: Buffer.from(publicKeyText).toString("base64"),
        signFile: (data) => {
            const digest = createHash("blake2b512").update(data).digest();
            const signature = sign(null, digest, privateKey);
            const trusted = "timestamp:1700000000\tfile:test-asset";
            const globalSignature = sign(
                null,
                Buffer.concat([signature, Buffer.from(trusted)]),
                privateKey,
            );
            const text = [
                "untrusted comment: signature from tauri secret key",
                Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64"),
                `trusted comment: ${trusted}`,
                globalSignature.toString("base64"),
                "",
            ].join("\n");
            return Buffer.from(text).toString("base64");
        },
    };
}

const releaseKey = makeKey(0x11);
const otherKey = makeKey(0x11);

// ── Fake GitHub releases server ─────────────────────────────────────────────

interface ServedAsset {
    name: string;
    body: Uint8Array | string;
    status?: number;
}

interface FakeRelease {
    tag: string;
    draft?: boolean;
    prerelease?: boolean;
    assets: ServedAsset[];
}

let server: ReturnType<typeof Bun.serve>;
let releases: FakeRelease[] = [];
let apiStatus = 200;
const requests: string[] = [];

function baseUrl(): string {
    return `http://127.0.0.1:${server.port}`;
}

beforeAll(() => {
    server = Bun.serve({
        port: 0,
        hostname: "127.0.0.1",
        fetch(request) {
            const url = new URL(request.url);
            requests.push(url.pathname);
            if (url.pathname === "/repos/cortexkit/magic-context/releases") {
                if (apiStatus !== 200) return new Response("nope", { status: apiStatus });
                return Response.json(
                    releases.map((release) => ({
                        tag_name: release.tag,
                        draft: release.draft ?? false,
                        prerelease: release.prerelease ?? false,
                        html_url: `${baseUrl()}/releases/tag/${release.tag}`,
                        assets: release.assets.map((asset) => ({
                            name: asset.name,
                            size:
                                typeof asset.body === "string"
                                    ? asset.body.length
                                    : asset.body.length,
                            browser_download_url: `${baseUrl()}/download/${release.tag}/${asset.name}`,
                        })),
                    })),
                );
            }
            const match = /^\/download\/([^/]+)\/(.+)$/.exec(url.pathname);
            const asset = releases
                .find((release) => release.tag === match?.[1])
                ?.assets.find(
                    (candidate) => candidate.name === decodeURIComponent(match?.[2] ?? ""),
                );
            if (!asset) return new Response("missing", { status: 404 });
            return new Response(asset.body, { status: asset.status ?? 200 });
        },
    });
});
afterAll(() => {
    server.stop(true);
});

const root = createTestTempDirFromPath(join(tmpdir(), "mc-dashboard-install-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

afterEach(() => {
    releases = [];
    apiStatus = 200;
    requests.length = 0;
});

function payload(label: string): Buffer {
    return Buffer.from(`fake dashboard build: ${label}\n`.repeat(64));
}

// ── Tar archive builders (ustar headers, as `tar` writes them) ───────────────────

interface TarSpec {
    name: string;
    type?: string;
    link?: string;
    prefix?: string;
    data?: Buffer;
}

function tarEntry(spec: TarSpec): Buffer {
    const header = Buffer.alloc(512);
    const data = spec.data ?? Buffer.alloc(0);
    header.write(spec.name, 0, 100, "utf8");
    header.write("0000644\0", 100, "latin1");
    header.write("0000000\0", 108, "latin1");
    header.write("0000000\0", 116, "latin1");
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    header.write("00000000000\0", 136, "latin1");
    header.write(spec.type ?? "0", 156, "latin1");
    header.write(spec.link ?? "", 157, 100, "utf8");
    header.write("ustar\0", 257, "latin1");
    header.write("00", 263, "latin1");
    header.write(spec.prefix ?? "", 345, 155, "utf8");
    header.fill(0x20, 148, 156);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    const padding = Buffer.alloc((512 - (data.length % 512)) % 512);
    return Buffer.concat([header, data, padding]);
}

function paxEntry(records: Record<string, string>): Buffer {
    let body = "";
    for (const [key, value] of Object.entries(records)) {
        const rest = ` ${key}=${value}\n`;
        let length = rest.length + 1;
        while (`${length}${rest}`.length !== length) length += 1;
        body += `${length}${rest}`;
    }
    return tarEntry({ name: "PaxHeader", type: "x", data: Buffer.from(body) });
}

function tarArchive(entries: Buffer[]): Buffer {
    return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

const APP = DASHBOARD_MAC_APP_NAME;

function safeAppEntries(label: string): Buffer[] {
    return [
        tarEntry({ name: `${APP}/`, type: "5" }),
        tarEntry({ name: `${APP}/Contents/`, type: "5" }),
        tarEntry({ name: `${APP}/Contents/Info.plist`, data: Buffer.from(label) }),
        tarEntry({
            name: `${APP}/Contents/Frameworks/X.framework/Versions/A/X`,
            data: payload(label),
        }),
        tarEntry({
            name: `${APP}/Contents/Frameworks/X.framework/Versions/Current`,
            type: "2",
            link: "A",
        }),
        tarEntry({
            name: `${APP}/Contents/Frameworks/X.framework/X`,
            type: "2",
            link: "Versions/Current/X",
        }),
        tarEntry({
            name: `${APP}/Contents/Info-copy.plist`,
            type: "1",
            link: `${APP}/Contents/Info.plist`,
        }),
    ];
}

/** A gzipped app archive with only safe entries. */
function macArchive(label: string): Buffer {
    return gzipSync(tarArchive(safeAppEntries(label)));
}

/** A release whose `assetName` is signed by `signer` (the release key by default). */
function publishRelease(
    version: string,
    assetName: string,
    data: Buffer,
    options: { signer?: TestKey; signedData?: Buffer; withSignature?: boolean } = {},
): void {
    const assets: ServedAsset[] = [{ name: assetName, body: data }];
    if (options.withSignature !== false) {
        const signer = options.signer ?? releaseKey;
        assets.push({
            name: `${assetName}.sig`,
            body: signer.signFile(options.signedData ?? data),
        });
    }
    releases.push({ tag: `dashboard-v${version}`, assets });
}

interface Harness {
    deps: Partial<DashboardInstallDeps>;
    home: string;
    applications: string;
    lines: string[];
    questions: string[];
}

let caseCounter = 0;

function harness(options: {
    platform?: NodeJS.Platform;
    arch?: string;
    interactive?: boolean;
    answer?: boolean;
    overrides?: Partial<DashboardInstallDeps>;
}): Harness {
    caseCounter += 1;
    const caseDir = join(root, `case-${caseCounter}`);
    const home = join(caseDir, "home");
    const applications = join(caseDir, "Applications");
    mkdirSync(home, { recursive: true });
    mkdirSync(applications, { recursive: true });
    const lines: string[] = [];
    const questions: string[] = [];
    const record = (kind: string) => (message: string) => lines.push(`${kind}: ${message}`);
    const testLog: PromptLog = {
        info: record("info"),
        success: record("success"),
        warn: record("warn"),
        error: record("error"),
        message: record("message"),
        step: record("step"),
    };
    return {
        home,
        applications,
        lines,
        questions,
        deps: {
            log: testLog,
            confirm: async (message) => {
                questions.push(message);
                if (options.answer === undefined) throw new Error(`unexpected prompt: ${message}`);
                return options.answer;
            },
            interactive: options.interactive ?? true,
            platform: options.platform ?? "linux",
            arch: options.arch ?? "x64",
            homeDir: home,
            releasesApiUrl: `${baseUrl()}/repos/cortexkit/magic-context/releases`,
            publicKey: releaseKey.publicKeyFile,
            apiTimeoutMs: 5_000,
            downloadTimeoutMs: 5_000,
            macSystemApplicationsDir: applications,
            linuxSystemBinaryPath: join(caseDir, "usr-bin", "magic-context-dashboard"),
            tempRoot: caseDir,
            extractTarGz: async () => {
                throw new Error("extractTarGz must be mocked by the macOS tests");
            },
            runWindowsInstaller: async () => {
                throw new Error("runWindowsInstaller must be mocked by the Windows tests");
            },
            readWindowsInstall: async () => null,
            ...options.overrides,
        },
    };
}

const LINUX_ASSET = "magic-context-dashboard-linux-x64.AppImage";

function appImagePath(home: string): string {
    return join(home, ".local", "bin", DASHBOARD_APPIMAGE_NAME);
}

function downloads(): string[] {
    return requests.filter((path) => path.startsWith("/download/"));
}

function writeLinuxInstall(home: string, version: string): void {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(appImagePath(home), "old build");
    mkdirSync(join(home, ".local", "share", "cortexkit"), { recursive: true });
    writeFileSync(
        join(home, ".local", "share", "cortexkit", "dashboard-appimage.json"),
        JSON.stringify({ version }),
    );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("dashboard offer: prompt and flags", () => {
    it("installs after the person answers yes, showing version and size in the question", async () => {
        const data = payload("yes");
        publishRelease("0.20.0", LINUX_ASSET, data);
        const h = harness({ answer: true });
        await offerDashboardInstall([], h.deps);
        expect(h.questions).toHaveLength(1);
        expect(h.questions[0]).toContain(
            "Install the Magic Context Dashboard (desktop app for memories, sessions and settings)?",
        );
        expect(h.questions[0]).toContain("v0.20.0");
        expect(h.questions[0]).toContain("MB download");
        expect(readFileSync(appImagePath(h.home)).equals(data)).toBe(true);
        expect(
            h.lines.some((line) =>
                line.startsWith("success: Installed Magic Context Dashboard v0.20.0"),
            ),
        ).toBe(true);
    });

    it("installs nothing and downloads nothing after the person answers no", async () => {
        publishRelease("0.20.0", LINUX_ASSET, payload("no"));
        const h = harness({ answer: false });
        await offerDashboardInstall([], h.deps);
        expect(h.questions).toHaveLength(1);
        expect(downloads()).toEqual([]);
        expect(existsSync(appImagePath(h.home))).toBe(false);
    });

    it("--dashboard installs without asking, even in a non-interactive run", async () => {
        const data = payload("flag");
        publishRelease("0.20.0", LINUX_ASSET, data);
        const h = harness({ interactive: false });
        await offerDashboardInstall(["--dashboard"], h.deps);
        expect(h.questions).toEqual([]);
        expect(readFileSync(appImagePath(h.home)).equals(data)).toBe(true);
    });

    it("--no-dashboard skips without asking or touching the network", async () => {
        publishRelease("0.20.0", LINUX_ASSET, payload("no-flag"));
        const h = harness({ interactive: true });
        await offerDashboardInstall(["--no-dashboard"], h.deps);
        expect(h.questions).toEqual([]);
        expect(requests).toEqual([]);
        expect(existsSync(appImagePath(h.home))).toBe(false);
        expect(h.lines).toContain("info: Skipping the Magic Context Dashboard (--no-dashboard).");
    });

    it("skips a non-TTY run without asking or touching the network", async () => {
        publishRelease("0.20.0", LINUX_ASSET, payload("non-tty"));
        const h = harness({ interactive: false });
        await offerDashboardInstall([], h.deps);
        expect(h.questions).toEqual([]);
        expect(requests).toEqual([]);
        expect(existsSync(appImagePath(h.home))).toBe(false);
        expect(h.lines.join("\n")).toContain("Pass --dashboard to install it");
    });

    it("treats a CI or non-TTY run as non-interactive, and --no-dashboard wins over --dashboard", () => {
        expect(isInteractiveTerminal(true, true, {})).toBe(true);
        expect(isInteractiveTerminal(true, true, { CI: "true" })).toBe(false);
        expect(isInteractiveTerminal(true, true, { CI: "1" })).toBe(false);
        expect(isInteractiveTerminal(true, true, { CI: "false" })).toBe(true);
        expect(isInteractiveTerminal(false, true, {})).toBe(false);
        expect(isInteractiveTerminal(true, undefined, {})).toBe(false);
        expect(resolveDashboardChoice([], false)).toBe("skip-noninteractive");
        expect(resolveDashboardChoice(["--dashboard", "--no-dashboard"], true)).toBe("skip-flag");
        expect(resolveDashboardChoice([], true)).toBe("ask");
    });
});

describe("dashboard offer: already installed", () => {
    it("reports the same version as installed and offers nothing", async () => {
        publishRelease("0.20.0", LINUX_ASSET, payload("same"));
        const h = harness({});
        writeLinuxInstall(h.home, "0.20.0");
        await offerDashboardInstall([], h.deps);
        expect(h.questions).toEqual([]);
        expect(downloads()).toEqual([]);
        expect(readFileSync(appImagePath(h.home), "utf8")).toBe("old build");
        expect(h.lines.join("\n")).toContain("v0.20.0 is already installed");
    });

    it("offers an update for an older version and installs it on yes", async () => {
        const data = payload("update");
        publishRelease("0.20.0", LINUX_ASSET, data);
        const h = harness({ answer: true });
        writeLinuxInstall(h.home, "0.19.0");
        await offerDashboardInstall([], h.deps);
        expect(h.questions).toHaveLength(1);
        expect(h.questions[0]).toContain("Update the Magic Context Dashboard to v0.20.0?");
        expect(readFileSync(appImagePath(h.home)).equals(data)).toBe(true);
    });

    it("reads the installed macOS version from the app bundle", async () => {
        publishRelease("0.20.0", "magic-context-dashboard-darwin-arm64.app.tar.gz", payload("mac"));
        const h = harness({ platform: "darwin", arch: "arm64" });
        const contents = join(h.applications, DASHBOARD_MAC_APP_NAME, "Contents");
        mkdirSync(contents, { recursive: true });
        writeFileSync(
            join(contents, "Info.plist"),
            "<plist><dict><key>CFBundleShortVersionString</key>\n<string>0.20.0</string></dict></plist>",
        );
        await offerDashboardInstall([], h.deps);
        expect(downloads()).toEqual([]);
        expect(h.lines.join("\n")).toContain("v0.20.0 is already installed");
    });
});

describe("dashboard offer: verification", () => {
    it("refuses a file whose signature does not match, installing nothing", async () => {
        publishRelease("0.20.0", LINUX_ASSET, payload("tampered"), {
            signedData: payload("what was actually signed"),
        });
        const h = harness({ answer: true });
        await offerDashboardInstall([], h.deps);
        expect(existsSync(join(h.home, ".local", "bin"))).toBe(false);
        expect(existsSync(join(h.home, ".local", "share"))).toBe(false);
        const warning = h.lines.find((line) => line.startsWith("warn:")) ?? "";
        expect(warning).toContain("failed signature verification");
        expect(warning).toContain("/releases/tag/dashboard-v0.20.0");
    });

    it("refuses a file signed by a different key, installing nothing", async () => {
        publishRelease("0.20.0", LINUX_ASSET, payload("other key"), { signer: otherKey });
        const h = harness({ answer: true });
        await offerDashboardInstall([], h.deps);
        expect(existsSync(appImagePath(h.home))).toBe(false);
        expect(h.lines.join("\n")).toContain("failed signature verification");
    });

    it("refuses an asset that has no published signature, without downloading it", async () => {
        publishRelease("0.20.0", LINUX_ASSET, payload("unsigned"), { withSignature: false });
        const h = harness({ answer: true });
        await offerDashboardInstall([], h.deps);
        expect(downloads()).toEqual([]);
        expect(existsSync(appImagePath(h.home))).toBe(false);
        expect(h.lines.join("\n")).toContain("publishes no signature");
    });

    it("verifyTauriSignature accepts a good signature and rejects altered bytes", () => {
        const data = payload("direct");
        const signature = releaseKey.signFile(data);
        expect(verifyTauriSignature(data, signature, releaseKey.publicKeyFile)).toEqual({
            ok: true,
        });
        const altered = Buffer.from(data);
        altered[3] = (altered[3] ?? 0) ^ 1;
        expect(verifyTauriSignature(altered, signature, releaseKey.publicKeyFile).ok).toBe(false);
    });

    it("embeds the same updater public key as tauri.conf.json", () => {
        const config = JSON.parse(
            readFileSync(
                resolve(import.meta.dir, "../../../dashboard/src-tauri/tauri.conf.json"),
                "utf8",
            ),
        ) as { plugins: { updater: { pubkey: string } } };
        expect(DASHBOARD_UPDATER_PUBLIC_KEY).toBe(config.plugins.updater.pubkey);
        const keyText = Buffer.from(DASHBOARD_UPDATER_PUBLIC_KEY, "base64").toString("utf8");
        expect(keyText).toStartWith("untrusted comment: minisign public key:");
    });
});

describe("dashboard offer: failure handling", () => {
    it("a failed download ends with one warning line and does not throw", async () => {
        publishRelease("0.20.0", LINUX_ASSET, payload("broken"));
        const asset = releases[0]?.assets[0];
        if (asset) asset.status = 500;
        const h = harness({ answer: true });
        await expect(offerDashboardInstall([], h.deps)).resolves.toBeUndefined();
        const warnings = h.lines.filter((line) => line.startsWith("warn:"));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("HTTP 500");
        expect(warnings[0]).toContain("Install it manually from");
        expect(existsSync(appImagePath(h.home))).toBe(false);
    });

    it("an unreachable releases API ends with one warning line naming the releases page", async () => {
        apiStatus = 503;
        const h = harness({ answer: true });
        await offerDashboardInstall([], h.deps);
        expect(h.questions).toEqual([]);
        const warnings = h.lines.filter((line) => line.startsWith("warn:"));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("HTTP 503");
        expect(warnings[0]).toContain("https://github.com/cortexkit/magic-context/releases");
    });

    it("picks the newest published dashboard release, ignoring plugin, draft and pre-release tags", async () => {
        releases.push({ tag: "v9.0.0", assets: [] });
        releases.push({ tag: "dashboard-v0.21.0", draft: true, assets: [] });
        releases.push({ tag: "dashboard-v0.22.0", prerelease: true, assets: [] });
        publishRelease("0.20.0", LINUX_ASSET, payload("newest"));
        publishRelease("0.19.0", LINUX_ASSET, payload("older"));
        const h = harness({ answer: true });
        await offerDashboardInstall([], h.deps);
        expect(h.questions[0]).toContain("v0.20.0");
        expect(downloads().every((path) => path.startsWith("/download/dashboard-v0.20.0/"))).toBe(
            true,
        );
        expect(compareVersions("0.10.0", "0.9.9")).toBeGreaterThan(0);
    });
});

describe("dashboard offer: platform selection", () => {
    it("selects the signed artifact for each supported platform and arch", () => {
        expect(selectDashboardTarget("darwin", "arm64")?.assetName).toBe(
            "magic-context-dashboard-darwin-arm64.app.tar.gz",
        );
        expect(selectDashboardTarget("darwin", "x64")?.assetName).toBe(
            "magic-context-dashboard-darwin-x64.app.tar.gz",
        );
        expect(selectDashboardTarget("linux", "arm64")?.assetName).toBe(
            "magic-context-dashboard-linux-arm64.AppImage",
        );
        expect(selectDashboardTarget("win32", "x64")?.assetName).toBe(
            "magic-context-dashboard-windows-x64.exe",
        );
        expect(selectDashboardTarget("win32", "arm64")?.assetName).toBe(
            "magic-context-dashboard-windows-arm64.exe",
        );
        expect(selectDashboardTarget("freebsd", "x64")).toBeNull();
        expect(selectDashboardTarget("linux", "ia32")).toBeNull();
    });

    it("macOS: extracts the verified archive into the Applications directory", async () => {
        const data = macArchive("mac install");
        publishRelease("0.20.0", "magic-context-dashboard-darwin-arm64.app.tar.gz", data);
        const extracted: Buffer[] = [];
        const h = harness({
            platform: "darwin",
            arch: "arm64",
            answer: true,
            overrides: {
                extractTarGz: async (archive, destination) => {
                    extracted.push(readFileSync(archive));
                    mkdirSync(join(destination, DASHBOARD_MAC_APP_NAME, "Contents"), {
                        recursive: true,
                    });
                },
            },
        });
        await offerDashboardInstall([], h.deps);
        expect(extracted).toHaveLength(1);
        expect(extracted[0]?.equals(data)).toBe(true);
        expect(statSync(join(h.applications, DASHBOARD_MAC_APP_NAME)).isDirectory()).toBe(true);
        // The staging directory is gone; only the app remains.
        expect(readdirSync(h.applications)).toEqual([DASHBOARD_MAC_APP_NAME]);
    });

    it("macOS: falls back to ~/Applications when /Applications is not writable", async () => {
        publishRelease(
            "0.20.0",
            "magic-context-dashboard-darwin-x64.app.tar.gz",
            macArchive("mac home"),
        );
        const h = harness({
            platform: "darwin",
            arch: "x64",
            answer: true,
            overrides: {
                extractTarGz: async (_archive, destination) => {
                    mkdirSync(join(destination, DASHBOARD_MAC_APP_NAME), { recursive: true });
                },
            },
        });
        rmSync(h.applications, { recursive: true });
        await offerDashboardInstall([], { ...h.deps, macSystemApplicationsDir: h.applications });
        expect(existsSync(join(h.home, "Applications", DASHBOARD_MAC_APP_NAME))).toBe(true);
        expect(existsSync(h.applications)).toBe(false);
        expect(h.lines.join("\n")).toContain("is not writable");
    });

    it("Windows: runs the verified installer", async () => {
        const data = payload("windows");
        publishRelease("0.20.0", "magic-context-dashboard-windows-x64.exe", data);
        const ran: Buffer[] = [];
        let installed: InstalledDashboard | null = null;
        const h = harness({
            platform: "win32",
            arch: "x64",
            answer: true,
            overrides: {
                runWindowsInstaller: async (installer) => {
                    ran.push(readFileSync(installer));
                    installed = {
                        location: "C:\\Users\\me\\AppData\\Local\\Magic Context Dashboard",
                        version: "0.20.0",
                    };
                },
                readWindowsInstall: async () => installed,
            },
        });
        await offerDashboardInstall([], h.deps);
        expect(ran).toHaveLength(1);
        expect(ran[0]?.equals(data)).toBe(true);
        expect(h.lines.join("\n")).toContain("Installed Magic Context Dashboard v0.20.0");
    });

    it("Linux: installs the AppImage executable into ~/.local/bin", async () => {
        const data = payload("linux arm");
        publishRelease("0.20.0", "magic-context-dashboard-linux-arm64.AppImage", data);
        const h = harness({ platform: "linux", arch: "arm64", answer: true });
        await offerDashboardInstall([], h.deps);
        const path = appImagePath(h.home);
        expect(readFileSync(path).equals(data)).toBe(true);
        expect(statSync(path).mode & 0o111).not.toBe(0);
        expect(readdirSync(join(h.home, ".local", "bin"))).toEqual([DASHBOARD_APPIMAGE_NAME]);
    });

    it("unsupported platform: prints the releases page and touches nothing", async () => {
        const h = harness({ platform: "freebsd", arch: "x64" });
        await offerDashboardInstall([], h.deps);
        expect(requests).toEqual([]);
        expect(h.lines.join("\n")).toContain("https://github.com/cortexkit/magic-context/releases");
    });
});

describe("dashboard offer: macOS archive safety", () => {
    it("accepts files, directories and links that stay inside the archive", () => {
        expect(findUnsafeTarEntry(tarArchive(safeAppEntries("ok")))).toBeNull();
    });

    it("refuses absolute paths, .. segments and escaping links", () => {
        const cases: Array<[string, Buffer[]]> = [
            ["absolute name", [tarEntry({ name: "/etc/evil" })]],
            ["leading ..", [tarEntry({ name: "../evil" })]],
            ["inner ..", [tarEntry({ name: `${APP}/../../evil` })]],
            ["ustar prefix ..", [tarEntry({ name: "evil", prefix: "../outside" })]],
            ["absolute symlink", [tarEntry({ name: `${APP}/l`, type: "2", link: "/etc" })]],
            ["symlink ..", [tarEntry({ name: `${APP}/l`, type: "2", link: "../../outside" })]],
            ["hardlink ..", [tarEntry({ name: `${APP}/h`, type: "1", link: "../outside" })]],
            ["hardlink absolute", [tarEntry({ name: `${APP}/h`, type: "1", link: "/etc/passwd" })]],
            ["PAX path ..", [paxEntry({ path: "../evil" }), tarEntry({ name: `${APP}/fine` })]],
            [
                "PAX linkpath ..",
                [
                    paxEntry({ linkpath: "../../x" }),
                    tarEntry({ name: `${APP}/l`, type: "2", link: "ok" }),
                ],
            ],
            [
                "GNU long name ..",
                [
                    tarEntry({ name: "././@LongLink", type: "L", data: Buffer.from("../evil\0") }),
                    tarEntry({ name: `${APP}/fine` }),
                ],
            ],
            ["device node", [tarEntry({ name: `${APP}/dev`, type: "3" })]],
        ];
        for (const [label, entries] of cases) {
            const verdict = findUnsafeTarEntry(tarArchive(entries)) ?? "accepted";
            // Name the case in a failure, and require the path/type reason rather
            // than an unrelated refusal such as truncation.
            expect(`${label}: ${verdict}`).toMatch(/: .*(outside the archive|unsupported type)/);
        }
        const truncated = tarEntry({ name: `${APP}/big`, data: payload("big") }).subarray(0, 700);
        expect(findUnsafeTarEntry(truncated)).toBe("the archive is truncated");
    });

    it("refuses a signed archive with an escaping link before extracting anything", async () => {
        const data = gzipSync(
            tarArchive([
                ...safeAppEntries("hostile"),
                tarEntry({ name: `${APP}/Contents/escape`, type: "2", link: "../../../../etc" }),
            ]),
        );
        publishRelease("0.20.0", "magic-context-dashboard-darwin-arm64.app.tar.gz", data);
        let extractCalls = 0;
        const h = harness({
            platform: "darwin",
            arch: "arm64",
            answer: true,
            overrides: {
                extractTarGz: async () => {
                    extractCalls += 1;
                },
            },
        });
        await offerDashboardInstall([], h.deps);
        expect(extractCalls).toBe(0);
        expect(readdirSync(h.applications)).toEqual([]);
        expect(h.lines.join("\n")).toContain("the app archive is unsafe to extract");
    });
});

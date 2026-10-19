/**
 * The RPC server files its discovery record under `projectHash(directory)` and
 * the TUI looks it up with its own spelling of the same directory. Each pair
 * below is one directory spelled two ways that hosts really produce; both must
 * hash to the same discovery directory, or the TUI finds no server and the
 * sidebar reads zero.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    __setCanonicalDirectoryRealpathForTests,
    canonicalProjectDirectory,
    projectDirectoryKey,
    sameProjectDirectory,
} from "./project-directory-key";
import { projectHash, rpcPortDirsForLookup } from "./rpc-utils";
import { createTestTempDirFromPath } from "./test-temp-dir";

const created: string[] = [];

afterEach(() => {
    __setCanonicalDirectoryRealpathForTests();
    for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WINDOWS_PAIRS: Array<[string, string, string]> = [
    [
        "drive-letter case",
        "C:\\Users\\Amministratore\\Pictures\\TGroup",
        "c:\\Users\\Amministratore\\Pictures\\TGroup",
    ],
    [
        "separators",
        "C:\\Users\\Amministratore\\Pictures\\TGroup",
        "C:/Users/Amministratore/Pictures/TGroup",
    ],
    [
        "trailing separator",
        "C:\\Users\\Amministratore\\Pictures\\TGroup",
        "C:\\Users\\Amministratore\\Pictures\\TGroup\\",
    ],
    [
        "long-path prefix",
        "C:\\Users\\Amministratore\\Pictures\\TGroup",
        "\\\\?\\C:\\Users\\Amministratore\\Pictures\\TGroup",
    ],
    [
        "name case",
        "C:\\Users\\Amministratore\\Pictures\\TGroup",
        "C:\\USERS\\amministratore\\pictures\\tgroup",
    ],
    ["UNC long-path prefix", "\\\\server\\share\\TGroup", "\\\\?\\UNC\\server\\share\\TGroup"],
];

describe("one discovery directory per project directory", () => {
    for (const [name, left, right] of WINDOWS_PAIRS) {
        test(`Windows ${name}`, () => {
            expect(projectDirectoryKey(left)).toBe(projectDirectoryKey(right));
            expect(projectHash(left)).toBe(projectHash(right));
        });
    }

    test("Windows 8.3 short name resolves through the filesystem's realpath", () => {
        // realpathSync.native expands short names on Windows; this host cannot
        // create one, so the realpath is stood in for.
        const long = "C:\\Users\\Amministratore\\Pictures\\Camera Roll\\VikStudio\\TGroup";
        const short = "C:\\Users\\AMMINI~1\\Pictures\\CAMERA~1\\VikStudio\\TGroup";
        __setCanonicalDirectoryRealpathForTests((directory) => {
            if (directory === short || directory === long) return long;
            throw new Error("ENOENT");
        });
        expect(canonicalProjectDirectory(short)).toBe(canonicalProjectDirectory(long));
        expect(projectHash(short)).toBe(projectHash(long));
    });

    test("macOS /var and /private/var", () => {
        const raw = createTestTempDirFromPath(join(tmpdir(), "mc-key-var-"));
        created.push(raw);
        const real = realpathSync(raw);
        if (process.platform === "darwin") expect(real.startsWith("/private/")).toBe(true);
        expect(projectHash(raw)).toBe(projectHash(real));
    });

    test("a symlinked directory and its target", () => {
        const root = realpathSync(createTestTempDirFromPath(join(tmpdir(), "mc-key-link-")));
        created.push(root);
        const target = join(root, "Pictures", "project");
        mkdirSync(target, { recursive: true });
        const link = join(root, "linked-project");
        symlinkSync(target, link);
        expect(projectHash(link)).toBe(projectHash(target));
    });

    test("POSIX trailing slash", () => {
        const root = realpathSync(createTestTempDirFromPath(join(tmpdir(), "mc-key-slash-")));
        created.push(root);
        expect(projectHash(`${root}/`)).toBe(projectHash(root));
    });

    test("different directories still get different discovery directories", () => {
        expect(projectHash("C:\\Users\\A\\one")).not.toBe(projectHash("C:\\Users\\A\\two"));
        expect(projectHash("/tmp/does-not-exist-a")).not.toBe(projectHash("/tmp/does-not-exist-b"));
    });

    test("lookups also read the pre-canonical directory older servers wrote", () => {
        const dirs = rpcPortDirsForLookup("/storage", "C:\\Users\\A\\Proj\\");
        expect(dirs).toHaveLength(2);
        expect(dirs[0]).toBe(join("/storage", "rpc", projectHash("C:\\Users\\A\\Proj\\")));
    });
});

/**
 * Background-session code compares a session's recorded directory with the
 * plugin's own. OpenCode 2 on Windows records `D:/coding/app` while the plugin
 * knows `D:\coding\app`; both must count as one directory, and a different
 * directory must never be taken for this one.
 */
describe("sameProjectDirectory", () => {
    for (const [name, left, right] of WINDOWS_PAIRS) {
        test(`Windows ${name} is the same directory`, () => {
            expect(sameProjectDirectory(left, right)).toBe(true);
            expect(sameProjectDirectory(right, left)).toBe(true);
        });
    }

    test("Windows forward slashes against backslashes, as OpenCode 2 stores them", () => {
        expect(
            sameProjectDirectory(
                "D:/coding/siac/wt/migracion-asincrona",
                "D:\\coding\\siac\\wt\\migracion-asincrona",
            ),
        ).toBe(true);
    });

    test("Windows `.` and `..` segments and a trailing forward slash", () => {
        expect(
            sameProjectDirectory("C:\\Users\\dev\\.\\work\\tmp\\..\\app", "C:/Users/dev/work/app/"),
        ).toBe(true);
    });

    test("POSIX trailing slash and `..` segments", () => {
        expect(sameProjectDirectory("/work/app/", "/work/app")).toBe(true);
        expect(sameProjectDirectory("/work/tmp/../app", "/work/app")).toBe(true);
    });

    test("different directories are refused", () => {
        expect(
            sameProjectDirectory(
                "D:/coding/siac/wt/notificaciones-pui",
                "D:\\coding\\siac\\wt\\migracion-asincrona",
            ),
        ).toBe(false);
        // A sibling whose name extends this one, a parent, and another drive.
        expect(sameProjectDirectory("C:/Users/dev/app-worktree", "C:\\Users\\dev\\app")).toBe(
            false,
        );
        expect(sameProjectDirectory("C:/Users/dev", "C:\\Users\\dev\\app")).toBe(false);
        expect(sameProjectDirectory("D:/Users/dev/app", "C:\\Users\\dev\\app")).toBe(false);
        // POSIX paths are case-sensitive.
        expect(sameProjectDirectory("/work/App", "/work/app")).toBe(false);
    });

    test("an empty directory matches nothing, not even the process's working directory", () => {
        expect(sameProjectDirectory("", process.cwd())).toBe(false);
        expect(sameProjectDirectory(process.cwd(), "")).toBe(false);
        expect(sameProjectDirectory("", "")).toBe(false);
    });
});

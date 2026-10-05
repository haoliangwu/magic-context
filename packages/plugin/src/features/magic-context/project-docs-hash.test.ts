import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { computeProjectDocsHash, readProjectDocsCanonical } from "./project-docs-hash";

const tempDirs: string[] = [];
let nextMtimeMs = Date.now() + 10_000;

afterEach(() => {
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
});

function makeTempDir(prefix: string): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

function writeDoc(
    directory: string,
    filename: "ARCHITECTURE.md" | "STRUCTURE.md",
    content: string,
) {
    const filePath = join(directory, filename);
    writeFileSync(filePath, content, "utf8");
    bumpMtime(filePath);
    return filePath;
}

function bumpMtime(filePath: string) {
    nextMtimeMs += 1_000;
    const timestamp = new Date(nextMtimeMs);
    utimesSync(filePath, timestamp, timestamp);
}

describe("project docs hash", () => {
    it("hashes both project-docs files deterministically", () => {
        const directory = makeTempDir("project-docs-both-");
        writeDoc(directory, "ARCHITECTURE.md", "Architecture\n");
        writeDoc(directory, "STRUCTURE.md", "Structure\n");

        const first = readProjectDocsCanonical(directory);
        const second = readProjectDocsCanonical(directory);

        expect(first).toEqual(second);
        expect(first.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
        expect(first.canonicalHash).toBe(computeProjectDocsHash(directory));
        expect(first.renderedBlock).toContain('<file name="ARCHITECTURE.md">');
        expect(first.renderedBlock).toContain("Architecture");
        expect(first.renderedBlock).toContain('<file name="STRUCTURE.md">');
        expect(first.renderedBlock).toContain("Structure");
    });

    it("hash differs when only ARCHITECTURE.md is present", () => {
        const onlyArchitecture = makeTempDir("project-docs-arch-only-");
        writeDoc(onlyArchitecture, "ARCHITECTURE.md", "Shared content\n");
        const both = makeTempDir("project-docs-both-compare-");
        writeDoc(both, "ARCHITECTURE.md", "Shared content\n");
        writeDoc(both, "STRUCTURE.md", "Shared content\n");

        expect(computeProjectDocsHash(onlyArchitecture)).not.toBe(computeProjectDocsHash(both));
    });

    it("invalidates the cache when STRUCTURE.md is added after the first read", () => {
        const directory = makeTempDir("project-docs-add-structure-");
        writeDoc(directory, "ARCHITECTURE.md", "Architecture\n");
        const initial = readProjectDocsCanonical(directory);

        writeDoc(directory, "STRUCTURE.md", "Structure\n");
        const afterAdd = readProjectDocsCanonical(directory);

        expect(afterAdd.canonicalHash).not.toBe(initial.canonicalHash);
        expect(afterAdd.renderedBlock).toContain('<file name="STRUCTURE.md">');
    });

    it("invalidates the cache when STRUCTURE.md content and mtime change", () => {
        const directory = makeTempDir("project-docs-modify-structure-");
        writeDoc(directory, "ARCHITECTURE.md", "Architecture\n");
        const structurePath = writeDoc(directory, "STRUCTURE.md", "Structure v1\n");
        const initial = readProjectDocsCanonical(directory);

        writeFileSync(structurePath, "Structure v2\n", "utf8");
        bumpMtime(structurePath);
        const afterModify = readProjectDocsCanonical(directory);

        expect(afterModify.canonicalHash).not.toBe(initial.canonicalHash);
        expect(afterModify.renderedBlock).toContain("Structure v2");
    });

    it("normalizes CRLF and LF variants to the same canonical hash", () => {
        const crlf = makeTempDir("project-docs-crlf-");
        writeDoc(crlf, "ARCHITECTURE.md", "Line 1\r\nLine 2\r\n");
        const lf = makeTempDir("project-docs-lf-");
        writeDoc(lf, "ARCHITECTURE.md", "Line 1\nLine 2\n");

        expect(readProjectDocsCanonical(crlf)).toEqual(readProjectDocsCanonical(lf));
    });

    it("strips a UTF-8 BOM before hashing and rendering", () => {
        const withBom = makeTempDir("project-docs-bom-");
        writeDoc(withBom, "ARCHITECTURE.md", "\uFEFFArchitecture\n");
        const withoutBom = makeTempDir("project-docs-no-bom-");
        writeDoc(withoutBom, "ARCHITECTURE.md", "Architecture\n");

        expect(readProjectDocsCanonical(withBom)).toEqual(readProjectDocsCanonical(withoutBom));
    });

    it("strips trailing whitespace per line before hashing", () => {
        const withWhitespace = makeTempDir("project-docs-whitespace-");
        writeDoc(withWhitespace, "ARCHITECTURE.md", "Alpha   \nBeta\t\n");
        const withoutWhitespace = makeTempDir("project-docs-no-whitespace-");
        writeDoc(withoutWhitespace, "ARCHITECTURE.md", "Alpha\nBeta\n");

        expect(readProjectDocsCanonical(withWhitespace)).toEqual(
            readProjectDocsCanonical(withoutWhitespace),
        );
    });

    it("cache hits return the cached hash and rendered block without re-reading files", () => {
        const directory = makeTempDir("project-docs-cache-");
        const architecturePath = writeDoc(directory, "ARCHITECTURE.md", "Architecture\n");
        const initial = readProjectDocsCanonical(directory);

        chmodSync(architecturePath, 0o000);
        try {
            expect(readProjectDocsCanonical(directory)).toEqual(initial);
        } finally {
            chmodSync(architecturePath, 0o644);
        }
    });

    it("renders a stable XML block shape", () => {
        const directory = makeTempDir("project-docs-render-");
        writeDoc(directory, "ARCHITECTURE.md", "Alpha <tag> & beta\n");
        writeDoc(directory, "STRUCTURE.md", "src/ - code\n");

        expect(readProjectDocsCanonical(directory).renderedBlock).toBe(
            [
                "<project-docs>",
                '<file name="ARCHITECTURE.md">',
                "Alpha &lt;tag&gt; &amp; beta",
                "</file>",
                "",
                '<file name="STRUCTURE.md">',
                "src/ - code",
                "</file>",
                "</project-docs>",
            ].join("\n"),
        );
    });
});

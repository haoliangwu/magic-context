import { afterEach, describe, expect, it } from "bun:test";
import {
    chmodSync,
    lstatSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonc } from "../shared/jsonc-parser";
import { createTestTempDirFromPath } from "../shared/test-temp-dir";
import { hasFlatKeys, loadRawConfigFile, migrateFlatDetailed } from "./raw-loader";
import { PER_HARNESS_MIGRATION_INVENTORY } from "./schema/magic-context";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
    const directory = createTestTempDirFromPath(join(tmpdir(), "mc-per-harness-"));
    temporaryDirectories.push(directory);
    return directory;
}

function parse(text: string): Record<string, unknown> {
    const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
    return parseJsonc<Record<string, unknown>>(withoutBom);
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("per-harness raw config migration", () => {
    it("maps flat agent and task fields without moving scheduling fields", () => {
        const input = `\uFEFF{\r
  // preserve this comment\r
  "historian": {\r
    "model": { "model": "provider/historian", "variant": "fast", "thinking_level": "high" }, // historian model note\r
    "fallback_models": [{ "model": "provider/fallback", "variant": "careful", "thinking_level": "low" }],\r
    "variant": "block-variant",\r
    "thinking_level": "medium"\r
  },\r
  "dreamer": {\r
    "model": "provider/dreamer",\r
    "fallback_models": "provider/dreamer-fallback",\r
    "tasks": {\r
      "review": {\r
        "schedule": "0 3 * * *",\r
        "model": { "model": "provider/task", "variant": "task-variant", "thinking_level": "max" },\r
        "thinking_level": "high",\r
        "timeout_minutes": 45\r
      },\r
      "timeout-only": { "timeout_minutes": 15 }\r
    }\r
  },\r
  "unrelated": { "keep": true }\r
}\r
`;

        const migrated = migrateFlatDetailed(Buffer.from(input, "utf-8"));
        const repeated = migrateFlatDetailed(Buffer.from(input, "utf-8"));
        const idempotent = migrateFlatDetailed(migrated.bytes);
        const output = migrated.bytes.toString("utf-8");
        const config = parse(output);
        const historian = config.historian as Record<string, unknown>;
        const dreamer = config.dreamer as Record<string, unknown>;
        const opencodeHistorian = historian.opencode as Record<string, unknown>;
        const piHistorian = historian.pi as Record<string, unknown>;
        const opencodeDreamer = dreamer.opencode as Record<string, unknown>;
        const piDreamer = dreamer.pi as Record<string, unknown>;
        const tasks = dreamer.tasks as Record<string, Record<string, unknown>>;

        expect(migrated.hasFlatKeys).toBe(true);
        expect(repeated.bytes).toEqual(migrated.bytes);
        expect(repeated.diagnostics).toEqual(migrated.diagnostics);
        expect(idempotent.bytes).toEqual(migrated.bytes);
        expect(idempotent.hasFlatKeys).toBe(false);
        expect(idempotent.diagnostics).toEqual([]);
        expect(hasFlatKeys(migrated.bytes)).toBe(false);
        expect(output.startsWith("\uFEFF")).toBe(true);
        expect(output).toContain("// preserve this comment");
        expect(output).toContain("// historian model note");
        expect(output).toContain("\r\n");
        expect(config.unrelated).toEqual({ keep: true });
        expect(historian.model).toBeUndefined();
        expect(opencodeHistorian).toEqual({
            model: { model: "provider/historian", variant: "fast" },
            fallback_models: [{ model: "provider/fallback", variant: "careful" }],
            variant: "block-variant",
        });
        expect(piHistorian).toEqual({
            model: { model: "provider/historian", thinking_level: "high" },
            fallback_models: [{ model: "provider/fallback", thinking_level: "low" }],
            thinking_level: "medium",
        });
        expect(opencodeDreamer.fallback_models).toEqual(["provider/dreamer-fallback"]);
        expect(piDreamer.fallback_models).toEqual(["provider/dreamer-fallback"]);
        expect(tasks.review).toEqual({ schedule: "0 3 * * *" });
        expect(tasks["timeout-only"]).toEqual({});
        expect((opencodeDreamer.tasks as Record<string, Record<string, unknown>>).review).toEqual({
            model: { model: "provider/task", variant: "task-variant" },
            timeout_minutes: 45,
        });
        expect((piDreamer.tasks as Record<string, Record<string, unknown>>).review).toEqual({
            model: { model: "provider/task", thinking_level: "max" },
            thinking_level: "high",
            timeout_minutes: 45,
        });
        expect(
            (opencodeDreamer.tasks as Record<string, Record<string, unknown>>)["timeout-only"],
        ).toEqual({ timeout_minutes: 15 });
        expect(
            (piDreamer.tasks as Record<string, Record<string, unknown>>)["timeout-only"],
        ).toEqual({ timeout_minutes: 15 });
    });

    it("turns a singleton fallback into one entry without changing its spelling", () => {
        const migrated = migrateFlatDetailed(
            Buffer.from(
                JSON.stringify({
                    historian: { fallback_models: "Vendor/Model:Exact-Spelling" },
                }),
            ),
        );
        const historian = parse(migrated.bytes.toString("utf-8")).historian as Record<
            string,
            Record<string, unknown>
        >;

        expect(historian.opencode.fallback_models).toEqual(["Vendor/Model:Exact-Spelling"]);
        expect(historian.pi.fallback_models).toEqual(["Vendor/Model:Exact-Spelling"]);
    });

    it("preserves every schema-enumerated retained field at its original level", () => {
        const historianRetained = {
            temperature: 0.1,
            top_p: 0.9,
            prompt: "historian prompt",
            tools: { read: true },
            disable: false,
            description: "historian description",
            mode: "subagent",
            color: "blue",
            maxSteps: 11,
            permission: { edit: "deny" },
            maxTokens: 4096,
            two_pass: true,
            disallowed_tools: ["bash"],
        };
        const dreamerRetained = {
            temperature: 0.2,
            top_p: 0.8,
            prompt: "dreamer prompt",
            tools: { write: true },
            disable: false,
            description: "dreamer description",
            mode: "subagent",
            color: "purple",
            maxSteps: 12,
            permission: { bash: "deny" },
            maxTokens: 8192,
            inject_docs: false,
        };
        const taskRetained = {
            schedule: "0 3 * * *",
            promotion_threshold: 4,
            recency_days: 30,
        };
        expect(Object.keys(historianRetained)).toEqual(
            PER_HARNESS_MIGRATION_INVENTORY.historian.retained,
        );
        expect(Object.keys(dreamerRetained)).toEqual(
            PER_HARNESS_MIGRATION_INVENTORY.dreamer.retained,
        );
        expect(Object.keys(taskRetained)).toEqual(PER_HARNESS_MIGRATION_INVENTORY.task.retained);

        const migrated = migrateFlatDetailed(
            Buffer.from(
                JSON.stringify({
                    historian: { ...historianRetained, model: "provider/historian" },
                    dreamer: {
                        ...dreamerRetained,
                        model: "provider/dreamer",
                        tasks: {
                            review: {
                                ...taskRetained,
                                model: "provider/task",
                                timeout_minutes: 25,
                            },
                        },
                    },
                }),
            ),
        );
        const config = parse(migrated.bytes.toString("utf-8"));
        const historian = config.historian as Record<string, unknown>;
        const dreamer = config.dreamer as Record<string, unknown>;
        const task = (dreamer.tasks as Record<string, Record<string, unknown>>).review;

        for (const [field, value] of Object.entries(historianRetained)) {
            expect(historian[field]).toEqual(value);
        }
        for (const [field, value] of Object.entries(dreamerRetained)) {
            expect(dreamer[field]).toEqual(value);
        }
        expect(task).toEqual(taskRetained);
    });

    it("fills absent destinations and silently removes equal flat sources", () => {
        const migrated = migrateFlatDetailed(
            Buffer.from(`{
  "historian": {
    "model": "provider/same",
    "opencode": { "model": "provider/same" },
    "pi": {}
  }
}`),
        );
        const historian = parse(migrated.bytes.toString("utf-8")).historian as Record<
            string,
            unknown
        >;

        expect(historian.model).toBeUndefined();
        expect(historian.opencode).toEqual({ model: "provider/same" });
        expect(historian.pi).toEqual({ model: "provider/same" });
        expect(migrated.diagnostics).toEqual([]);
    });

    it("keeps new-shape destinations on conflicts and names both paths in warnings", () => {
        const input = `{
  "historian": {
    "model": "provider/flat",
    "fallback_models": "provider/fallback",
    "opencode": { "model": "provider/opencode", "fallback_models": ["provider/fallback"] },
    "pi": { "model": "provider/pi", "fallback_models": ["provider/fallback"] }
  }
}`;

        const migrated = migrateFlatDetailed(Buffer.from(input));
        const config = parse(migrated.bytes.toString("utf-8"));
        const historian = config.historian as Record<string, unknown>;

        expect(historian.model).toBeUndefined();
        expect(historian.fallback_models).toBeUndefined();
        expect(historian.opencode).toEqual({
            model: "provider/opencode",
            fallback_models: ["provider/fallback"],
        });
        expect(historian.pi).toEqual({
            model: "provider/pi",
            fallback_models: ["provider/fallback"],
        });
        expect(migrated.diagnostics.map((diagnostic) => diagnostic.path)).toEqual([
            "historian.model",
            "historian.model",
        ]);
        expect(migrated.diagnostics[0]?.message).toContain("historian.opencode.model");
        expect(migrated.diagnostics[1]?.message).toContain("historian.pi.model");
    });

    it("processes flat keys re-added after migration while existing blocks keep winning", () => {
        const first = migrateFlatDetailed(
            Buffer.from(JSON.stringify({ historian: { model: "provider/original" } })),
        );
        const reintroduced = parse(first.bytes.toString("utf-8"));
        (reintroduced.historian as Record<string, unknown>).model = "provider/re-added";

        const second = migrateFlatDetailed(Buffer.from(JSON.stringify(reintroduced)));
        const historian = parse(second.bytes.toString("utf-8")).historian as Record<
            string,
            unknown
        >;

        expect(historian.model).toBeUndefined();
        expect(historian.opencode).toEqual({ model: "provider/original" });
        expect(historian.pi).toEqual({ model: "provider/original" });
        expect(second.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
            expect.stringContaining("historian.opencode.model"),
            expect.stringContaining("historian.pi.model"),
        ]);
    });

    it("rewrites user config atomically with one exact-byte restricted backup", () => {
        const directory = temporaryDirectory();
        const configPath = join(directory, "magic-context.jsonc");
        const original = Buffer.from(
            '{\n  "dreamer": { "tasks": { "review": { "timeout_minutes": 30 } } }\n}\n',
        );
        writeFileSync(configPath, original);
        chmodSync(configPath, 0o600);
        const expected = migrateFlatDetailed(original).bytes;
        let temporaryNamesDuringWrite: string[] = [];

        const first = loadRawConfigFile({
            configPath,
            tier: "user",
            afterTemporaryWrite: () => {
                expect(readFileSync(configPath)).toEqual(original);
                temporaryNamesDuringWrite = readdirSync(directory).filter((name) =>
                    name.endsWith(".tmp"),
                );
                expect(temporaryNamesDuringWrite).toHaveLength(1);
                expect(
                    readFileSync(join(directory, temporaryNamesDuringWrite[0] as string)),
                ).toEqual(expected);
            },
        });
        const second = loadRawConfigFile({ configPath, tier: "user" });
        const backupPath = `${configPath}.pre-per-harness.bak`;

        expect(first?.migrated).toBe(true);
        expect(first?.warnings).toContain(
            "Migrated flat historian/dreamer model config to per-harness blocks.",
        );
        expect(readFileSync(backupPath)).toEqual(original);
        expect(readFileSync(configPath)).toEqual(first?.bytes);
        expect(temporaryNamesDuringWrite).toHaveLength(1);
        expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
        expect(statSync(backupPath).mode & 0o777).toBe(0o600);
        expect(second?.migrated).toBe(false);
        expect(second?.warnings).toEqual([]);
    });

    it("repairs a truncated migration backup left by the direct-write protocol", () => {
        const directory = temporaryDirectory();
        const configPath = join(directory, "magic-context.jsonc");
        const backupPath = `${configPath}.pre-per-harness.bak`;
        const original = Buffer.from('{ "historian": { "model": "provider/model" } }\n');
        writeFileSync(configPath, original);
        writeFileSync(backupPath, original.subarray(0, 17));

        const loaded = loadRawConfigFile({ configPath, tier: "user" });

        expect(loaded?.migrated).toBe(true);
        expect(readFileSync(backupPath)).toEqual(original);
    });

    it("leaves a completed migration backup with different bytes untouched", () => {
        const directory = temporaryDirectory();
        const configPath = join(directory, "magic-context.jsonc");
        const backupPath = `${configPath}.pre-per-harness.bak`;
        const sentinel = Buffer.from("not config: backup is opaque and permanent\n");
        writeFileSync(configPath, '{ "historian": { "model": "provider/model" } }');
        writeFileSync(backupPath, sentinel);

        const first = loadRawConfigFile({ configPath, tier: "user" });
        const second = loadRawConfigFile({ configPath, tier: "user" });

        expect(first?.migrated).toBe(true);
        expect(second?.migrated).toBe(false);
        expect(readFileSync(backupPath)).toEqual(sentinel);
    });

    it("accepts a matching migration backup without rewriting it", () => {
        const directory = temporaryDirectory();
        const configPath = join(directory, "magic-context.jsonc");
        const backupPath = `${configPath}.pre-per-harness.bak`;
        const original = Buffer.from('{ "historian": { "model": "provider/model" } }\n');
        writeFileSync(configPath, original);
        writeFileSync(backupPath, original);
        const backupInode = statSync(backupPath).ino;

        const loaded = loadRawConfigFile({ configPath, tier: "user" });

        expect(loaded?.migrated).toBe(true);
        expect(readFileSync(backupPath)).toEqual(original);
        expect(statSync(backupPath).ino).toBe(backupInode);
    });

    it("creates user migration backups and replacement configs owner-only", () => {
        if (process.platform === "win32") return;
        const directory = temporaryDirectory();
        const configPath = join(directory, "magic-context.jsonc");
        const original = Buffer.from('{ "historian": { "model": "provider/model" } }\n');
        writeFileSync(configPath, original);
        chmodSync(configPath, 0o644);

        const loaded = loadRawConfigFile({ configPath, tier: "user" });

        expect(loaded?.migrated).toBe(true);
        expect(statSync(configPath).mode & 0o777).toBe(0o600);
        expect(statSync(`${configPath}.pre-per-harness.bak`).mode & 0o777).toBe(0o600);
    });

    // stow, chezmoi and home-manager link the user config into a dotfiles repo.
    // Replacing the link with a regular file would silently stop later edits
    // from reaching that repo, so the migration writes through to the target.
    it("keeps a symlinked user config a symlink and migrates its target", () => {
        const directory = temporaryDirectory();
        const dotfiles = temporaryDirectory();
        const targetPath = join(dotfiles, "magic-context.jsonc");
        const configPath = join(directory, "magic-context.jsonc");
        const original = Buffer.from('{ "historian": { "model": "provider/model" } }\n');
        writeFileSync(targetPath, original);
        chmodSync(targetPath, 0o600);
        symlinkSync(targetPath, configPath);

        const loaded = loadRawConfigFile({ configPath, tier: "user" });

        expect(loaded?.migrated).toBe(true);
        expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
        expect(readlinkSync(configPath)).toBe(targetPath);
        expect(readFileSync(targetPath)).toEqual(loaded?.bytes);
        expect(hasFlatKeys(readFileSync(targetPath))).toBe(false);
        expect(statSync(targetPath).mode & 0o777).toBe(0o600);
        expect(readFileSync(`${configPath}.pre-per-harness.bak`)).toEqual(original);
        expect(readdirSync(dotfiles).filter((name) => name.endsWith(".tmp"))).toEqual([]);
        expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });

    it("reloads the winning candidate when a concurrent loader replaces the target", () => {
        const directory = temporaryDirectory();
        const configPath = join(directory, "magic-context.jsonc");
        const original = Buffer.from('{\n  "historian": { "model": "provider/model" }\n}\n');
        writeFileSync(configPath, original);

        let competing: ReturnType<typeof loadRawConfigFile> | undefined;
        const first = loadRawConfigFile({
            configPath,
            tier: "user",
            afterTemporaryWrite: () => {
                competing ??= loadRawConfigFile({ configPath, tier: "user" });
            },
        });

        expect([first?.migrated, competing?.migrated].filter(Boolean)).toHaveLength(1);
        expect(competing?.migrated).toBe(true);
        expect(first?.migrated).toBe(false);
        expect(first?.warnings).toEqual([]);
        expect(competing?.warnings).toEqual([
            "Migrated flat historian/dreamer model config to per-harness blocks.",
        ]);
        expect(first?.bytes).toEqual(competing?.bytes);
        expect(parse(first?.text ?? "{}")).toEqual(parse(competing?.text ?? "{}"));
        expect(readFileSync(configPath)).toEqual(competing?.bytes);
        expect(readFileSync(`${configPath}.pre-per-harness.bak`)).toEqual(original);
    });

    it("adapts project config in memory without changing bytes or mtime", () => {
        const directory = temporaryDirectory();
        const configPath = join(directory, "magic-context.jsonc");
        const original = Buffer.from(
            '{\n  "dreamer": { "tasks": { "review": { "timeout_minutes": 30 } } }\n}\n',
        );
        writeFileSync(configPath, original);
        const before = statSync(configPath);

        const loaded = loadRawConfigFile({ configPath, tier: "project" });
        const after = statSync(configPath);
        const config = parse(loaded?.text ?? "{}");

        expect(loaded?.migrated).toBe(false);
        expect(loaded?.warnings[0]).toContain("Adapted flat model config in memory");
        expect(readFileSync(configPath)).toEqual(original);
        expect(after.mtimeMs).toBe(before.mtimeMs);
        expect(
            ((config.dreamer as Record<string, unknown>).opencode as Record<string, unknown>).tasks,
        ).toEqual({ review: { timeout_minutes: 30 } });
    });
});

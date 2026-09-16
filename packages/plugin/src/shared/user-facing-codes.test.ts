import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DreamRunFailureClass } from "../features/magic-context/dreamer/storage-dream-runs";
import type { EmbeddingFailureClass } from "../features/magic-context/memory/embedding-failure";
import {
    type CapabilityRefusal,
    dreamFailureCode,
    embeddingFailureCode,
    renderCapabilityRefusal,
    renderDreamFailure,
    renderEmbeddingFailure,
    renderUserFacingFailure,
    USER_FACING_FAILURES,
} from "./user-facing-codes";

const DREAM_CLASSES: DreamRunFailureClass[] = [
    "provider_timeout",
    "provider_error",
    "empty_completion",
    "no_models",
    "child_aborted",
    "parse_failed",
    "unknown",
];

const EMBEDDING_CLASSES: EmbeddingFailureClass[] = [
    "substitution_rejected",
    "http_error",
    "transport_error",
    "invalid_envelope",
    "empty_result",
    "certification_refusal",
    "credential_required",
    "local_binding_missing",
    "local_fs_unavailable",
    "local_download_failure",
    "local_runtime_error",
];

describe("user-facing failure codes", () => {
    test("keeps the closed table unique and renders one calm sentence plus one action", () => {
        const entries = Object.values(USER_FACING_FAILURES);
        expect(new Set(entries.map((entry) => entry.code)).size).toBe(entries.length);
        for (const [key, entry] of Object.entries(USER_FACING_FAILURES)) {
            expect(entry.code).toMatch(/^MC-[CHDERSM]\d{2}$/);
            expect(entry.sentence).toEndWith(".");
            expect(entry.action).toEndWith(".");
            expect(renderUserFacingFailure(key as keyof typeof USER_FACING_FAILURES)).toBe(
                `${entry.sentence} ${entry.action} (${entry.code})`,
            );
        }
    });

    test("uses actionable command and configuration guidance in markdown and plain text", () => {
        expect(renderEmbeddingFailure("local_binding_missing")).toContain(
            "Run `npx @cortexkit/magic-context doctor`, then retry. (MC-E08)",
        );
        expect(renderEmbeddingFailure("local_runtime_error", "plain")).toContain(
            "Run npx @cortexkit/magic-context doctor, then retry. (MC-E11)",
        );
        expect(renderEmbeddingFailure("local_runtime_error", "plain")).not.toContain("`");
        expect(renderEmbeddingFailure("certification_refusal")).toContain(
            "Finish the provider setup, or set a fallback provider in the embedding settings, then run /ctx-embed start again. (MC-E06)",
        );
        expect(renderUserFacingFailure("configuration_warning")).toContain(
            "Fix the configuration warning shown in /ctx-status diagnostics, then restart. (MC-S03)",
        );
        expect(renderUserFacingFailure("session_upgrade_unavailable")).toContain(
            "Run /ctx-recomp instead. (MC-C07)",
        );
    });

    test("maps every structured dream and embedding failure class", () => {
        for (const failureClass of DREAM_CLASSES) {
            expect(renderDreamFailure(failureClass)).toEndWith(
                `(${dreamFailureCode(failureClass)})`,
            );
        }
        for (const failureClass of EMBEDDING_CLASSES) {
            expect(renderEmbeddingFailure(failureClass)).toEndWith(
                `(${embeddingFailureCode(failureClass)})`,
            );
        }
    });

    test("renders every capability refusal without internal vocabulary", () => {
        const capabilities: CapabilityRefusal[] = [
            "memory_write",
            "memory_access",
            "note_change",
            "note_access",
            "context_cleanup",
            "partial_history",
            "session_upgrade",
            "smart_note_condition",
            "history_compression",
            "context_service",
        ];
        for (const capability of capabilities) {
            const rendered = renderCapabilityRefusal(capability);
            expect(rendered).toMatch(/\(MC-C\d{2}\)$/);
            for (const forbidden of ["authority", "MODULE", "drain", "facade", "changefeed"]) {
                expect(rendered).not.toContain(forbidden);
            }
        }
    });

    test("source fence keeps raw exceptions out of user-facing reply builders", () => {
        const builders = [
            "hooks/magic-context/command-handler.ts",
            "hooks/magic-context/compartment-runner-validation.ts",
            "hooks/magic-context/compartment-runner-recomp.ts",
            "hooks/magic-context/compartment-runner-partial-recomp.ts",
            "hooks/magic-context/format-embed-failure.ts",
            "hooks/magic-context/recomp-orchestrator.ts",
            "shared/status-detail-text.ts",
            "../../pi-plugin/src/commands/ctx-dream.ts",
            "../../pi-plugin/src/commands/ctx-status.ts",
        ];
        const allowedLogFragments = ["command notification delivery failed", "/ctx-dream failed"];
        const violations: string[] = [];
        for (const relativePath of builders) {
            const path = resolve(import.meta.dir, "..", relativePath);
            const lines = readFileSync(path, "utf8").split("\n");
            lines.forEach((line, index) => {
                if (
                    !/(error\.message|String\((?:err|error)\)|describeError\([^)]*\)\.brief)/.test(
                        line,
                    )
                ) {
                    return;
                }
                if (allowedLogFragments.some((fragment) => line.includes(fragment))) return;
                violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
            });
        }
        expect(violations).toEqual([]);
    });
});

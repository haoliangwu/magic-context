/**
 * Every payload the `/ctx-status` dialog can receive, from the cases that were
 * reproduced on a real OpenCode 1.18.30 TUI for issue 584: each one must turn
 * into a drawable view, and none may throw. The home-directory and
 * paused-identity replies are the ones that crashed the TUI with
 * "undefined is not an object (evaluating 'view().headline')".
 */
import { describe, expect, test } from "bun:test";
import { buildStatusViewFor, type StatusView } from "./status-view";
import {
    checkStatusDetailPayload,
    statusRpcFailure,
    statusVersionNotice,
} from "./status-view-check";

const UI = "0.44.5";
const NOW = 1_790_765_900_000;

/**
 * A `status-detail` reply captured from a real 0.42.6 server (sessionId and
 * the dreamer backlog trimmed). It predates `pluginVersion`,
 * `compactionMarker` and the other 0.44 fields.
 */
const V0426_DETAIL = {
    sessionId: "ses_f0e0a60ebffeHorSVS4EaCi21f",
    usagePercentage: 1.2512512512512513,
    inputTokens: 2400,
    contextLimit: 191808,
    native_context_usage_percentage: 1.2,
    compaction_enabled: true,
    systemPromptTokens: 501,
    compartmentCount: 0,
    archivedCompartmentCount: 0,
    memoryCount: 0,
    memoryBlockCount: 0,
    pendingOpsCount: 0,
    historianRunning: false,
    compartmentInProgress: false,
    sessionNoteCount: 0,
    readySmartNoteCount: 0,
    cacheTtl: "5m",
    lastTransformError: null,
    lastDreamerRunAt: null,
    projectIdentity: "git:e336ae3adbf8494e99a54cbfda6abff75804f693",
    dreamerProgress: null,
    compartmentTokens: 1,
    factTokens: 0,
    memoryTokens: 0,
    docsTokens: 0,
    profileTokens: 0,
    conversationTokens: 0,
    toolCallTokens: 0,
    toolDefinitionTokens: 1898,
    tailHygiene: {
        u: 6,
        t: 6,
        severity: 1,
        evaluable: true,
        generationInvalidated: false,
        baselineGeneration: 1,
        computedAt: 1790765801961,
        reclaimableToolOutputCount: 0,
    },
    executeThreshold: 40,
    newWorkTokens: 2420,
    totalInputTokens: 2400,
    recompProgress: null,
    hostBackendsModuleSide: false,
    memoryAuthorityMismatch: false,
    activeProfile: null,
    tagCounter: 1,
    activeTags: 1,
    droppedTags: 0,
    totalTags: 1,
    tagCountsAuthoritative: true,
    activeBytes: 16,
    lastResponseTime: 1790765802064,
    lastNudgeTokens: 0,
    historianFailureCount: 0,
    isSubagent: false,
    pendingOps: [],
    cacheTtlMs: 300000,
    cacheRemainingMs: 279327,
    cacheExpired: false,
    cacheTtlSource: "session",
    configParseFailures: [],
    cacheNeverExpires: false,
    executeThresholdMode: "percentage",
    protectedTagCount: 0,
    historyBudgetPercentage: 0.15,
    historyBlockTokens: 1,
    compressionBudget: 11508,
    compressionUsage: "0%",
    toastDurationMs: 5000,
    loggerDiagnostics: { swallowedWriteCount: 0, lastErrorMessage: null, lastErrorTime: null },
    storage_versions: { context_db_schema_version: 85, plugin_supported_version: 85 },
    cacheTtlModelKey: "mock-anthropic/mock-sonnet",
    embedding: { state: "waiting", indexed: 0, total: 0 },
};

/** The same snapshot as a current server sends it: same fields plus its version. */
const CURRENT_DETAIL = { ...V0426_DETAIL, pluginVersion: UI };

function render(raw: unknown): StatusView {
    return buildStatusViewFor(checkStatusDetailPayload(raw, UI), { version: UI, now: NOW });
}

function warningText(view: StatusView): string {
    return view.warnings.map((warning) => warning.text).join("\n");
}

function reasonRow(view: StatusView): string | undefined {
    return view.sections.flatMap((section) => section.rows).find((row) => row.label === "Reason")
        ?.value;
}

describe("status payloads the dialog receives", () => {
    test("a current, complete snapshot draws the full view with no notices", () => {
        const view = render(CURRENT_DETAIL);
        expect(view.headline.left.text).toBe("1.3% / 40%");
        expect(view.headline.right.text).toBe("2K / 192K tokens");
        expect(view.sections.map((section) => section.title)).toContain("Cache TTL");
        expect(view.warnings).toEqual([]);
    });

    test("a transport failure names the RPC error", () => {
        const view = buildStatusViewFor(statusRpcFailure("connect ECONNREFUSED 127.0.0.1:52206"), {
            version: UI,
        });
        expect(view.headline.left).toEqual({ text: "Status unavailable", tone: "error" });
        expect(reasonRow(view)).toBe("server did not answer");
        expect(warningText(view)).toContain("connect ECONNREFUSED 127.0.0.1:52206");
        expect(warningText(view)).toContain("(MC-S01)");
    });

    test("an error envelope names the server's error", () => {
        // What a 0.42.6 server answered on a real host once a newer build had
        // migrated the shared store to a schema version it does not support.
        const view = render({ error: "unavailable" });
        expect(reasonRow(view)).toBe("server did not answer");
        expect(warningText(view)).toContain("did not return status: unavailable");
        // A bare envelope says nothing about the server's age.
        expect(warningText(view)).not.toContain("older Magic Context");
    });

    test("the home-directory reply draws the unavailable view instead of crashing", () => {
        // Exactly what a 0.44.4 server sends for the user's home directory.
        const view = render({ sessionId: "ses_home", disabled: true });
        expect(view.headline.left.text).toBe("Status unavailable");
        expect(reasonRow(view)).toBe("home directory");
        expect(warningText(view)).toContain("allow_home_project");
    });

    test("the paused-identity reply draws the unavailable view instead of crashing", () => {
        const view = render({
            sessionId: "ses_paused",
            disabled: true,
            paused: true,
            pluginVersion: UI,
        });
        expect(reasonRow(view)).toBe("memory paused");
        expect(warningText(view)).toContain("memory features paused");
        expect(warningText(view)).not.toContain("older Magic Context");
    });

    test("an empty reply names the missing fields", () => {
        const view = render({});
        expect(reasonRow(view)).toBe("incomplete status data");
        expect(warningText(view)).toContain("usagePercentage");
        expect(warningText(view)).toContain("cacheTtl");
    });

    test("a partial reply names exactly the fields that are missing or mistyped", () => {
        const { usagePercentage: _dropped, ...partial } = CURRENT_DETAIL;
        const view = render({ ...partial, cacheExpired: "no" });
        const check = checkStatusDetailPayload({ ...partial, cacheExpired: "no" }, UI);
        expect(check.state === "unavailable" && check.reason).toEqual({
            kind: "malformed",
            fields: ["usagePercentage", "cacheExpired"],
        });
        expect(warningText(view)).toContain("usagePercentage, cacheExpired");
    });

    test("a non-object reply is unavailable, not a crash", () => {
        expect(reasonRow(render(null))).toBe("incomplete status data");
        expect(reasonRow(render("ok"))).toBe("incomplete status data");
    });

    test("a 0.42.6 server's snapshot draws the full view and says an older server is running", () => {
        const view = render(V0426_DETAIL);
        expect(view.headline.left.text).toBe("1.3% / 40%");
        expect(warningText(view)).toContain("An older Magic Context server");
        expect(warningText(view)).toContain("quit all OpenCode processes");
    });

    test("a server reporting an older version is named with its version", () => {
        const view = render({ ...CURRENT_DETAIL, pluginVersion: "0.42.6" });
        expect(view.headline.left.text).toBe("1.3% / 40%");
        expect(view.warnings[0]).toEqual({
            text: `An older Magic Context (0.42.6) server is still running, while this UI is ${UI}: quit all OpenCode processes, then start OpenCode again`,
            tone: "warning",
        });
    });

    test("a malformed reply from an older server names the version difference first", () => {
        const view = render({ sessionId: "s", pluginVersion: "0.42.6" });
        expect(view.warnings[0]?.text).toContain("An older Magic Context (0.42.6) server");
        expect(warningText(view)).toContain("The version difference above is the likely cause.");
    });

    test("optional fields with an unexpected shape are dropped and listed, not drawn", () => {
        const view = render({
            ...CURRENT_DETAIL,
            // Each of these used to throw inside the view model.
            windowGeometry: { usableSoft: 1 },
            dreamerUnsupportedTasks: { curate: true },
            hiddenVariantWarnings: "one",
            hostLimitations: ["a_code_from_a_newer_server"],
        });
        expect(view.headline.left.text).toBe("1.3% / 40%");
        expect(view.windowLine).toBeNull();
        expect(warningText(view)).toContain(
            "Ignored status fields with an unexpected shape: windowGeometry, dreamerUnsupportedTasks, hiddenVariantWarnings, hostLimitations",
        );
    });

    test("a migration run past an unchecked holder is reported", () => {
        const view = render({
            ...CURRENT_DETAIL,
            unconfirmedMigrationHolders: { pids: [10376], fromVersion: 85, toVersion: 91 },
        });
        expect(warningText(view)).toContain(
            "upgraded its database from v85 to v91 while OpenCode PID 10376 could not be checked",
        );
    });
});

describe("version notice", () => {
    test("equal versions and in-process status carry no notice", () => {
        expect(statusVersionNotice({ server: UI, ui: UI })).toBeNull();
        expect(statusVersionNotice(null)).toBeNull();
    });

    test("a newer server asks for a restart", () => {
        expect(statusVersionNotice({ server: "0.45.0", ui: "0.44.10" })).toBe(
            "Magic Context server is 0.45.0, this UI is 0.44.10: restart OpenCode",
        );
        // Numeric, not lexical: 0.44.10 is newer than 0.44.9.
        expect(statusVersionNotice({ server: "0.44.9", ui: "0.44.10" })).toContain(
            "An older Magic Context (0.44.9) server",
        );
    });
});

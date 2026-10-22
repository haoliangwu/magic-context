/**
 * SQLite chokepoint — runtime-detected backend selection.
 *
 * The same shipped plugin artifact must run under two different runtimes:
 *   - Bun (current OpenCode releases) → uses `bun:sqlite` (built-in, fast)
 *   - Node / Electron (Pi plugin, OpenCode Desktop) → uses `node:sqlite`
 *     (`DatabaseSync`, built into Node 22.5+ / Electron 41+, stable-enough and
 *     flag-free since Node 22.13/23.4).
 *
 * Bun has no `node:sqlite`, and Node/Electron have no `bun:sqlite`. Static
 * imports of either would crash at parse time in the wrong runtime, so the
 * selected backend is loaded only after runtime detection.
 *
 * Why `node:sqlite` instead of `better-sqlite3`: better-sqlite3 is a native
 * module requiring per-ABI prebuilds, and Electron's ABI never matches the npm
 * Node prebuild — which forced a runtime download of an Electron-matched
 * `.node` binary (a supply-chain + maintenance liability). `node:sqlite` is
 * built into the runtime, so there is NOTHING to download or rebuild. Both Pi
 * (plain Node 24) and OpenCode Desktop (Electron 41 → Node 24.14.1) ship it.
 *
 * API surface we use (common across both backends, modulo the shims below):
 *   - new Database(path, { readonly?: boolean })   ← we map readonly→readOnly
 *   - db.prepare(sql).run/get/all
 *   - db.exec(multistatement)
 *   - db.transaction(fn) → wrapped function        ← shimmed for node:sqlite
 *   - db.close()
 *
 * The three backend differences we bridge for node:sqlite:
 *   1. node:sqlite has no `db.transaction(fn)` helper — we add a savepoint-aware
 *      shim (below) that matches better-sqlite3/bun semantics.
 *   2. node:sqlite's constructor option is `readOnly` (camel-case), not
 *      better-sqlite3/bun's `readonly` — we translate it so call sites are
 *      unchanged.
 *   3. node:sqlite reads a lone array bind arg (`.run([a,b])`) as NAMED params
 *      and throws `Unknown named parameter '0'`; bun binds it positionally. We
 *      normalize it in the `prepare()` override (below) so the bind surface is
 *      identical (issue #151 / Pi /ctx-dream).
 * Everything else (named params with bare keys, ATTACH under defensive mode,
 * `run()` → {changes,lastInsertRowid}) is identical and was verified directly.
 */

import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { statSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Type import only — runtime is loaded dynamically below. @types/better-sqlite3
// has the richest definitions and is a structural superset of the API surface
// we use, so calls typed against BetterSqlite3 work under bun:sqlite and
// node:sqlite at runtime (both expose prepare/run/get/all/exec/close).
import type BetterSqlite3 from "better-sqlite3";

// Capture the root before creating request-local AsyncLocalStorage scopes.
// Shared workers and timers must not inherit callbacks that reject stale
// database writes: those callbacks can retain an obsolete request's inputs.
const resourceRoot = new AsyncResource("magic-context:root");

/** Create host-owned resources without inheriting request-local state. */
export function inRootAsyncContext<T>(operation: () => T): T {
    return resourceRoot.runInAsyncScope(operation);
}

/**
 * Slow-write reporting is injected rather than imported: this module is also
 * executed directly by Node (the `node:sqlite` smoke in CI, Pi, Desktop), and
 * Node's type-stripping loader does not resolve extensionless imports, so any
 * static import of the plugin's logging chain here breaks that path. The
 * storage bootstrap registers the real reporter; until then slow privileged
 * writes are simply not logged.
 */
type SlowWriteReporter = (site: string, transactionStartedAt: number) => void;
let reportSlowPrivilegedWrite: SlowWriteReporter | undefined;

export function registerSlowWriteReporter(reporter: SlowWriteReporter): void {
    reportSlowPrivilegedWrite = reporter;
}

/**
 * Writer acquisition and hold diagnostics are injected the same way. They must
 * reach the Magic Context log file and never the console: OpenCode and Pi pass
 * plugin stderr straight through to the operator's terminal. The storage
 * bootstrap registers the shared logger here; until then these lines are
 * dropped.
 */
type SqliteDiagnosticSink = (message: string) => void;
let sqliteDiagnosticSink: SqliteDiagnosticSink | undefined;
let sqliteDiagnosticHost: () => string = () => "unknown";

export function registerSqliteDiagnosticSink(
    sink: SqliteDiagnosticSink,
    host?: () => string,
): void {
    sqliteDiagnosticSink = sink;
    if (host) sqliteDiagnosticHost = host;
}

function reportSqliteDiagnostic(message: string): void {
    try {
        sqliteDiagnosticSink?.(
            `[magic-context] ${message} pid=${process.pid} host=${sqliteDiagnosticHost()}`,
        );
    } catch {
        // Diagnostics must never change the outcome of the write they describe.
    }
}

export type SqliteRuntime = "Bun" | "Node.js";

type SqliteModule = {
    Database?: unknown;
    DatabaseSync?: unknown;
};

export function detectSqliteRuntime(): SqliteRuntime {
    // process.versions.bun is the least ambiguous marker, but some launchers
    // proxy or partially sandbox process. Keep globalThis.Bun as a fallback so
    // a Bun process does not accidentally select node:sqlite just because its
    // process compatibility surface was trimmed.
    const hasBunVersion =
        typeof process !== "undefined" && typeof process.versions?.bun === "string";
    const hasBunGlobal =
        typeof globalThis !== "undefined" &&
        typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
    return hasBunVersion || hasBunGlobal ? "Bun" : "Node.js";
}

// IMPORTANT: bundler-evading dynamic imports.
//
// We can't write `await import("node:sqlite")` directly because esbuild/bun
// would try to resolve both modules at build time, and one of them won't exist
// in the build runtime (bun:sqlite is missing in Node, node:sqlite is missing
// in Bun). Earlier versions used `new Function("p", "return import(p)")(...)`
// to defeat static analysis, but that breaks Pi's vm-based extension loader: a
// Function constructed at runtime has no module record, so `import()` inside it
// has no referrer module and Node throws "A dynamic import callback was not
// specified".
//
// The /* @vite-ignore */ + variable indirection pattern hides the specifier
// from static analyzers while keeping a real referrer module for the
// dynamic import — Pi's loader, esbuild, and bun build all accept it.
const bunSpec = "bun:" + "sqlite";
const nodeSpec = "node:" + "sqlite";

async function importSqliteModule(specifier: string): Promise<SqliteModule> {
    if (specifier === nodeSpec && typeof process.getBuiltinModule === "function") {
        const loaded = process.getBuiltinModule(specifier) as SqliteModule | undefined;
        if (loaded) return loaded;
        throw Object.assign(new Error(`No such built-in module: ${specifier}`), {
            code: "ERR_UNKNOWN_BUILTIN_MODULE",
        });
    }
    // The runtime chooses this specifier; Vite must not resolve it as a
    // build-time dependency because the other runtime's backend is absent.
    return (await import(
        /* @vite-ignore -- keep the runtime-selected backend unresolved */ specifier
    )) as SqliteModule;
}

function isModuleNotFoundError(error: unknown, specifier: string): boolean {
    const candidate = error as { code?: unknown; name?: unknown } | null;
    const code = typeof candidate?.code === "string" ? candidate.code : "";
    const name = typeof candidate?.name === "string" ? candidate.name : "";
    const message = error instanceof Error ? error.message : String(error ?? "");
    const details = `${code} ${name} ${message}`.toLowerCase();
    const mentionsSpecifier = details.includes(specifier.toLowerCase());
    if (!mentionsSpecifier) return false;

    return (
        code === "ERR_MODULE_NOT_FOUND" ||
        code === "ERR_UNKNOWN_BUILTIN_MODULE" ||
        code === "MODULE_NOT_FOUND" ||
        name === "ResolveMessage" ||
        details.includes("module not found") ||
        details.includes("cannot find module") ||
        details.includes("cannot find package") ||
        details.includes("no such built-in module")
    );
}

export class SqliteRuntimeUnavailableError extends Error {
    readonly runtime: SqliteRuntime;
    readonly specifier: string;

    constructor(runtime: SqliteRuntime, specifier: string, cause: unknown) {
        const requirement =
            specifier === nodeSpec
                ? "Requires Node.js >= 24, or Bun with bun:sqlite — this Bun build lacks node:sqlite."
                : "Requires Bun with bun:sqlite, or Node.js >= 24 — this Bun build lacks bun:sqlite.";
        super(
            `Magic Context detected ${runtime}, but could not load ${specifier}. ${requirement}`,
            { cause },
        );
        this.name = "SqliteRuntimeUnavailableError";
        this.runtime = runtime;
        this.specifier = specifier;
    }
}

// Node requests this warning during node:sqlite's module evaluation, although
// warning delivery happens later. Intercept only the request while importing;
// replacing warning listeners would not suppress the default stderr output.
function isNodeSqliteExperimentalWarning(args: unknown[]): boolean {
    const [warning, options] = args;
    const message = warning instanceof Error ? warning.message : warning;
    const type =
        typeof options === "string"
            ? options
            : options && typeof options === "object"
              ? (options as { type?: unknown }).type
              : undefined;
    return (
        type === "ExperimentalWarning" &&
        typeof message === "string" &&
        message.startsWith("SQLite is an experimental feature")
    );
}

async function importSqliteModuleForRuntime(
    runtime: SqliteRuntime,
    specifier: string,
    importer: (specifier: string) => Promise<SqliteModule>,
): Promise<SqliteModule> {
    if (runtime !== "Node.js") return importer(specifier);

    const originalEmitWarning = process.emitWarning;
    process.emitWarning = function (this: unknown, ...args: unknown[]): void {
        if (isNodeSqliteExperimentalWarning(args)) return;
        Reflect.apply(originalEmitWarning, this, args);
    } as typeof process.emitWarning;
    try {
        return await importer(specifier);
    } finally {
        process.emitWarning = originalEmitWarning;
    }
}

export async function loadSqliteModule(
    runtime: SqliteRuntime = detectSqliteRuntime(),
    importer: (specifier: string) => Promise<SqliteModule> = importSqliteModule,
): Promise<SqliteModule> {
    const specifier = runtime === "Bun" ? bunSpec : nodeSpec;
    try {
        return await importSqliteModuleForRuntime(runtime, specifier, importer);
    } catch (error) {
        if (isModuleNotFoundError(error, specifier)) {
            throw new SqliteRuntimeUnavailableError(runtime, specifier, error);
        }
        throw error;
    }
}

const detectedRuntime = detectSqliteRuntime();
const isBun = detectedRuntime === "Bun";
const sqliteModule = await loadSqliteModule(detectedRuntime);

// Different export shapes between the two backends:
//   - bun:sqlite  → named export `Database` (has its own .transaction, accepts
//     `{ readonly }`) — usable as-is.
//   - node:sqlite → named export `DatabaseSync` (no .transaction, option is
//     `readOnly`) — wrapped below.
const DatabaseImpl: typeof BetterSqlite3 = isBun
    ? (sqliteModule.Database as typeof BetterSqlite3)
    : buildNodeSqliteDatabaseClass(sqliteModule.DatabaseSync);
let immutableDatabaseImpl: typeof BetterSqlite3 | undefined;

interface TrackedSqliteConnection {
    sequence: number;
    filename: string;
    readonly: boolean;
    reference: WeakRef<BetterSqlite3.Database>;
}

export interface SqliteConnectionMemoryStats {
    sequence: number;
    filename: string;
    readonly: boolean;
    pageSize: number | null;
    pageCount: number | null;
    freelistCount: number | null;
    cacheSize: number | null;
    cacheSizeUnit: "pages" | "kib" | null;
    cacheUpperBoundBytes: number | null;
    mmapSizeBytes: number | null;
    walFileBytes: number | null;
    shmFileBytes: number | null;
    fts5TableCount: number | null;
    journalMode: string | null;
}

export interface SqliteMemoryStats {
    connectionCount: number;
    cacheUpperBoundBytes: number;
    mmapUpperBoundBytes: number;
    walFileBytes: number;
    shmFileBytes: number;
    sqliteStatusApi: "unavailable";
    connections: SqliteConnectionMemoryStats[];
}

const trackedSqliteConnections = new Map<number, TrackedSqliteConnection>();
let nextSqliteConnectionSequence = 1;

/**
 * Columns of Magic Context's `tags` table (context.db) that never decide which
 * message a tag belongs to, its number, its type, or its reasoning token estimate.
 */
const TAG_COLUMNS_OUTSIDE_IDENTITY = new Set([
    "status",
    "drop_mode",
    "byte_size",
    "input_byte_size",
    "reasoning_byte_size",
    "token_count",
    "input_token_count",
    "caveman_depth",
    "entry_fingerprint",
    "tool_name",
    "harness",
]);

let tagIdentityWriteGeneration = 0;

/**
 * Whether a write statement may change an existing `tags` row's identity
 * (session, number, type, owner message, reasoning token count) or remove a
 * row. Plain appends without an explicit `id`, and updates that assign only
 * columns in {@link TAG_COLUMNS_OUTSIDE_IDENTITY}, cannot; everything else that
 * names the table is treated as if it could, including DDL and multi-statement
 * scripts. Erring towards true only costs a cache rebuild.
 */
export function mayChangeTagIdentity(sql: string): boolean {
    if (!/\btags\b/i.test(sql) || /^\s*(?:SELECT|EXPLAIN|PRAGMA)\b/i.test(sql)) return false;
    if (/^\s*WITH\b/i.test(sql) && !/\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) return false;
    // One statement only: a script can hide a DELETE behind a harmless first statement.
    if (/;\s*\S/.test(sql) || /\bREPLACE\b/i.test(sql) || /\bON\s+CONFLICT\b/i.test(sql))
        return true;
    const insert = /^\s*INSERT\s+INTO\s+(?:main\.)?["`]?tags["`]?\s*\(([^)]*)\)/i.exec(sql);
    if (insert) {
        const columns = (insert[1] ?? "").split(",").map((column) =>
            column
                .trim()
                .replace(/["`[\]]/g, "")
                .toLowerCase(),
        );
        return columns.includes("id") || columns.includes("rowid");
    }
    const update = /^\s*UPDATE\s+(?:main\.)?["`]?tags["`]?\s+SET\s+([\s\S]*?)\bWHERE\b/i.exec(sql);
    if (update && !/\bSELECT\b/i.test(sql)) {
        // Provably identity-free only when every top-level assignment is a plain
        // `column = ...` naming an allowed column. A tuple assignment such as
        // `(tag_number, reasoning_token_count) = (...)`, or anything this cannot
        // read, counts as an identity write.
        const assignments = topLevelCommaSegments(update[1] ?? "");
        if (!assignments) return true;
        return !assignments.every((assignment) => {
            const column = /^\s*["`]?(\w+)["`]?\s*=(?!=)/.exec(assignment)?.[1];
            return column !== undefined && TAG_COLUMNS_OUTSIDE_IDENTITY.has(column.toLowerCase());
        });
    }
    return true;
}

/**
 * Split SQL text at commas outside parentheses and quotes. Returns null when
 * the parentheses or quotes do not balance.
 */
function topLevelCommaSegments(text: string): string[] | null {
    const segments: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (quote) {
            // A doubled quote inside a quoted run is an escaped quote.
            if (char === quote) {
                if (text[index + 1] === quote) index += 1;
                else quote = null;
            }
            continue;
        }
        if (char === "'" || char === '"' || char === "`") quote = char;
        else if (char === "(") depth += 1;
        else if (char === ")") {
            depth -= 1;
            if (depth < 0) return null;
        } else if (char === "," && depth === 0) {
            segments.push(text.slice(start, index));
            start = index + 1;
        }
    }
    if (quote || depth !== 0) return null;
    segments.push(text.slice(start));
    return segments;
}

/**
 * Counts executions, on any connection this process opened, of statements for
 * which {@link mayChangeTagIdentity} is true. A cache built from `tags` stays
 * valid for this process's own writes while the count is unchanged; commits by
 * other connections show up in `PRAGMA data_version` instead.
 */
export function getTagIdentityWriteGeneration(): number {
    return tagIdentityWriteGeneration;
}

/** Route native Bun and Node transaction entry through the same acquisition retry.
 * Native Bun transaction wrappers execute BEGIN internally, bypassing an exec override,
 * so both runtimes use this small synchronous wrapper instead. Writable handles
 * default to IMMEDIATE; explicit deferred calls and readonly handles keep read
 * snapshots without acquiring the writer lock. */
function installTransactionRouting(db: BetterSqlite3.Database, readonly: boolean): void {
    const nativeExec = db.exec.bind(db);
    Object.defineProperty(db, "exec", {
        configurable: true,
        writable: true,
        value: (sql: string) => {
            if (/^\s*(?:COMMIT|END)\b/i.test(sql)) assertTransformWrite();
            if (/^\s*BEGIN\s+(?:IMMEDIATE|EXCLUSIVE)(?:\s+TRANSACTION)?\s*;?\s*$/i.test(sql)) {
                // A transaction that ended without passing through exec (for
                // example an automatic rollback) must not be timed as this one.
                openWriterTransactions.delete(db);
                if (transformPassScope.getStore()?.active || backgroundWriterScope.getStore()) {
                    acquireShort(db, () => nativeExec(sql), sql.trim());
                } else {
                    nativeExec(sql);
                    openWriterTransactions.set(db, {
                        site: sql.trim(),
                        lane: "background",
                        acquireMs: 0,
                        attempts: 1,
                        acquiredAt: performance.now(),
                    });
                }
                return db;
            }
            if (WRITER_TRANSACTION_END.test(sql) && openWriterTransactions.has(db))
                return endWriterTransaction(db, () => nativeExec(sql), sql);
            if (
                !/^\s*(?:SELECT|EXPLAIN|PRAGMA|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(sql)
            ) {
                try {
                    // exec can commit a script prefix before BUSY. Run it once;
                    // only prepared statements are safe to probe and retry.
                    return withAutocommitTimeout(db, () => nativeExec(sql), false);
                } finally {
                    if (mayChangeTagIdentity(sql)) tagIdentityWriteGeneration += 1;
                }
            }
            return nativeExec(sql);
        },
    });
    const nativePrepare = db.prepare.bind(db);
    Object.defineProperty(db, "prepare", {
        configurable: true,
        writable: true,
        value: (sql: string) => {
            const statement = nativePrepare(sql);
            // SELECT/EXPLAIN cannot acquire a writer. Treat CTEs conservatively:
            // WITH can introduce INSERT/UPDATE/DELETE as well as a read query.
            if (!readonly && !/^\s*(?:SELECT|EXPLAIN|PRAGMA)\b/i.test(sql)) {
                const changesTagIdentity = mayChangeTagIdentity(sql);
                for (const method of ["run", "get", "all"] as const) {
                    const execute = statement[method].bind(statement);
                    Object.defineProperty(statement, method, {
                        configurable: true,
                        // biome-ignore lint/suspicious/noExplicitAny: retain SQLite's native binding overloads.
                        value: (...args: any[]) => {
                            try {
                                return withAutocommitTimeout(db, () => execute(...args));
                            } finally {
                                if (changesTagIdentity) tagIdentityWriteGeneration += 1;
                            }
                        },
                    });
                }
                if (changesTagIdentity) wrapRemainingTagWriteForms(statement);
            }
            return statement;
        },
    });
    Object.defineProperty(db, "transaction", {
        configurable: true,
        writable: true,
        // biome-ignore lint/suspicious/noExplicitAny: preserve the native callback's receiver and argument types.
        value: (fn: (...args: any[]) => any) => {
            const make = (mode: "IMMEDIATE" | "EXCLUSIVE" | "DEFERRED") =>
                function (this: unknown, ...args: unknown[]): unknown {
                    const nested = isInTransaction(db);
                    // Equal savepoint names stack LIFO, matching both native backends.
                    const savepoint = "mc_tx_sp";
                    db.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`);
                    try {
                        const result = fn.apply(this, args);
                        db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
                        return result;
                    } catch (error) {
                        if (isInTransaction(db)) {
                            if (nested) {
                                db.exec(`ROLLBACK TO ${savepoint}`);
                                db.exec(`RELEASE ${savepoint}`);
                            } else db.exec("ROLLBACK");
                        }
                        throw error;
                    }
                };
            const defaultTransaction = make(readonly ? "DEFERRED" : "IMMEDIATE");
            const variants = {
                default: defaultTransaction,
                deferred: make("DEFERRED"),
                immediate: make("IMMEDIATE"),
                exclusive: make("EXCLUSIVE"),
                database: db,
            };
            for (const transaction of [
                variants.default,
                variants.deferred,
                variants.immediate,
                variants.exclusive,
            ]) {
                Object.assign(transaction, variants);
            }
            return defaultTransaction;
        },
    });
}

/**
 * Count tag identity writes made through the statement forms the transaction
 * routing does not wrap. `iterate()` runs the statement while its result is
 * consumed, so the generation moves both when iteration starts and when it
 * ends: a summary read in between is then rebuilt on its next read.
 */
// biome-ignore lint/suspicious/noExplicitAny: statements from both backends share these method names.
function wrapRemainingTagWriteForms(statement: any): void {
    if (typeof statement.iterate === "function") {
        const iterate = statement.iterate.bind(statement);
        Object.defineProperty(statement, "iterate", {
            configurable: true,
            value: function* (...args: unknown[]) {
                tagIdentityWriteGeneration += 1;
                try {
                    yield* iterate(...args);
                } finally {
                    tagIdentityWriteGeneration += 1;
                }
            },
        });
    }
    if (typeof statement.values === "function") {
        const values = statement.values.bind(statement);
        Object.defineProperty(statement, "values", {
            configurable: true,
            value: (...args: unknown[]) => {
                try {
                    return values(...args);
                } finally {
                    tagIdentityWriteGeneration += 1;
                }
            },
        });
    }
}

function trackSqliteConnection(
    db: BetterSqlite3.Database,
    filename: unknown,
    options: unknown,
): BetterSqlite3.Database {
    const originalClose = db.close.bind(db) as (...args: unknown[]) => unknown;
    const sequence = nextSqliteConnectionSequence++;
    const metadata = {
        sequence,
        filename:
            typeof filename === "string"
                ? filename
                : Buffer.isBuffer(filename)
                  ? "<buffer>"
                  : ":memory:",
        readonly:
            Boolean(options) &&
            typeof options === "object" &&
            ((options as { readonly?: unknown }).readonly === true ||
                (options as { readOnly?: unknown }).readOnly === true),
    };
    installTransactionRouting(db, metadata.readonly);
    Object.defineProperty(db, "close", {
        configurable: true,
        value: (...args: unknown[]) => {
            try {
                return originalClose(...args);
            } finally {
                trackedSqliteConnections.delete(sequence);
            }
        },
    });
    trackedSqliteConnections.set(sequence, {
        ...metadata,
        reference: new WeakRef(db),
    });
    const prepare = db.prepare.bind(db);
    Object.defineProperty(db, "prepare", {
        configurable: true,
        writable: true,
        value: (sql: string) => ownPreparedStatement(db, prepare(sql)),
    });
    return db;
}

const TrackedDatabase = new Proxy(DatabaseImpl, {
    construct(target, args) {
        const db = inRootAsyncContext(
            () => Reflect.construct(target, args, target) as BetterSqlite3.Database,
        );
        return trackSqliteConnection(db, args[0], args[1]);
    },
}) as typeof BetterSqlite3;

/**
 * Wrap node:sqlite's `DatabaseSync` so it presents the better-sqlite3/bun
 * surface the rest of the codebase calls:
 *   - translate the `{ readonly }` constructor option → node:sqlite's `readOnly`
 * Transaction routing is installed for both runtimes by trackSqliteConnection.
 */
// biome-ignore lint/suspicious/noExplicitAny: node:sqlite has no shipped types here; the public export is cast to the better-sqlite3 shape.
function buildNodeSqliteDatabaseClass(DatabaseSync: any): typeof BetterSqlite3 {
    class NodeSqliteDatabase extends DatabaseSync {
        constructor(filename?: string | Buffer, options?: BetterSqlite3.Options) {
            const translated: Record<string, unknown> = { ...options };
            if (options && "readonly" in options) {
                translated.readOnly = (options as { readonly?: boolean }).readonly;
                delete translated.readonly;
            }
            super(typeof filename === "string" ? filename : ":memory:", translated);
        }

        // Normalize a single ARRAY bind arg to spread positional, matching
        // bun:sqlite. bun's `.run([a,b])` binds positionally; node:sqlite instead
        // reads a lone array as NAMED params with keys "0","1" and throws
        // `Unknown named parameter '0'`. That divergence let an array-form bind
        // (e.g. `.run([x, y])`) silently work on OpenCode/Bun yet break Pi and
        // OpenCode Desktop (both node:sqlite) — issue #151 (/ctx-dream). Wrapping
        // every prepared statement here keeps the two backends' bind surface
        // truly identical so this whole class is impossible regardless of how a
        // call site writes its bind. Named-object binds (`.run({k:v})`), no-arg
        // calls, and already-spread positional args are passed through unchanged;
        // the normalization only triggers on the exact 1-array shape. Overhead
        // measured at ~12ns/call against real node:sqlite (negligible).
        // biome-ignore lint/suspicious/noExplicitAny: node:sqlite StatementSync has no shipped types here.
        prepare(sql: string): any {
            const stmt = super.prepare(sql);
            for (const method of ["run", "get", "all"] as const) {
                const original = stmt[method].bind(stmt);
                stmt[method] = (...args: unknown[]): unknown =>
                    args.length === 1 && Array.isArray(args[0])
                        ? original(...args[0])
                        : original(...args);
            }
            return stmt;
        }
    }

    return NodeSqliteDatabase as unknown as typeof BetterSqlite3;
}

export const Database: typeof BetterSqlite3 = TrackedDatabase;

function immutableDatabaseImplementation(): typeof BetterSqlite3 {
    if (!isBun) return DatabaseImpl;
    if (immutableDatabaseImpl) return immutableDatabaseImpl;

    const getBuiltinModule = process.getBuiltinModule;
    if (typeof getBuiltinModule !== "function")
        throw new SqliteRuntimeUnavailableError(
            "Bun",
            nodeSpec,
            new Error("This Bun runtime does not expose process.getBuiltinModule"),
        );
    const nodeSqlite = getBuiltinModule.call(process, nodeSpec) as SqliteModule | undefined;
    if (!nodeSqlite?.DatabaseSync)
        throw new SqliteRuntimeUnavailableError(
            "Bun",
            nodeSpec,
            new Error(`No such built-in module: ${nodeSpec}`),
        );

    immutableDatabaseImpl = buildNodeSqliteDatabaseClass(nodeSqlite.DatabaseSync);
    return immutableDatabaseImpl;
}

/** Open a closed SQLite file without asking SQLite to create missing WAL sidecars. */
export function openImmutableDatabase(path: string): BetterSqlite3.Database {
    // Immutable mode avoids creating missing WAL sidecars; callers must first rule out writers.
    const uri = pathToFileURL(path);
    uri.searchParams.set("immutable", "1");
    const target = immutableDatabaseImplementation();
    const db = inRootAsyncContext(
        () =>
            Reflect.construct(
                target,
                [uri.href, { readonly: true }],
                target,
            ) as BetterSqlite3.Database,
    );
    return trackSqliteConnection(db, uri.href, { readonly: true });
}

/** The constructor path, without querying SQLite on the prompt thread. */
export function getSqliteDatabasePath(db: Database): string | null {
    for (const connection of trackedSqliteConnections.values()) {
        if (connection.reference.deref() === db) {
            return connection.filename === ":memory:" || connection.filename === "<buffer>"
                ? null
                : connection.filename;
        }
    }
    // Native Bun/better-sqlite3 handles can reach readers without our constructor
    // wrapper. Their filename is still available without a SQLite query.
    const native = db as unknown as { filename?: unknown; name?: unknown };
    const path = native.filename ?? native.name;
    if (typeof path === "string" && path !== ":memory:" && path !== "") return path;
    return null;
}

function pragmaValue(db: BetterSqlite3.Database, name: string): unknown {
    const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return row[name] ?? Object.values(row)[0];
}

function pragmaNumber(db: BetterSqlite3.Database, name: string): number | null {
    try {
        const value = pragmaValue(db, name);
        return typeof value === "number" && Number.isFinite(value) ? value : null;
    } catch {
        return null;
    }
}

function pragmaString(db: BetterSqlite3.Database, name: string): string | null {
    try {
        const value = pragmaValue(db, name);
        return typeof value === "string" ? value : null;
    } catch {
        return null;
    }
}

function sqliteSidecarBytes(filename: string, suffix: "-wal" | "-shm"): number | null {
    if (filename === ":memory:" || filename === "<buffer>") return 0;
    try {
        return statSync(`${filename}${suffix}`).size;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? 0 : null;
    }
}

function fts5TableCount(db: BetterSqlite3.Database): number | null {
    try {
        const row = db
            .prepare(
                "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND sql LIKE '%USING fts5%'",
            )
            .get() as { count?: unknown } | undefined;
        return typeof row?.count === "number" ? row.count : null;
    } catch {
        return null;
    }
}

/**
 * Read the SQLite memory bounds that Bun/node:sqlite expose without native FFI.
 * SQLite's sqlite3_status()/sqlite3_db_status() counters are not surfaced by
 * either runtime, so cache and mmap values are configured upper bounds rather
 * than resident-byte measurements.
 */
export function getSqliteMemoryStats(): SqliteMemoryStats {
    const connections: SqliteConnectionMemoryStats[] = [];
    for (const [sequence, tracked] of trackedSqliteConnections) {
        const db = tracked.reference.deref();
        if (!db) {
            trackedSqliteConnections.delete(sequence);
            continue;
        }
        const pageSize = pragmaNumber(db, "page_size");
        const cacheSize = pragmaNumber(db, "cache_size");
        const cacheSizeUnit = cacheSize === null ? null : cacheSize < 0 ? "kib" : "pages";
        const cacheUpperBoundBytes =
            cacheSize === null
                ? null
                : cacheSize < 0
                  ? Math.abs(cacheSize) * 1024
                  : pageSize === null
                    ? null
                    : cacheSize * pageSize;
        connections.push({
            sequence: tracked.sequence,
            filename: tracked.filename,
            readonly: tracked.readonly,
            pageSize,
            pageCount: pragmaNumber(db, "page_count"),
            freelistCount: pragmaNumber(db, "freelist_count"),
            cacheSize,
            cacheSizeUnit,
            cacheUpperBoundBytes,
            mmapSizeBytes: pragmaNumber(db, "mmap_size"),
            walFileBytes: sqliteSidecarBytes(tracked.filename, "-wal"),
            shmFileBytes: sqliteSidecarBytes(tracked.filename, "-shm"),
            fts5TableCount: fts5TableCount(db),
            journalMode: pragmaString(db, "journal_mode"),
        });
    }
    const sumKnown = (select: (connection: SqliteConnectionMemoryStats) => number | null): number =>
        connections.reduce((sum, connection) => sum + (select(connection) ?? 0), 0);
    return {
        connectionCount: connections.length,
        cacheUpperBoundBytes: sumKnown((connection) => connection.cacheUpperBoundBytes),
        mmapUpperBoundBytes: sumKnown((connection) => connection.mmapSizeBytes),
        walFileBytes: sumKnown((connection) => connection.walFileBytes),
        shmFileBytes: sumKnown((connection) => connection.shmFileBytes),
        sqliteStatusApi: "unavailable",
        connections,
    };
}

/** Instance type alias used by helpers and storage modules. */
export type Database = BetterSqlite3.Database;

/**
 * Statement instance type used for WeakMap caches throughout the codebase.
 *
 * We deliberately use the variadic Statement<unknown[], unknown> shape rather
 * than `ReturnType<Database["prepare"]>` because the latter resolves through
 * a conditional return type in @types/better-sqlite3 that confuses TypeScript
 * about how many arguments .run/.get/.all accept. With this explicit type,
 * cached statements accept any number of bind args (matching bun:sqlite's
 * historical behavior in this codebase).
 */
export type Statement = BetterSqlite3.Statement<unknown[], unknown>;

type FinalizableStatement = Statement & { finalize(): void };
interface StatementOwner {
    references: Set<WeakRef<FinalizableStatement>>;
    registered: WeakSet<FinalizableStatement>;
    /** Set size at which collected references are next swept out. */
    pruneAt: number;
}
const statementOwners = new WeakMap<Database, StatementOwner>();
const FIRST_PRUNE_AT = 256;

/**
 * Bun's default close (`sqlite3_close_v2`) only releases the native connection
 * once every statement created by prepare() is finalized. The close override
 * in ownPreparedStatement can finalize only statements that are still
 * reachable. Once the garbage collector
 * has marked a one-shot statement dead, its weak reference is already cleared,
 * but the statement is finalized only when its memory is later swept. Until
 * then the closed connection keeps the database, WAL and shared-memory files
 * open, for an unbounded time.
 *
 * `close(true)` finalizes every outstanding statement, reachable or not, and
 * releases the connection immediately. When the caller did not ask for errors
 * and that close fails, fall back to the caller's own close so a teardown path
 * never starts throwing; the fallback can defer the release as before.
 */
function closeReleasingStatements(
    close: (...args: unknown[]) => unknown,
    args: unknown[],
): unknown {
    if (args[0] === true) return close(true);
    try {
        return close(true);
    } catch {
        return close(...args);
    }
}

function ownPreparedStatement(db: Database, statement: Statement): Statement {
    const finalizable = statement as FinalizableStatement;
    // Node finalizes its statements on close and exposes no finalize() method.
    if (typeof finalizable.finalize !== "function") return statement;
    let owner = statementOwners.get(db);
    if (!owner) {
        const references = new Set<WeakRef<FinalizableStatement>>();
        owner = { references, registered: new WeakSet(), pruneAt: FIRST_PRUNE_AT };
        statementOwners.set(db, owner);
        const close = db.close.bind(db) as (...args: unknown[]) => unknown;
        Object.defineProperty(db, "close", {
            configurable: true,
            writable: true,
            value: (...args: unknown[]) => {
                let failure: unknown;
                for (const reference of references) {
                    try {
                        reference.deref()?.finalize();
                    } catch (error) {
                        failure ??= error;
                    }
                }
                references.clear();
                const result = closeReleasingStatements(close, args);
                if (failure) throw failure;
                return result;
            },
        });
    }
    if (!owner.registered.has(finalizable)) {
        // No FinalizationRegistry: its callbacks run at GC time, where a throw
        // is uncaught (seen in Bun's parallel test runner). Sweep references to
        // collected statements whenever the set doubles instead, so one-shot
        // statements in a long-running host stay bounded.
        if (owner.references.size >= owner.pruneAt) {
            for (const reference of owner.references) {
                if (reference.deref() === undefined) owner.references.delete(reference);
            }
            owner.pruneAt = Math.max(FIRST_PRUNE_AT, owner.references.size * 2);
        }
        owner.references.add(new WeakRef(finalizable));
        owner.registered.add(finalizable);
    }
    return statement;
}

/**
 * Cached statements must be finalized before closing their connection. Bun's
 * prepare() leaves SQLite's native close deferred until all statements finish,
 * even after the JS Database reports closed. Delayed WAL checkpoints can then
 * overwrite a restored database if a caller reuses the file in the meantime.
 * The shared Database owns every preparation; use this for caches that also
 * accept direct bun:sqlite handles. Weak references avoid retaining one-shot
 * statements for the lifetime of a long-running host.
 */
export function prepareCachedStatement(db: Database, sql: string): Statement {
    return ownPreparedStatement(db, db.prepare(sql));
}

const privilegeDepth = new WeakMap<Database, number>();
const transformPassScope = new AsyncLocalStorage<
    | {
          active: boolean;
          remainingWaitMs: number;
          guard?: { assert(): void; remainingMs(): number };
      }
    | undefined
>();
const admissionScope = new AsyncLocalStorage<boolean>();
const backgroundWriterScope = new AsyncLocalStorage<boolean>();

/** Opt in only a writer that can safely defer its work after a busy acquisition. */
export function withSqliteBackgroundWriter<T>(operation: () => T): T {
    return backgroundWriterScope.run(true, operation);
}

/** Only an awaited foreground transform may spend the extra acquisition budget.
 * The mutable lease also expires for detached descendants when that pass ends. */
export function withSqliteTransformPass<T>(operation: () => T): T {
    const existing = transformPassScope.getStore();
    if (existing?.active) return operation();
    const reservation = reserveForegroundSqliteTurn();
    const run = (release: () => void): T => {
        const lease = { active: true, remainingWaitMs: FOREGROUND_IN_PASS_BUSY_TIMEOUT_MS };
        return transformPassScope.run(lease, () => {
            try {
                const result = operation();
                if (result && typeof (result as { then?: unknown }).then === "function") {
                    return Promise.resolve(result).finally(() => {
                        lease.active = false;
                        release();
                    }) as T;
                }
                lease.active = false;
                release();
                return result;
            } catch (error) {
                lease.active = false;
                release();
                throw error;
            }
        });
    };
    // Foreground callers racing maintenance are awaited transforms. Idle
    // synchronous callers keep the existing immediate return/throw behavior.
    return typeof reservation === "function" ? run(reservation) : (reservation.then(run) as T);
}

/** Start detached maintenance work without borrowing a foreground pass's budget. */
export function withoutSqliteTransformPass<T>(operation: () => T): T {
    return transformPassScope.run(undefined, operation);
}

/** Attach the adapter's existing generation/cancellation/deadline guard to writes. */
export function guardSqliteTransformPass(guard: { assert(): void; remainingMs(): number }): void {
    const lease = transformPassScope.getStore();
    if (lease) lease.guard = guard;
}

/** Check the attached generation/cancellation/deadline guard before SQL or cache publication. */
export function assertTransformWrite(): void {
    if (!backgroundWriterScope.getStore()) transformPassScope.getStore()?.guard?.assert();
}

/** Bun names SQLite codes; node:sqlite exposes the numeric (possibly extended) errcode. */
export function isTransientSqliteError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const value = error as { code?: unknown; errcode?: unknown };
    return (
        (typeof value.code === "string" && /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(value.code)) ||
        (typeof value.errcode === "number" && [5, 6].includes(value.errcode & 0xff))
    );
}

export class SqliteAcquisitionBusyError extends Error {
    readonly code = "SQLITE_BUSY";
    readonly stage: string;
    constructor(cause: unknown, stage = "BEGIN IMMEDIATE") {
        super("SQLite writer acquisition remained busy", { cause });
        this.name = "SqliteAcquisitionBusyError";
        this.stage = stage;
    }
}

const SHORT_BUSY_TIMEOUT_MS = 25;
const FOREGROUND_IN_PASS_BUSY_TIMEOUT_MS = 2_000;
const FOREGROUND_ACQUISITION_BUDGET_MS = 16_500;
/** Waiting this long for the writer lock, or holding it this long, is logged. */
const SLOW_WRITER_LOG_MS = 100;
const WRITER_TRANSACTION_END = /^\s*(?:COMMIT|END|ROLLBACK)(?:\s+TRANSACTION)?\s*;?\s*$/i;

type WriterLane = "foreground" | "background";

/**
 * One attempt of an outer acquisition loop (`beginSqliteWriterAsync`,
 * `withAsyncPrivilegedWriter`). It names the writer and remembers when the loop
 * started, so the time spent in earlier busy attempts and the sleeps between
 * them counts as waiting for the lock. Only the first BEGIN issued inside the
 * attempt may claim it; a later BEGIN from detached work started inside the
 * same async scope is timed on its own.
 */
interface WriterAcquisition {
    site: string;
    lane: WriterLane;
    startedAt: number;
    attempts: number;
    claimed: boolean;
    remainingMs?: () => number;
}

/** A write transaction whose BEGIN went through `acquireShort` and has not ended yet. */
interface OpenWriterTransaction {
    site: string;
    lane: WriterLane;
    acquireMs: number;
    attempts: number;
    acquiredAt: number;
}

const writerAcquisitionScope = new AsyncLocalStorage<WriterAcquisition | undefined>();
const openWriterTransactions = new WeakMap<Database, OpenWriterTransaction>();

function foregroundWaitLease() {
    const lease = transformPassScope.getStore();
    return lease?.active && !admissionScope.getStore() && !backgroundWriterScope.getStore()
        ? lease
        : undefined;
}

/** Probe a prepared statement's writer lock without charging uncontended work
 * against the foreground lock-wait budget. An exec script may commit some of
 * its statements before failing, so it cannot be retried without duplicating
 * writes; conservatively charge its single attempt's full execution time. */
function withAutocommitTimeout<T>(db: Database, operation: () => T, singleStatement = true): T {
    assertTransformWrite();
    const lease = foregroundWaitLease();
    if (isInTransaction(db)) return operation();
    const scoped = lease || backgroundWriterScope.getStore();
    const previous = scoped ? pragmaNumber(db, "busy_timeout") : null;
    const started = performance.now();
    let completed = false;
    const execute = () => {
        const result = operation();
        completed = true;
        return result;
    };
    try {
        if (!scoped) return execute();
        if (singleStatement) {
            db.exec("PRAGMA busy_timeout=0");
            try {
                return execute();
            } catch (error) {
                if (!isTransientSqliteError(error) || isInTransaction(db)) throw error;
            }
            assertTransformWrite();
        }
        const timeout = Math.floor(
            Math.min(
                lease?.remainingWaitMs ?? SHORT_BUSY_TIMEOUT_MS,
                lease?.guard?.remainingMs() ?? Infinity,
            ),
        );
        db.exec(`PRAGMA busy_timeout=${timeout}`);
        const waitStarted = performance.now();
        try {
            return execute();
        } finally {
            // Deduct the prepared statement's contended retry or the exec
            // script's execution from the remaining foreground wait budget;
            // the native API cannot separate lock waiting from execution.
            if (lease)
                lease.remainingWaitMs = Math.max(
                    0,
                    lease.remainingWaitMs - (performance.now() - waitStarted),
                );
        }
    } catch (error) {
        if (lease && isTransientSqliteError(error))
            throw new SqliteAcquisitionBusyError(error, "autocommit");
        throw error;
    } finally {
        const elapsed = performance.now() - started;
        if (previous !== null) db.exec(`PRAGMA busy_timeout=${previous}`);
        // Native autocommit does not expose the instant its lock was acquired.
        // Label the upper bound so a waiting statement is not blamed as a holder.
        if (elapsed >= SLOW_WRITER_LOG_MS)
            reportSqliteDiagnostic(
                `sqlite writer site=autocommit lane=${lease ? "foreground" : "background"} elapsed_ms=${Math.round(elapsed)} timing=statement_including_acquisition outcome=${completed ? "completed" : "failed"} caller=${writerCaller()}`,
            );
    }
}

/** The connection is never handed back to another caller with a shortened timeout. */
function acquireShort(db: Database, acquire: () => unknown, site: string): void {
    assertTransformWrite();
    const started = performance.now();
    const previous = pragmaNumber(db, "busy_timeout");
    const outer = writerAcquisitionScope.getStore();
    const owner = outer && !outer.claimed ? outer : undefined;
    if (owner) owner.claimed = true;
    const writerSite = owner?.site ?? site;
    const lane: WriterLane =
        owner?.lane ?? (transformPassScope.getStore()?.active ? "foreground" : "background");
    let acquiredAt: number | undefined;
    try {
        // Async admission retries after yielding, so each of its BEGIN attempts
        // stays short. An ordinary BEGIN inside a transform pass cannot yield;
        // give that single attempt enough time for a brief writer to finish.
        const lease = foregroundWaitLease();
        const timeout = Math.floor(
            Math.min(
                lease ? lease.remainingWaitMs : SHORT_BUSY_TIMEOUT_MS,
                owner?.remainingMs?.() ?? lease?.guard?.remainingMs() ?? Infinity,
            ),
        );
        db.exec(`PRAGMA busy_timeout=${timeout}`);
        acquire();
        acquiredAt = performance.now();
    } catch (error) {
        if (transformPassScope.getStore()?.active && isTransientSqliteError(error))
            throw new SqliteAcquisitionBusyError(error, site);
        throw error;
    } finally {
        const attemptMs = (acquiredAt ?? performance.now()) - started;
        const lease = foregroundWaitLease();
        if (lease) lease.remainingWaitMs = Math.max(0, lease.remainingWaitMs - attemptMs);
        if (previous !== null) db.exec(`PRAGMA busy_timeout=${previous}`);
        if (acquiredAt !== undefined) {
            // Reported when the transaction ends, together with how long it held
            // the lock (see endWriterTransaction).
            openWriterTransactions.set(db, {
                site: writerSite,
                lane,
                acquireMs: acquiredAt - (owner?.startedAt ?? started),
                attempts: owner?.attempts ?? 1,
                acquiredAt,
            });
        } else if (attemptMs >= SLOW_WRITER_LOG_MS) {
            reportSqliteDiagnostic(
                `sqlite writer site=${writerSite} lane=${lane} acquire_ms=${Math.round(attemptMs)} attempts=${owner?.attempts ?? 1} outcome=busy`,
            );
        }
    }
}

/**
 * Run the COMMIT, END or ROLLBACK that closes a transaction opened through
 * `acquireShort`, then report how long the writer waited for the lock
 * (`acquire_ms`) and how long it then held it (`hold_ms`) when either crosses
 * the threshold. A long hold blocks every other process's writer, so it is
 * worth seeing even when the lock itself came quickly. This interval includes
 * COMMIT: an automatic PASSIVE checkpoint can run after writer-lock release,
 * so hold_ms is a conservative upper bound, not proof of continuous ownership.
 */
function endWriterTransaction(db: Database, end: () => unknown, sql: string): unknown {
    let ended = false;
    try {
        const result = end();
        ended = true;
        return result;
    } finally {
        const open = openWriterTransactions.get(db);
        // A COMMIT that failed with the transaction still open has not ended it.
        if (open && !isInTransaction(db)) {
            openWriterTransactions.delete(db);
            const holdMs = performance.now() - open.acquiredAt;
            if (open.acquireMs >= SLOW_WRITER_LOG_MS || holdMs >= SLOW_WRITER_LOG_MS) {
                const outcome = /^\s*ROLLBACK/i.test(sql)
                    ? "rolled_back"
                    : ended
                      ? "committed"
                      : "failed";
                reportSqliteDiagnostic(
                    `sqlite writer site=${open.site} lane=${open.lane} acquire_ms=${Math.round(open.acquireMs)} hold_ms=${Math.round(holdMs)} attempts=${open.attempts} outcome=${outcome} timing=through_commit_upper_bound caller=${writerCaller()}`,
                );
            }
        }
    }
}

// Capture a stack only for slow writes. Synchronous COMMIT retains the writer's
// caller, so fast transactions need neither stack allocation nor source mapping.
function writerCaller(): string {
    return (
        new Error().stack
            ?.split("\n")
            .find(
                (line) =>
                    line.includes(" at ") &&
                    !/[/\\]sqlite\.[tj]s[:)]/.test(line) &&
                    !/\b(?:writerCaller|endWriterTransaction|withAutocommitTimeout|value)\b/.test(
                        line,
                    ),
            )
            ?.trim()
            .replace(/\s+/g, "_") ?? "unknown"
    );
}

/** Begin an immediate transaction with bounded asynchronous retries on writer contention.
 * Callers must recheck any lease or source snapshot after this function returns.
 * Resolves with the `performance.now()` time at which BEGIN IMMEDIATE succeeded,
 * so a caller timing its transaction measures the hold, not the wait for the lock. */
export async function beginSqliteWriterAsync(db: Database, site: string): Promise<number> {
    const started = performance.now();
    let attempts = 0;
    for (;;) {
        attempts++;
        try {
            const acquisition: WriterAcquisition = {
                site,
                lane: "background",
                startedAt: started,
                attempts,
                claimed: false,
            };
            writerAcquisitionScope.run(acquisition, () =>
                withSqliteBackgroundWriter(() => db.exec("BEGIN IMMEDIATE")),
            );
            return performance.now();
        } catch (error) {
            if (!isTransientSqliteError(error)) throw error;
            const elapsed = performance.now() - started;
            if (elapsed >= FOREGROUND_ACQUISITION_BUDGET_MS) {
                reportSqliteDiagnostic(
                    `sqlite writer site=${site} lane=background acquire_ms=${Math.round(elapsed)} attempts=${attempts} outcome=busy`,
                );
                throw error;
            }
            await new Promise<void>((resolve) =>
                setTimeout(
                    resolve,
                    Math.min(
                        attempts === 1 ? 500 : 1000,
                        FOREGROUND_ACQUISITION_BUDGET_MS - elapsed,
                    ),
                ),
            );
        }
    }
}

/** Retry admission before any turn work, yielding between short lock attempts. */
export async function withAsyncPrivilegedWriter<T>(
    db: Database,
    operation: () => T,
    options: {
        signal?: AbortSignal;
        beforeRetry?: (error: SqliteAcquisitionBusyError) => void;
        jitter?: boolean;
        budgetMs?: number;
        assertCurrentPass?: () => void;
    } = {},
): Promise<T> {
    const started = performance.now();
    const budgetMs = Math.max(
        0,
        Math.min(FOREGROUND_ACQUISITION_BUDGET_MS, options.budgetMs ?? Infinity),
    );
    let attempts = 0;
    for (;;) {
        options.signal?.throwIfAborted();
        options.assertCurrentPass?.();
        attempts++;
        let entered = false;
        try {
            const acquisition: WriterAcquisition = {
                site: "privileged_writer",
                lane: "foreground",
                startedAt: started,
                attempts,
                claimed: false,
                remainingMs: () => Math.max(0, budgetMs - (performance.now() - started)),
            };
            // The acquisition and hold of this transaction are reported when it
            // commits or rolls back (see endWriterTransaction).
            return admissionScope.run(true, () =>
                withSqliteTransformPass(() =>
                    writerAcquisitionScope.run(acquisition, () =>
                        withPrivilegedWriter(db, () => {
                            entered = true;
                            return operation();
                        }),
                    ),
                ),
            );
        } catch (error) {
            // A callback failure can occur after writes; only retry a failed BEGIN.
            if (entered || !(error instanceof SqliteAcquisitionBusyError)) throw error;
            // Adapters may serve a validated saved request instead of waiting.
            // This runs only after a failed BEGIN, never after callback writes.
            options.beforeRetry?.(error);
            const elapsed = performance.now() - started;
            if (elapsed >= budgetMs) {
                reportSqliteDiagnostic(
                    `sqlite writer site=privileged_writer lane=foreground acquire_ms=${Math.round(elapsed)} attempts=${attempts} outcome=busy`,
                );
                throw error;
            }
            const backoff = attempts === 1 ? 500 : 1000;
            const delay = Math.min(
                options.jitter ? backoff * (0.8 + Math.random() * 0.4) : backoff,
                budgetMs - elapsed,
            );
            await new Promise<void>((resolve, reject) => {
                const abort = () => {
                    clearTimeout(timer);
                    options.signal?.removeEventListener("abort", abort);
                    reject(options.signal?.reason ?? new Error("Writer wait aborted"));
                };
                const timer = setTimeout(() => {
                    options.signal?.removeEventListener("abort", abort);
                    resolve();
                }, delay);
                options.signal?.addEventListener("abort", abort, { once: true });
                if (options.signal?.aborted) abort();
            });
        }
    }
}

function isInTransaction(db: Database): boolean {
    const candidate = db as unknown as { inTransaction?: unknown; isTransaction?: unknown };
    return candidate.inTransaction === true || candidate.isTransaction === true;
}

/**
 * Run a storage operation with the managed-write privilege enabled.
 *
 * The privilege is recorded in the durable `context_privilege_state` table (row
 * id=1, enabled=1) so the guard triggers — which reference that table, never a
 * connection-local UDF — stand down for this connection's writes. The write happens
 * inside a BEGIN IMMEDIATE transaction (single writer), and enabled is cleared back
 * to 0 before commit, so no second connection can ever observe enabled=1. Nesting is
 * tracked by privilegeDepth (outside SQLite): only the outermost scope clears the
 * flag, so an inner scope releasing does not drop permission out from under its caller.
 */
export function withPrivilegedWriter<T>(db: Database, operation: () => T): T {
    const previousDepth = privilegeDepth.get(db) ?? 0;
    const nested = isInTransaction(db);
    const savepoint = "mc_privilege_scope";
    // Timed from the moment the lock is held, so a slow-write report measures
    // the hold and not the wait for BEGIN IMMEDIATE.
    let transactionStartedAt: number | undefined;
    if (nested) {
        db.exec(`SAVEPOINT ${savepoint}`);
    } else {
        try {
            db.exec("BEGIN IMMEDIATE");
        } catch (error) {
            if (transformPassScope.getStore()?.active && isTransientSqliteError(error))
                throw new SqliteAcquisitionBusyError(error);
            throw error;
        }
        transactionStartedAt = performance.now();
    }
    privilegeDepth.set(db, previousDepth + 1);
    try {
        db.prepare(
            "INSERT INTO context_privilege_state(id, enabled) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET enabled = 1",
        ).run();
        const result = operation();
        if (previousDepth === 0) {
            db.prepare("UPDATE context_privilege_state SET enabled = 0 WHERE id = 1").run();
        }
        if (nested) {
            db.exec(`RELEASE ${savepoint}`);
        } else {
            db.exec("COMMIT");
            if (transactionStartedAt !== undefined) {
                reportSlowPrivilegedWrite?.("privileged_writer", transactionStartedAt);
            }
        }
        if (previousDepth > 0) privilegeDepth.set(db, previousDepth);
        else privilegeDepth.delete(db);
        return result;
    } catch (error) {
        try {
            if (nested) {
                db.exec(`ROLLBACK TO ${savepoint}`);
                db.exec(`RELEASE ${savepoint}`);
            } else {
                db.exec("ROLLBACK");
            }
        } finally {
            if (previousDepth > 0) privilegeDepth.set(db, previousDepth);
            else privilegeDepth.delete(db);
        }
        throw error;
    }
}

// Process-local admission only; SQLite remains the cross-process writer arbiter.
const indexCoordinationKey = Symbol.for("magic-context.index-foreground-coordination.v1");
const indexCoordinationHeap = globalThis as unknown as Record<
    symbol,
    SharedArrayBuffer | undefined
>;
const indexCoordinationBuffer =
    indexCoordinationHeap[indexCoordinationKey] ??
    new SharedArrayBuffer(3 * Int32Array.BYTES_PER_ELEMENT);
indexCoordinationHeap[indexCoordinationKey] = indexCoordinationBuffer;
const indexCoordinationState = new Int32Array(indexCoordinationBuffer);
// Slots: foreground interest, current maintenance owner, next owner token.

export function indexCoordinationInput(): {
    indexCoordination: SharedArrayBuffer;
    indexOwner: number;
} {
    return {
        indexCoordination: indexCoordinationBuffer,
        indexOwner: Atomics.add(indexCoordinationState, 2, 1) + 1,
    };
}

const yieldIndexTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

/** Announce interest before waiting, so no maintenance chunk overtakes a foreground turn. */
function reserveForegroundSqliteTurn(): (() => void) | Promise<() => void> {
    Atomics.add(indexCoordinationState, 0, 1);
    const release = () => {
        Atomics.sub(indexCoordinationState, 0, 1);
        Atomics.notify(indexCoordinationState, 0);
    };
    if (Atomics.load(indexCoordinationState, 1) === 0) return release;
    return (async () => {
        while (Atomics.load(indexCoordinationState, 1) !== 0) await yieldIndexTurn();
        return release;
    })();
}

export function releaseIndexOwner(input: {
    indexCoordination?: SharedArrayBuffer;
    indexOwner?: number;
}): void {
    if (!input.indexCoordination || !input.indexOwner) return;
    const shared = new Int32Array(input.indexCoordination);
    Atomics.compareExchange(shared, 1, input.indexOwner, 0);
    Atomics.notify(shared, 1);
}

/** One synchronous transaction per permit; release the permit before yielding. */
export async function withIndexChunk<T>(
    input: { indexCoordination?: SharedArrayBuffer; indexOwner?: number },
    operation: () => T,
): Promise<T> {
    if (!input.indexCoordination || !input.indexOwner) return operation();
    const shared = new Int32Array(input.indexCoordination);
    for (;;) {
        if (
            Atomics.load(shared, 0) === 0 &&
            Atomics.compareExchange(shared, 1, 0, input.indexOwner) === 0
        ) {
            if (Atomics.load(shared, 0) === 0) break;
            releaseIndexOwner(input);
        }
        await yieldIndexTurn();
    }
    try {
        return await operation();
    } finally {
        releaseIndexOwner(input);
    }
}

export async function yieldIndexChunk(): Promise<void> {
    await yieldIndexTurn();
}

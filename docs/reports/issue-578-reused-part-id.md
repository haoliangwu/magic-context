# Issue 578: reused text identity and first-served bytes

Phase 1 only; no runtime fix or migration. Investigated at `db3705e6a7707724b8b8c86f988dc5e22996c825` on 2026-09-30. Read [issue 578](https://github.com/cortexkit/magic-context/issues/578), by marcusrbrown, before investigating. His 48-request window reports 28 previous-tail rewrites, 454/454 historical source matches, 0/29 tail matches, and 30 defer/cache-hit decisions. Those counts are reporter evidence, not measurements from this reproduction.

## Terms used below

**MC** means Magic Context; **OMO** means oh-my-opencode-slim. **Pi** is the Pi coding-agent host and its Magic Context extension. The **wire** is the actual model-provider request body. A **defer** pass may append new content but must preserve previously sent bytes; a **rebuild/cache-busting** pass is one the existing cache policy independently permits to change the cached prefix. A mismatch itself is not that permission. The **load floor** is the lowest tag number loaded into the tagger's in-memory ID-to-number **assignment map**; older numbers may remain only in SQLite. The **source map** is the per-pass prefetched tag-to-original-text lookup. **First-write-wins** means an existing source row cannot be changed by a later ordinary save. **Ordinal fallback** means matching the same message's first/second/etc. text part when its part index moved. **Reclaim** means dropping, truncating or compressing old content; **caveman** is the project's persisted text-compression feature. **Thinking** means native signed assistant reasoning blocks; an **open tool arc** is a tool invocation whose result has not yet completed. A **generation** is a distinct original-content version under a potentially reused host locator; a **served render** is its exact transformed output text/framing; a **render epoch** is a durably recorded version of those output bytes, advanced only when changing them is allowed. The database **version fence** prevents old readers opening a newer unsupported schema.

## Findings in brief

1. Identity alone is insufficient. OpenCode text identity here is **`${message.info.id}:p${partIndex}`**, not the native `part.id`. A reused synthetic message ID can therefore collide even when the producer never sets a part ID.
2. The live-tail/stale-history flip does **not require a tail exemption or a later plugin hook**. A persisted tag below the live-wire load floor is recovered *after* the source prefetch. On its first encounter the source map lacks that tag: live text survives an ignored first-write-wins insert. On its next encounter the warmed assignment makes the old source eligible for prefetch and replay. A real OpenCode 1.18.30 mock-provider run reproduced precisely that progression.
3. A source hash alone cannot freeze the bytes first served, distinguish our own transformed representations, or tell what a legacy session actually sent. The design needs content-qualified identity **and a durable served-render record**.
4. There is an upgrade information gap. For ambiguous legacy rows, simultaneously continuing requests, never serving stale content, and never changing defer bytes is impossible without previous-wire evidence. The strict design below pauses ambiguous requests until an independently authorized rebuild. Silently replaying legacy stale content until a rebuild would violate the requested no-stale invariant.

## Why source replay exists (history, not speculation)

Commands executed in this worktree:

```sh
git log -L 840,860:packages/plugin/src/hooks/magic-context/tag-messages.ts --format=fuller -n 8
git log --all --oneline -S 'source_contents' -- '*storage-source.ts' '*tag-messages.ts'
git show eca52577bc89^:packages/plugin/src/hooks/magic-context/tag-messages.ts
git show eca52577bc89 -- packages/plugin/src/hooks/magic-context/tag-messages.ts
```

`f41ebbf11bd1d9aa47a52fedb775d8780a564096` (2026-03-17), “feat: extract magic-context into standalone OpenCode plugin”, already contains save-on-new / restore-on-existing behavior. Its message says: “The original commit history remains in the oh-my-opencode repository.” This worktree cannot establish the pre-extraction author's original intent more precisely; do not attribute a new content-collision guarantee to that import.

`eca52577bc8958e6acfdb178b5d2bdf809d00eae` (2026-04-28), “fix(magic-context): self-heal tagger counter drift to prevent cache-bust cascade”, changes replay from the `existingTagId` branch to unconditional replay whenever the prefetched source map contains the ultimately assigned number. The added comment is still at `tag-messages.ts:840-846`:

> “even if we just allocated a fresh tag (because in-memory state was lost), the DB may still have the original pre-tag content from a previous pass ... when assignTag's recovery rebound a different tag number than what the resolver expected.”

Its commit message explains the failure being protected:

> “counter drifted below ... MAX(tag_number) (from outer-transaction rollback ... multi-process race, or non-monotonic counter upsert)” ... “empty targets, skipping persisted-drop replay, reasoning clearing, and caveman compression” ... “+110k token resurrection of stripped content”.

The same commit removes the outer transaction, adds DB-authoritative allocation, and gates downstream mutations on successful tagging. `7f8023f709d7` (2026-06-01), “perf(transform): move work-metrics off the hot path; lazy + incremental”, only adds timing around source saves in this block; it does not change the replay contract.

**Precisely what must survive:** recovery of the *same logical content* after losing the in-memory assignment, tag-counter drift/race rebinding, or part-index remapping; stripping/replaying our own prefix; restoration of pristine text as the input to persisted reclaim/compression so host reconstruction from original rows does not resurrect compressed/dropped content. The caveman-specific dependency is explicit at `transform.ts:2356-2367`: without replaying persisted compression, restored pristine source oscillates with compressed execute output on defer. `caveman-cleanup.ts:212-279` applies persisted depth from source. This is not evidence that arbitrary new prose under an old ID is legitimate drift. Nor does the history justify fuzzy whitespace or semantic matching.

## Trace of the flip

### Production path

- `transform.ts:1997-2008` derives `taggerFloor` from leading wire identities; `:2197` passes it to `initFromDb`.
- `tagger.ts:180-187` loads only tags at/above that floor; the load signature includes floor and tags version (`:216-231`). Old synthetic board identities can be below it even when their newly injected occurrences are in the current wire.
- `tag-messages.ts:315-333,528-536` prefetches source only for IDs already present in the assignment map and in the current messages. This happens **before the walk**.
- `tag-id-fallback.ts:84-105` resolves exact identity or same-message text ordinal. It does not check content. An ordinal fallback moves the binding, not the source map.
- `tagger.ts:409-432` performs an exact DB lookup on a map miss, binds the old tag into memory, and returns it. It does not populate the already-built `sourceContents` map.
- `tag-messages.ts:847-856`: missing prefetched source means leave incoming text intact, attempt `saveSourceContent`; `storage-source.ts:21-23` uses `INSERT OR IGNORE`, so the old row remains. Prefix injection then uses the recovered old number.
- Next pass, a unchanged floor/version allows the warmed map to retain the recovered binding; prefetch finds the old row. Incoming LIVE becomes OLD before prefixing.

Both first and later passes walk the tail. `tag-messages.ts:564-581,727-869` has no general newest-message skip. Protected-tail reclaim eligibility is not a source-replay exemption. A full/unscoped cold load can instead serve stale immediately; a floor change that discards recovered bindings can alter the progression. Thus “tail” is correlation with *first encounter*, not the branch condition.

The current OMO master independently corroborates identity construction: [board-injection.ts](https://raw.githubusercontent.com/alvinunreal/oh-my-opencode-slim/master/src/hooks/task-session-manager/board-injection.ts), lines 1782-1795 and 1928-1976, initializes sequence at zero, increments it, and uses the snapshot ID as synthetic `info.id`; [cache-safe-injection.ts](https://raw.githubusercontent.com/alvinunreal/oh-my-opencode-slim/master/src/hooks/cache-safe-injection.ts):47-57 does not set a native part ID. This is unversioned upstream source, not proof of the reporter's exact OMO build or plugin ordering. Our reproduction does not rely on that ordering.

### Real host reproduction and isolation

Pinned binary downloaded from `https://registry.npmjs.org/opencode-darwin-arm64/-/opencode-darwin-arm64-1.18.30.tgz`; its isolated `--version` returned `1.18.30`. Worktree dependencies installed with `bun install --frozen-lockfile` (no manifest/lockfile edits). No real provider or credentials used.

Root for successful run: `$TMPDIR/magic-context/issue-578/run6` (macOS canonical prefix `/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/`). All of HOME, XDG config/data/cache/state/runtime, OPENCODE_CONFIG_DIR, **absolute OPENCODE_DB**, MAGIC_CONTEXT_STORAGE_DIR, logs and child TMPDIR were under that root. The child environment was constructed from an allowlist, not inherited credentials/config overrides. Only `mock-anthropic/mock-sonnet` was enabled; both primary and small models routed to `127.0.0.1`. Each process was stopped in `finally`.

The appendix harness uses a tiny host plugin importing **the production tagger, tagMessages, schema initialization, migrations and SQLite adapter**. It seeds three OLD sources and later tag numbers, deliberately sets the load floor to 100, and injects boards *before* tagging. It performs three old-generation requests, terminates `serve`, then starts a new `serve` with the same isolated databases/session and reset sequence, performing three LIVE-generation requests. It is a direct-store/load-floor fixture, not a full OMO or full MC transform deployment. It proves the replay and missing-prefetch mechanism on the requested host, not the reporter's exact automatically derived floor, actual provider cache accounting, or Opus signature validation. No decision engine runs in this fixture; replay is unconditional in the relevant production tagger path used by defer as well as rebuild passes.

Captured full Anthropic request bodies and per-pass `lsof -p <host pid>` snapshots are retained in that root (`old-{0,1,2}.json`, `live-{0,1,2}.json`, corresponding `*-lsof.txt`, `summary.json`, `trace.jsonl`). Isolation check rejected any open live OpenCode/CortexKit database/config path. The successful run's lsof snapshots show the fixture context DB and host DB underneath the throwaway root; no live store was read or migrated. The appendix retains a runnable harness so ephemeral captures are not the sole evidence.

Concrete lsof receipts (old process PID 63762; restarted process PID 64205): both had open `.../run6/data/opencode/fixture.db` and `.../run6/data/cortexkit/magic-context/context.db`, with WAL/SHM siblings only in those directories. For example, restarted PID 64205 had fd `7u REG ... /private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-578/run6/data/opencode/fixture.db` and fd `15u REG ... /private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-578/run6/data/cortexkit/magic-context/context.db`.

Full-body SHA-256 receipts:

- `live-0.json`: `c8b6b6262988483ff4b23d71ca118cc7831a0804cd5993b44701b4afb971afa2`
- `live-1.json`: `62abade3fa3597c36789f878020d296e79ae0a2b465c5c80261269ffeb80695f`
- `live-2.json`: `b075648e7c9cc10cad8ce29394aaef6942b3591bf19017d582c274d0d7f90ebc`

Exact board text blocks extracted from the **provider request bodies**, not calculated from expected source:

| Request | Board blocks in order |
|---|---|
| old-0 | `§1§ BOARD OLD 0` |
| old-1 | `§1§ BOARD OLD 0`, `§2§ BOARD OLD 1` |
| old-2 | `§1§ BOARD OLD 0`, `§2§ BOARD OLD 1`, `§3§ BOARD OLD 2` |
| restart / live-0 | `§1§ BOARD LIVE 0` |
| live-1 | `§1§ BOARD OLD 0`, `§2§ BOARD LIVE 1` |
| live-2 | `§1§ BOARD OLD 0`, `§2§ BOARD OLD 1`, `§3§ BOARD LIVE 2` |

`trace.jsonl` separately captured the board assignments **before** each walk: `[]`, then `[board:0:p0 → 1]`, then also `[board:1:p0 → 2]` after restart. LIVE 0 was already tagged with the old number on its first wire pass; it did not get a fresh number later rebound by the resolver. The source prefetch was missing, not the tagging itself.

## Other engines

### Pi

`context-handler.ts:1946-2011` builds `entry_fingerprint` from response ID, timestamp, role, toolCallId, and SHA-256(first text) truncated to 16 hex digits, before mutations. `:2145-2185` uses that fingerprint for unambiguous fallback-ID → real-ID adoption. It is not an exact-ID all-parts content validator.

Pi's text walk is **not** OpenCode's unconditional pristine-source assignment: `packages/plugin/src/shared/tag-transcript.ts:893-965` saves original source first-write-wins, then calls `applyTextPrefixAndTarget` on the incoming text. The reusable exact-ID path (`:907-913`) also prefixes incoming text, without a source restore. So the exact plain-text OLD-over-LIVE replay is not present there. There is already a useful content-derived identity mechanism: `:203-215` hashes the entire ordered text vector and each text, and adds duplicate occurrence rank, when `textIdentityDriftMessageIds` marks the message (`:262-265`). This is stronger than first-text-only entry fingerprints, but it is conditional, not a blanket guarantee for every reused ID. Pristine source can still be stale for consumers such as compression if an unqualified old tag is reused. Do not claim `entry_fingerprint` alone solves this issue.

### Rust / ck-mc

Rust does **not** execute the TS source_contents assignment. Its source is stored as `McTagRow.source_bytes`. `crates/mc-module/src/transform.rs:9421-9442` skips minting when a `block.id` is already in the tag-ID set, otherwise captures source bytes; this skip has no content comparison. `:7533-7562,7580` selects the persisted source by block ID and compresses it on an eligible bust pass. Frozen caveman payloads then provide replay rather than assigning pristine source every pass. Consequently plain text without reclaim/compression does not have this exact TS flip, but reused block IDs can reuse old source/compression/drop authority. Content-qualified identity must be audited there too.

Defer uses `SoftPlus` (`crates/mc-core/src/lib.rs:88-157`, `crates/mc-module/src/transform.rs:5777-5789`); m1 revision differences are queued rather than recomposed (`:3282-3286`). This addresses render epochs, not reused-content identity. The underlying externally supplied cache-core implementation was not available in the checked-in source: do not infer an internal content validator from the SoftPlus name. No Rust real-host collision experiment was run in phase 1.

### OpenCode 2

`packages/plugin/src/v2/hooks/context.ts:1175-1193,1247-1259,1469-1481` sets up the shared handler, adapts the draft, invokes it, and commits it. In TS mode it therefore reaches the same `tagMessages` replay rule; host checkpoint restoration (`:1404-1429`) is not a source-content check. Rust authority uses the Rust path described above. OpenCode 2 was source-traced, not run for this report. A phase-2 gate must run the collision fixture against both host adapters.

## Proposed rule for review

### Identity and representations

Store two distinct things: **canonical source identity** and **last committed served representation**. Source is immutable for a content generation. A hash is an accelerator, not the authority: byte equality remains the final collision check.

1. Capture raw text before our prefix/temporal/reclaim mutations. Normalize only reversible, provenance-known MC decorations (a known leading tag associated with this occurrence); no trimming, Unicode folding, whitespace collapsing, or removal of arbitrary text that merely resembles a marker. Persist normalization version. For recovery with part indices remapped, use same-message ordinal only as a candidate; validate content before adopting.
2. Resolve `(session, host content locator, occurrence/anchor, source digest)` to a generation/tag. A synthetic message's immutable anchor/provenance, when available, distinguishes historical OLD and newly created LIVE occurrences simultaneously. A changed raw payload under a reused locator gets a **new generation and fresh tag**, never overwrite old source, drop state, compression depth or reasoning watermark. Do not simply update the one old tag's message_id and lose the historical binding. If the host gives no way to distinguish two occurrences, keep content variants under the locator, never a global last-writer-wins alias.
3. Accept incoming text as the same generation only if it matches saved source or an explicitly recorded MC representation for that occurrence (prefix, persisted drop/truncate, compression render, temporal decoration). This preserves known transformation drift and state-loss recovery without granting every mismatch permission to restore old source. Recompression is from the same generation's pristine source, not from already compressed text.
4. Before first submission of any generation, choose tag and render and durably record the **exact output bytes** and render epoch. If persistence fails, do not send an unrecorded alternate render and later resume replay. Record at the last owned transform boundary and validate final-provider bytes with a wire observer where available; mutations by a later plugin are not observable merely by hashing MC's draft. Durable request-intent/ack state must distinguish attempted sends and ambiguous crashes, with conservative replay of attempted bytes on recovery.
5. A later defer replays the recorded render exactly, including tag prefix, framing, temporal overlays and compression. A source restoration used for accounting must not itself change served bytes. Changed representations become pending work, published only on a pass independently allowed to rebuild by the existing cache-bust gate, with new render epoch committed atomically.

This fixes the demonstrated cold-source-map omission as well as the mismatch: the recovered tag's source/representation must be fetched on demand in that pass. Merely comparing whatever happened to be prefetched leaves cold recovery unchecked. A newly appended genuinely different board is first served with its new tag/live render; historical replay uses that *same* render. A host that changes text for an already served occurrence cannot force an in-place defer rewrite: new generation must be appended under an independent occurrence, or the request is paused until an authorized rebuild. It must not inherit old drop/compression status.

### Upgrade and the unavoidable ambiguity

Legacy rows contain source, tag, timestamp, harness; neither a source hash nor `tags_version` records the first/last bytes sent. Consider the **same** database row `OLD` and current raw input `LIVE`: prior request could have sent `LIVE` (cold prefetch miss) or `OLD` (warm replay). Choosing either render on upgrade flips the other possible prefix. Rehashing OLD cannot disambiguate those histories.

**Strict recommendation:** first post-upgrade pass with an ambiguous legacy binding is non-serving (clear actionable diagnostic); it does not rewrite a defer wire. An exact trusted pre-upgrade served-wire record can seed that generation's render, provided it is not stale for the intended new occurrence. Otherwise require an independently authorized cache rebuild/explicit operator reset before reseeding from current raw content with new tags. Sessions with existing `cache_ttl=never` must not manufacture expiry or call every mismatch a cache bust. Even a rebuild eligibility flag is insufficient if surviving prefix-bound thinking forbids that change: apply the thinking gate below or continue paused.

This is a deliberate availability tradeoff. If review requires uninterrupted continuation, one requirement must be relaxed: grandfather known stale renders until an allowed rebuild (violates “never serves stale”), or accept a one-time upgrade cache bust (violates defer byte stability). Neither is presented as satisfying all five rules. A host-side pre-upgrade wire export/adoption step could reduce pauses, but current source rows cannot substitute for it. Legacy ambiguous rows may be lazily adopted only with this evidence or on an authorized rebuild; migration must not rewrite their provider-visible bytes.

### Thinking binding

No collision handling calls a text target's `setContent` merely to rebind identity: that setter clears thinking (`tag-messages.ts:871-879`). No new `replayClearedReasoning` watermark or Opus/Fable removal originates on defer. Prefix/identity changes before surviving signed assistant reasoning count as prefix mutations even if the changed block is user text. Preserve exact reasoning content/signature, message order, user boundaries and open tool arcs while replaying.

Use the existing prefix-bound model classification (`overflow-detection.ts:227-243`) and durable recovery gates (`transform-postprocess-phase.ts:429-578`): reasoning removals can originate only on an eligible rebuild with durable decision and safe native envelopes; defer replays only previous decisions. If changing identity would invalidate surviving signatures and the existing recovery cannot safely remove/recover them, **pause** instead of changing bytes. A source hash is not a thinking-safety proof. Required phase-2 tests include Fable 5.1 / Opus 5.5 signed-prefix fixtures, newest open tool round and persistence failure; the present mock claims no real cryptographic validation.

### Storage, migration fence and cost

A stored source hash alone is optional: byte comparison and hashing immutable source once per loaded generation can use the existing `content` field. Do **not** repurpose `created_at`, `harness`, `entry_fingerprint`, or `tags_version`: each has a different contract, and none stores served state.

The recommended complete design **does require schema work**: versioned content-generation/locator binding plus immutable source digest/normalization version and a served-render/epoch record (possibly companion tables rather than a column on source_contents). The exact schema is a phase-2 review decision; this report writes no migration. Current `storage-db.ts:112` fences at `LATEST_SUPPORTED_VERSION = 91`. Any approved addition must go through `migrations.ts`, advance that fence, update initial schema, clones/export/import and TS/Rust readers, and leave old rows explicitly legacy/unknown rather than falsely backfilling “served=source”. Existing Pi content-derived IDs demonstrate that digest-qualified keys themselves can fit existing `tags.message_id`; they do not eliminate the missing render ledger.

Steady-state added cost is bounded by **visible incoming bytes/new generations**, not all session rows. Cache source digests and generation bindings under the existing scoped identity/version lifecycle; index lookup by locator/digest and fetch only candidates on misses. Compute hash once for a new raw value, compare cached byte strings on unchanged representations, persist renders once per first serve or authorized epoch change. Do not load/hash all historical source rows on every pass or run all-session upgrade repair in the hook. Unbounded host transcripts inherently require inspecting that host input; the proposal adds no independent scan over compacted-away session history. Render ledger storage is proportional to retained generations, with later retention bounded by authoritative compaction, not speculative cleanup.

## Phase-2 acceptance gates (not implemented)

- Wire capture: three-plus defer passes, cold/warm/restart; below-floor and unscoped variants; new tags and LIVE bytes remain stable. Compare actual provider blocks, not only storage contents.
- Same-source recovery with lost map, counter drift, ordinal remap and known transformed inputs keeps exact prefix/render; copied prefix on unrelated new content does not authorize stale replay.
- Multiple old/new occurrences with one locator in the same request; no old drop/depth/status inherited; independently authorized rebuild publishes pending work once.
- Upgrade both prior-live and prior-stale histories with identical legacy store: either trusted adoption or pause; no silent defer flip. Crash before/after request submission and failed render persistence also fail closed.
- Signed thinking/user boundaries/open tool arcs; no new reasoning removal on defer.
- Pi, Rust and OpenCode 2 integration gates; large compacted session benchmark proves cost depends on visible data, not session age.

## Verification and limitations

The successful host run asserted version and the LIVE 0 → OLD 0 / LIVE 1 → OLD 1 sequence from captured wire bodies. Initial attempts did not reach the fixture because of a generated-string newline escape and then missing worktree dependencies; those failed attempts are not evidence. The successful run was `bun run docs/reports/issue-578-repro.ts`; its source is retained below as documentation only, not a runtime change. No production source, migration, ARCHITECTURE.md or STRUCTURE.md changed. No mutation proof is claimed: this is an observed defect reproduction and design, not a new silent invariant guard. Schema/build/test changes are deferred to adversarial review.

## Appendix: reproduction harness

Save the following as `docs/reports/issue-578-repro.ts` in this worktree after installing its dependencies. Download/extract the pinned npm binary under `$TMPDIR/magic-context/issue-578/bin/` as described above, then run `bun run docs/reports/issue-578-repro.ts`. Change the `run6` suffix in the harness's first `const root = ...` declaration to an unused directory name for a fresh repeat; never point it at a live session or store. Download commands (no host config/store access):

```sh
mkdir -p "$TMPDIR/magic-context/issue-578/bin"
curl -fsSL https://registry.npmjs.org/opencode-darwin-arm64/-/opencode-darwin-arm64-1.18.30.tgz -o "$TMPDIR/magic-context/issue-578/bin/host.tgz"
tar -xzf "$TMPDIR/magic-context/issue-578/bin/host.tgz" -C "$TMPDIR/magic-context/issue-578/bin"
```

```ts
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MockProvider } from "../../packages/e2e-tests/src/mock-provider/server";

// This fixture uses the production tagger and source store, not a substitute replay rule.
const root = resolve(process.env.TMPDIR!, "magic-context/issue-578/run6");
const repo = resolve(import.meta.dir, "../..");
for (const dir of ["home", "config", "data", "cache", "state", "runtime", "tmp", "work"]) mkdirSync(join(root, dir), { recursive: true });
mkdirSync(join(root, "config/plugins"), { recursive: true });
const plugin = join(root, "config/plugins/fixture.ts");
writeFileSync(plugin, `
import { Database } from ${JSON.stringify(join(repo, "packages/plugin/src/shared/sqlite.ts"))};
import { initializeDatabase } from ${JSON.stringify(join(repo, "packages/plugin/src/features/magic-context/storage-db.ts"))};
import { runMigrations } from ${JSON.stringify(join(repo, "packages/plugin/src/features/magic-context/migrations.ts"))};
import { createTagger } from ${JSON.stringify(join(repo, "packages/plugin/src/features/magic-context/tagger.ts"))};
import { tagMessages } from ${JSON.stringify(join(repo, "packages/plugin/src/hooks/magic-context/tag-messages.ts"))};
import { appendFileSync } from "node:fs";
export default async () => {
 appendFileSync(${JSON.stringify(join(root, "startup.txt"))}, "START\\n");
 const db = new Database(process.env.MAGIC_CONTEXT_STORAGE_DIR + "/context.db");
 initializeDatabase(db); runMigrations(db);
 appendFileSync(${JSON.stringify(join(root, "startup.txt"))}, "DB READY\\n");
 const tagger = createTagger(); let seq = 0; const snapshots = [];
 return { "experimental.chat.messages.transform": async (_, output) => {
  appendFileSync(${JSON.stringify(join(root, "startup.txt"))}, "HOOK\\n");
  const tail = output.messages.at(-1); const sid = tail.info.sessionID;
  const make = (i, text) => ({ info: { ...tail.info, id: "oh-my-opencode-slim:background-job-board:" + sid + ":" + i, role: "user" }, parts: [{ type: "text", text }] });
  if (process.env.FIXTURE_GENERATION === "old" && seq === 0) {
   const seed = createTagger(); seed.initFromDb(sid, db);
   tagMessages(sid, [0,1,2].map(i => make(i, "BOARD OLD " + i)), seed, db);
   // A compacted session's visible floor excludes the earlier board identities.
   for (let i = 0; i < 100; i++) seed.assignTag(sid, "floor-seed-" + i + ":p0", "message", 1, db);
  }
  snapshots.push(make(seq, "BOARD " + (process.env.FIXTURE_GENERATION === "old" ? "OLD " : "LIVE ") + seq)); seq++;
  const boards = structuredClone(snapshots);
  tagger.initFromDb(sid, db, 100);
  const before = [...tagger.getAssignments(sid)].filter(([id]) => id.includes("background-job-board"));
  tagMessages(sid, boards, tagger, db);
  appendFileSync(${JSON.stringify(join(root, "trace.jsonl"))}, JSON.stringify({ generation: process.env.FIXTURE_GENERATION, seq, before, boards }) + "\\n");
  output.messages.push(...boards);
 }};
};
`);
const mock = new MockProvider();
const { baseURL } = await mock.start();
mock.setDefault({ text: "OK", usage: { input_tokens: 1000, output_tokens: 10, cache_read_input_tokens: 900 }, stop_reason: "end_turn" });
const config = { plugin: [`file://${plugin}`], autoupdate: false, share: "disabled", compaction: { auto: false, prune: false }, enabled_providers: ["mock-anthropic"], model: "mock-anthropic/mock-sonnet", small_model: "mock-anthropic/mock-sonnet", provider: { "mock-anthropic": { npm: "@ai-sdk/anthropic", env: [], options: { apiKey: "fixture-not-real", baseURL }, models: { "mock-sonnet": { id: "mock-sonnet", name: "Mock", limit: { context: 200000, output: 8192 } } } } } };
writeFileSync(join(root, "config/opencode.json"), JSON.stringify(config));
const storage = join(root, "data/cortexkit/magic-context"); mkdirSync(storage, { recursive: true });
const env = { PATH: process.env.PATH!, HOME: join(root,"home"), XDG_CONFIG_HOME: join(root,"config"), XDG_DATA_HOME: join(root,"data"), XDG_CACHE_HOME: join(root,"cache"), XDG_STATE_HOME: join(root,"state"), XDG_RUNTIME_DIR: join(root,"runtime"), OPENCODE_CONFIG_DIR: join(root,"config"), OPENCODE_DB: join(root,"data/opencode/fixture.db"), MAGIC_CONTEXT_STORAGE_DIR: storage, MAGIC_CONTEXT_LOG_PATH: join(root,"mc.log"), TMPDIR: join(root,"tmp") };
const bin = resolve(process.env.TMPDIR!, "magic-context/issue-578/bin/package/bin/opencode");
const version = Bun.spawnSync([bin,"--version"], { env }).stdout.toString().trim();
if (version !== "1.18.30") throw new Error(`wrong host ${version}`);
let sid = ""; const evidence = [];
try {
 for (const generation of ["old", "live"]) {
  const port = 24578;
  const child = spawn(bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: join(root,"work"), env: { ...env, FIXTURE_GENERATION: generation }, stdio: ["ignore","pipe","pipe"] });
  let log = ""; child.stdout!.on("data", x => log += x); child.stderr!.on("data", x => log += x);
  const url = `http://127.0.0.1:${port}`;
  try {
   for (let i = 0; ; i++) { try { if ((await fetch(url + "/session", { signal: AbortSignal.timeout(1000) })).ok) break; } catch {} if (i > 120) throw new Error(log); await Bun.sleep(500); }
   writeFileSync(join(root, generation + "-config-effective.json"), await (await fetch(url + "/config")).text());
   if (!sid) sid = (await (await fetch(url + "/session", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).id;
   for (let pass = 0; pass < 3; pass++) {
    const start = mock.requests().length;
    const res = await fetch(`${url}/session/${sid}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "build", model: { providerID: "mock-anthropic", modelID: "mock-sonnet" }, parts: [{ type: "text", text: `PROBE ${generation} ${pass}` }] }), signal: AbortSignal.timeout(60000) });
    const responseText = await res.text(); writeFileSync(join(root, `${generation}-${pass}-response.json`), responseText);
    if (!res.ok) throw new Error(responseText);
    await Bun.sleep(3000);
    const requests = mock.requests().slice(start).filter(r => JSON.stringify(r.body.messages).includes("BOARD"));
    if (requests.length !== 1) throw new Error(`expected one board request, got ${requests.length}: ${log}`);
    const file = `${generation}-${pass}.json`; writeFileSync(join(root,file), JSON.stringify(requests[0].body, null, 2));
    const boardTexts = requests[0].body.messages!.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === "text" && b.text.includes("BOARD")).map(b => b.text);
    evidence.push({ generation, pass, file, boardTexts });
    const lsof = Bun.spawnSync(["lsof", "-p", String(child.pid)]).stdout.toString(); writeFileSync(join(root, `${generation}-${pass}-lsof.txt`), lsof);
    if (lsof.split("\n").some(l => /\.db|\.jsonc/.test(l) && /\/Users\/ufukaltinok\/(\.local\/share\/(opencode|cortexkit)|\.config\/(opencode|cortexkit))\//.test(l))) throw new Error("live-store isolation violated");
   }
  } finally { writeFileSync(join(root, generation + "-host.log"), log); child.kill("SIGTERM"); await new Promise<void>(r => child.once("exit", () => r())); }
 }
 writeFileSync(join(root,"summary.json"), JSON.stringify({ version, root, sid, env, evidence }, null, 2));
 const live = evidence.filter(e => e.generation === "live");
 if (!live[0].boardTexts.some(t => t.includes("LIVE 0")) || !live[1].boardTexts.some(t => t.includes("OLD 0")) || !live[2].boardTexts.some(t => t.includes("OLD 1"))) throw new Error("flip not reproduced");
 console.log(JSON.stringify({ version, root, evidence }, null, 2));
} finally { await mock.stop(); }
```

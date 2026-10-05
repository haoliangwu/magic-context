# Single-store B2: offline migration, design and slicing plan

This is the implementation plan for moving every domain row the Rust module owns out of `store.db` and into `context.db`, in one offline run. It replaces the online, per-project cutover design (`docs/architecture/single-store-b2-cutover.md` on branch `window/b2-cutover-design`, reviewed in `.cortexkit/alfonso/reviews/b2-cutover-athena-synthesis.md`).

The decision it implements:

- `context.db` becomes the only source of truth for memories, notes, compartments, compartment events, primer candidates, user-memory candidates and memory mappings.
- `store.db` shrinks to a rebuildable private cache: cache state, tags, pass trace, reduce ledger and the other per-session cache tables, plus a compartment-date cache.
- The user runs `magic-context doctor single-store migrate` while nothing has either database open. Every project moves in one run.
- After the release, Rust mode refuses an unmigrated store by name. There is no dual-mode path.
- The changefeed mirror, the host/module id translation and the authority machinery are deleted.
- B0 (per-project marker, `context.db` v93 on `window/b0-v92-v93`) is dropped. A store-level flag replaces it. The unrelated ordinal-checkpoint migration on that branch stays and is renumbered around the new v92.

Line numbers are on master at `5f3db46c45`. Shorthand used below:

| Short | Path |
|---|---|
| `store:N` | `crates/mc-store/src/lib.rs` |
| `module:N` | `crates/mc-module/src/lib.rs` |
| `transform:N` | `crates/mc-module/src/transform.rs` |
| `host_store:N` | `crates/mc-module/src/host_store.rs` |
| `migrations:N` | `packages/plugin/src/features/magic-context/migrations.ts` |
| `storage-db:N` | `packages/plugin/src/features/magic-context/storage-db.ts` |
| `authority-ts:N` | `packages/plugin/src/features/magic-context/context-authority.ts` |
| `rmt:N` | `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts` |
| `ssm:N` | `crates/mc-module/src/single_store_migrate.rs` on `window/b2-slice-b1` (`3d70b7a235`) |

## 1. Inventory

### 1.1 Domain tables and their `context.db` counterparts

| `store.db` table | Defined | `context.db` counterpart | Notes |
|---|---|---|---|
| `mc_memories` | `store:542-571`; `context_store_uuid`/`context_row_id` added `store:988-995`; `host_row_id` added `store:2753` | `memories`, `storage-db:1159-1191` | Same columns and the same `UNIQUE(project_path, category, normalized_hash)`. Context adds the mural-cue columns. The three id columns exist only for the mirror. |
| `mc_memory_mutation_log` | `store:584-596` | `memory_mutation_log`, `storage-db:1293-1309` | Same shape. Not copied (section 2.8). |
| `mc_notes` | `store:770-782`, rebuilt `store:1218-1269` | `notes`, `migrations:272-292` plus later columns | Store has `status_version` and the module-only states `surfacing`/`surfaced` (`store:1226`). Context has neither. |
| `mc_note_deliveries` | `store:1271-1282` | none | Module-internal delivery bookkeeping. Not copied; the note states collapse the way `ssm:826` (`note_status`) already does. |
| `mc_compartments` | `store:510-528`; `start_date`/`end_date` added `store:818-825` | `compartments`, `storage-db:987-1010` | Store keys by `(session_id, sequence)` and has no row id. Context has `id AUTOINCREMENT`, `UNIQUE(session_id, sequence)`, `harness`, `p1_embedding`, and **no date columns**. |
| `mc_compartment_events` | `store:1969-1980` | `compartment_events`, `storage-db:1041-1053` | Store `compartment_id` holds the compartment's sequence, because store compartments have no id (comment at `store:1963-1967`). Context `compartment_id` is `compartments.id`. |
| `mc_primer_candidates` | `store:1982-1998` | `primer_candidates`, `storage-db:1083-1106` | Same natural key. |
| `mc_user_memory_candidates` | `store:2000-2011` | `user_memory_candidates`, `migrations:386-393` | Same shape. |
| `mc_memory_mappings` | `store:1940-1947`, `mapping_origin` `store:2463-2470` | `memory_verifications`, `storage-db:1280-1291` | Store keeps one JSON array of files per memory. Context keeps one row per file (`mapped_at`, `verified_at = 0` for mapped but unverified, `mapping_origin`). |
| `mc_user_memories` | `store:607-618` | `user_memories`, `migrations:396-405` | The store copy is a state-sync projection written by `replace_authority_user_profile_tx` (`store:18193`). Context wins; not copied. |
| `mc_workspaces`, `mc_workspace_members` | `store:628-644` | `workspaces`, `workspace_members`, `storage-db:1425-1443` | Projection written by `replace_workspace_tx` (`store:17880`) from state sync. Context wins; not copied. |

Missing counterparts:

- **Compartment dates.** `mc_compartments.start_date`/`end_date` have nowhere to go. TypeScript derives dates at render time from message times (`withCompartmentDates`, `packages/plugin/src/hooks/magic-context/inject-compartments.ts:2018-2067`). The module renders the stored strings (`compartment_heading`, `crates/mc-module/src/decay_render.rs:135-148`). The fix is a derived `store.db` cache, `mc_compartment_dates`, keyed `(session_id, sequence)` and carrying `start_message_id`/`end_message_id` so a stale row is ignored. **No branch has built it.** The cutover design called it "store migration 63", but `git grep mc_compartment_dates` finds nothing on `window/b2-slice-b1`, `window/b2-slice-a` or `window/b2-cutover-design`. Here it is part of store migration 61 (section 2.9).
- **Note `status_version` and the delivery states.** No context column exists. Notes are not a prefix input (`crates/mc-module/src/m1_compose.rs:60-62`: smart notes are not rendered into m1), so nothing needs a note revision.

### 1.2 Mirror, changefeed and authority machinery

Rust, `store.db` schema:

- `mc_changefeed` and `mc_authority` (`store:997-1032`), and the feed triggers on `mc_memories`/`mc_notes` (`store:1034` onward, re-created at `store:2338` and `store:2760`).
- `mc_memory_visibility_epoch` and its trigger (`store:1170-1201`, re-created at `store:1468`, `store:1543`).
- `mc_authority_seed_rows`, `mc_authority_pending_memory_references` (`store:1414-1422`, rebuilt `store:1479`).
- `mc_authority_route_bindings` and its rekey triggers (`store:1555+`).
- The facade-authority triggers on `mc_memories`/`mc_notes` (`store:1838+`, migration 33) and the facade/note-scope columns of `mc_privilege_state` (`store:2582+`).
- `shadow_memories`, `shadow_memory_mutation_log` (`store:669-712`) and `shadow_user_profile` (`store:941-948`). Nothing reads or writes them any more; the only references are their `CREATE` statements.
- Not domain and not touched here: `shadow_divergences` (`store:714-731`, diagnostics) and `mc_transform_session_roots` (`store:1838`, cache).

Rust, module routes and store code:

- Routes (`module:14826-14842`): `authority.status`, `authority.prepare`, `authority.seed`, the `authority.drain*` family, `mirror.pull`, `mirror.memory`, `memory.identity.ack`. Handlers are at `module:9372`, `:9403`, `:9497`, `:9550`, `:9659`, `:9675`, `:9708` (the block ends at `module:9750`).
- Store methods: `authority_project_state_for_route` and `authority_project_for_route` (`store:8252`, `:8289`), `authority_status` through `authority_finish_drain` (`store:16367-16812`), `seed_authority_row(s)` and `authority_seed_checksum` (`store:16916-16979`), `seed_memory_snapshots` (`store:17010`), `changefeed_head`, `pull_memory_changefeed_row`, `pull_changefeed` (`store:17659-17723`), `acknowledge_host_memory_ids` (`store:13195`).
- The id translation: `module_memory_ids_for_host_ids` and `host_memory_ids_for_module_ids` (`store:14446`, `:14484`), used by m1 (`crates/mc-module/src/m1_compose.rs:382`, `:496`). m0 and m1 render `host_row_id` (`crates/mc-module/src/m0_compose.rs:498`, `m1_compose.rs:515`, `transform:2782`).
- The facade id lanes: `MemoryIdLane` and `memory_id_lane` (`module:18359-18373`, `:18449-18455`), `host_memory_ids` (`module:18457`), `NoteIdSpace` with `note_id_map` (`module:18010-18093`).
- The state-sync domain half: `load_state_sync_inventory` (`store:8662`) and `apply_state_sync` (`store:11357`), with its seed compartments, memory/mutation replacement, user profile and workspace writes. `commit_state_import` (`store:10773`) inserts compartments.
- The `session.status` compartment page the host mirrors compartments from (`handle_session_status_value`, `module:8235`).

TypeScript:

- `authority-ts` is almost entirely this machinery: the `authority_managed` marker functions (`authority-ts:188-233`), `reconcileAuthorityMarker`/`reconcileAuthorityProject` (`:249`, `:343`), `domain_mutation_epoch` read and bump (`:459-485`), `prepareAuthority` (`:561-701`), `drainAuthority` (`:718-904`), mirror status (`:951`), the mirror page appliers (`:1432-2405`), the id helpers `moduleMemoryIdentityForHostId`/`hostMemoryIdentityForModuleId` (`:1646`, `:1668`), the live resnapshot (`:2409`), `drainMirrorPages` and `pullMemoryMirrorOnce` (`:2612-2682`).
- Rust-mode transform: `prepareRustMemoryAuthority` (`rmt:1340-1501`, called at `rmt:3154`) and the mirror block (`rmt:4073-4157`): `pullMemoryMirrorOnce` (`rmt:4087`), `reembedMirrorInvalidatedMemories` (`rmt:4101`), `mirrorModuleCompartments` (`rmt:4128`). Keep `drainSingleStoreEmbeddingWatermarks` (`rmt:4106`; defined at `packages/plugin/src/features/magic-context/memory/single-store-embedding-drain.ts:58-106`). It is how hosts embed memories the module writes, and it has to move out of the mirror block.
- State sync (`packages/plugin/src/hooks/magic-context/module-state-sync.ts`): the domain payload fields `compartments`, `memories`, `memory_mutations`, `user_profile`, `workspace`, `project_memory_epoch`, `user_profile_version` (`:161-168`), `resyncModuleCompartmentsFromAuthoritative` and `mirrorModuleCompartments` (`:380-529`), `readCompartmentsAfterSequence` (`:1083`), `readRenderedMemoryIds` (`:1137`). The non-domain seeds (drops, hints, strips, todo anchor, latches; `:169-183`) stay.
- Tool routing: `packages/plugin/src/plugin/memory-id-translation.ts` (whole file; `translateHostMemoryIds` at `:195`), `packages/plugin/src/plugin/rust-note-backend.ts` (whole file), and in `packages/plugin/src/hooks/magic-context/module-tool-backends.ts` the mirror drain (`:71`), the identity ack (`:86-87`) and the id translation (`:133`).
- Authority recovery on leaving Rust mode: `recoverTsAuthorityProject` (`packages/plugin/src/hooks/magic-context/transform.ts:423-545`). Authority checks in `packages/plugin/src/plugin/dream-timer.ts:702-706` and `packages/plugin/src/plugin/rpc-handlers.ts:803-811`.
- `context.db` schema: `authority_managed`, `authority_repair_pending`, `mirror_identity`, `mirror_cursors`, `context_privilege_state` and the guard triggers (`migrations:2216-2335`); `authority_capture_bounds`, `mirror_pending_references`, `mirror_note_revisions` (`migrations:2412-2443`); `domain_mutation_epoch` (`migrations:2446-2467`); `mirror_live_memory_rows`, `mirror_resnapshot_state`, `mirror_live_staging` (`migrations:2470-2550`).

The B1 shadow writers (on master): `crates/mc-module/src/host_store.rs` writes `context.db` under `SingleStoreMode::Shadow`, against a scratch copy only (`host_store:1-38`, `:151-199`). It is wired at `module:5481-5485`, reported at `module:8580`, and fired by the historian at `crates/mc-module/src/historian.rs:1025-1034`. The shadow comparison and the mode switch go. The writer itself stays and becomes the live writer (section 3.1).

### 1.3 What already exists, and what is reused

**On master:**

- A store-level marker already exists. Store migration 58 (`store:2997-3019`) adds `mc_privilege_state.single_store`, `single_store_set_at_ms` and `single_store_set_by`. `SINGLE_STORE_CAPABLE = false` (`store:3098`) makes `McStore::open` refuse a marked store with `single_store_marker` (`store:7864-7872`).
- The store-ahead refusal (`store:7844-7851`) is surfaced on every request lane except `echo` (`module:14809-14820`), with the MC-C13 sentence at `module:381-385`.
- Both refusals shipped in v0.44.0 (commits `6b7ccdddb4` and `44b484ca79`).
- The B1 writer: `with_privileged_transaction` (`BEGIN IMMEDIATE` and an in-transaction fingerprint recheck, `host_store:885-932`), `publish_fold` (`host_store:1598`), `raise_embedding_watermark` (`host_store:1414`), busy timeout (`host_store:77`, `:766`).
- Store migrations end at 60 (`store:3038`).

**Not on master.** The brief says master has slice A's store migrations 61-62. It does not. They are on `window/b2-slice-a` (`b7d9c435e8`) and `window/b2-slice-b1`. The same is true of `single_store_migrate.rs`, the `doctor single-store migrate` command (`0402ec646a`), the step-1 read seam (`6b8c516e40`) and the workspace refusal (`3d70b7a235`). `window/b2-slice-b1` also carries B0's v92/v93 commits.

Reuse, once the per-project marker becomes one store-level flag:

| Piece (branch `window/b2-slice-b1`) | Reuse |
|---|---|
| `ssm:472-602` column lists, `build_model` (`ssm:833`), `supersession_order` (`ssm:788`), `note_status` (`ssm:826`) | as is |
| `resolve_memory` (`ssm:1026-1089`), `resolve_note` (`ssm:1116`), `translated_superseded` (`ssm:1179`), `desired_event` (`ssm:1239`) | as is; twin resolution is the mirror's own order: identity row, then seeded context id, then a unique natural-key match |
| `CompartmentFate`, `compartment_fate`, `event_fate`, `candidate_fate`, `match_multiset`, `plan`, `apply_item`, `verify` (`ssm:1291-1406`, `:1540-1671`, `:1834`, `:2080`) | as is, run once over all projects |
| Holds, copy registry and write gate (`ssm:294-466`), chunked copy transactions, drift snapshot, final-marker transaction, neutralisation (`ssm:2157-2557`) | dropped; they exist only because the online move ran beside live writers |
| Refusals `CUTOVER_ABSENT`, `MARKER_WRITE_REFUSED`, `COPY_IN_PROGRESS`, `WORKSPACE_PARTIAL`, `HOST_LESS` (`ssm:42-62`) | dropped. One run moves every workspace member. Embeddings are handled by the watermark (section 2.6) instead of refusing host-less sessions. |
| `AUTHORITY_NOT_MODULE`, `UNCLASSIFIED_ROWS`, `VERIFY_MISMATCH`, `FINGERPRINT_MISMATCH` | kept. `AUTHORITY_NOT_MODULE` becomes the winner rule of section 2.5. |
| `SingleStoreDomain` seam (`crates/mc-store/src/single_store_domain.rs`) and `ContextDomainReader` (`crates/mc-module/src/single_store_reads.rs`) | Reader connection and the four reads kept. `is_marked` and `marked_project_for_session` go: every read goes to `context.db`. |
| Store migration 61 `mc_single_store_migrations` | dropped (per-project phases) |
| Store migration 62 `mc_single_store_pending_publish` | kept, folded into the new migration 61 (section 3.3) |
| B0: `single_store_projects` (v93), `mirror.marker_status`, `single-store-marker.ts`, the tripwires (`8a3d60bfa3`, `eb8c3c89ec`, `c13ba073da`, `3c173fa0a3`, `7dd1a1d926`) | dropped |

## 2. `doctor single-store migrate`

### 2.1 Shape

The command has two halves.

1. **`magic-context doctor single-store migrate` (TypeScript, `packages/cli`)** runs the preflight (2.2) and opens `context.db` with the plugin's own opener, which applies `context.db` v92 like any host start. It then runs the engine and prints the report.
2. **The engine, `ck-mc single-store-migrate --context-db <p> --store-db <p> --backup-dir <dir> [--dry-run] [--skip-foreign] [--prefer <project>=store|context]... [--accept-id-change]` (Rust).** It is a pre-dispatch argument of the `ck-mc` binary, like `--version` (`crates/mc-module/src/main.rs:20-23`), so it runs without subc and without the module serving.

The engine is Rust for three reasons:

- the copy code to reuse is Rust (1.3);
- the render check has to run the module's own m0 composers;
- `rusqlite::backup` gives the SQLite backup API.

Slice A reached the module over subc (`window/b2-slice-b1:packages/cli/src/commands/doctor-authority.ts:313-354`), which an offline run cannot do. The CLI finds the binary where the subc manifest installs it, and `--ck-mc <path>` overrides that.

### 2.2 Preflight (refuse before writing anything)

1. **Nothing has the files open.** The command lists `context.db`, `store.db` and their `-wal`/`-shm` files (the suffix list is `packages/cli/src/commands/doctor-repair-db.ts:28`).
   - It asks `lsof` through `probeHostProcessesUsing` (`packages/cli/src/commands/doctor-opencode2-cache.ts:76-97`). If `lsof` fails, the answer is "unknown" and the command refuses; it never treats a failure as "free" (`:90-91`).
   - It adds the RPC-server and Pi/OMP liveness check `doctor repair-db` uses (`defaultInspectHolders`, `doctor-repair-db.ts:73-99`).
   - The default live directory retains conservative global Pi/OMP liveness refusal. For a non-default target, only target-file holders or processes whose readable command/environment references that directory block. Unrelated ambiguous Pi processes do not; an `lsof` failure still refuses. Repair and migration share this check.
   - Refusal: `single_store_files_in_use` with one line per holder, `<kind> (PID n)`, and "quit OpenCode, Pi and ck-mc (`ck stop magic-context`) and run again".
2. **Versions.**
   - `context.db` must be exactly v92 after the opener ran; it records versions in `schema_migrations`.
   - `store.db` must be exactly v60 in `cortexkit_schema_version`, namespace `mc_cache` (read the way `scripts/backup-live-stores.sh` reads it). A lower `store.db` is first brought to 60 by the ordinary chain (`store:7833`).
   - Anything newer refuses with `single_store_version_mismatch`, naming both versions.
   - A store already at 61 or later with its marker set is the "already done" path (2.11).
3. **Paths agree.** The engine resolves `context.db` with `resolve_context_db_path` (`host_store:2135`). The CLI passes its own resolution, and the engine refuses `single_store_path_mismatch` if the two differ. This is the environment split slice A had to diagnose (`reportModuleContextDbPath`, same b1 file `:356-412`).
4. **Disk.** Free space on the data volume must be at least `size(context.db) + size(store.db)` (the backup, if it goes to the same volume) plus `2 × size(store.db)` (rollback journal and new `context.db` pages) plus 10%. Otherwise `single_store_disk_space`, printing need and have. On the specimen pair in 5.2 that is about 9.9 GB.

### 2.3 Backup

- Both files are copied with `VACUUM INTO` (a consistent snapshot of each, read-only on the source) into the exact directory `--backup-dir` names. That directory must not exist yet; if it does, the engine refuses `single_store_backup_dir_exists`.
- Each copy gets `PRAGMA quick_check`, and a `MANIFEST.tsv` records name, source path, schema version and sha256, as `scripts/backup-live-stores.sh:55-80` does. The check and the hash each read the whole copy, so they run side by side.
- **Where the time goes.** On the 5.2 specimen, verifying the 6.9 GB `context.db` copy is most of the run. The copy, the one transaction and `VACUUM` take seconds to a minute or so. The engine prints each step and its duration on stderr, so a long run is visibly moving. Measured with a release `ck-mc` on a machine at load average about 250 (other builds running): 7 min 56 s wall and 57 s of user CPU. That was 93 s to copy `context.db` and 289 s to check and hash it, then 32 s for the transaction and 21 s for `VACUUM`. A debug build spends about 8 CPU minutes on the two sha256 digests alone, so drills should use a release build.
- **Paths.** The engine refuses `single_store_path_mismatch` unless `--context-db` is the file the module itself would open (`resolve_context_db_path`: `MAGIC_CONTEXT_STORAGE_DIR`, else `XDG_DATA_HOME`/`~/.local/share` under `cortexkit/magic-context`). A drill therefore lays its copy out as `<root>/cortexkit/magic-context/{context,store}.db` and sets both `MAGIC_CONTEXT_STORAGE_DIR=<root>/cortexkit/magic-context` and `XDG_DATA_HOME=<root>` for the engine.
- The command prints the directory and the restore command, before any write:

```
To undo: quit every host, then
  rm -f <data>/context.db-wal <data>/context.db-shm <data>/store.db-wal <data>/store.db-shm
  cp <backup>/context.db <backup>/store.db <data>/
This restores the unmigrated stores. Keep the current plugin and ck-mc: TypeScript mode works as before, and Rust mode will refuse with MC-C14 until you run this command again.
```

The backup is the rollback. Nothing else is (section 2.9).

### 2.4 The one transaction

The copy, the flags and the cache reset commit together in both files.

1. **Journal mode.** `context.db` and `store.db` are WAL files. SQLite commits an ATTACHed transaction atomically per file, but not across files, when the files are in WAL mode (https://www.sqlite.org/wal.html, "Transactions that involve changes against multiple ATTACHed databases are atomic for each individual database, but are not atomic across all databases as a set").
   - So the engine sets `PRAGMA journal_mode=DELETE` on both files first. That is allowed only because nothing else has them open (2.2).
   - It then `ATTACH`es `store.db` as `store` and runs one `BEGIN IMMEDIATE` transaction. With rollback journals, SQLite's super-journal makes the commit atomic across both files.
   - Afterwards, including on failure, it sets `journal_mode=WAL` on both. If the process dies in between, the next opener rolls back any hot journal. The command also restores WAL on every run, including a re-run after a crash.
2. Inside the transaction, in order:
   1. apply store migration 61's create statements (`mc_compartment_dates`, `mc_single_store_pending_publish`);
   2. classify projects (2.5) and plan the copy (reusing `plan`, `ssm:1540-1671`), refusing before any write on an ambiguous project;
   3. copy and reconcile rows (2.6, 2.7), copy compartment dates into `mc_compartment_dates`;
   4. reset the module cache (2.8) and bump `project_state.project_memory_epoch` for every project whose rows changed;
   5. clear the `context.db` authority and mirror rows (section 4.2);
   6. verify (2.10);
   7. apply the rest of store migration 61 (drops and the flag) and write the `context.db` flag row (2.9);
   8. `COMMIT`.

A 956 MB `store.db` holds tens of thousands of domain rows (5.2), so one transaction is small next to the offline window. No chunking is needed because nothing waits on the lock.

### 2.5 Projects, and which side wins

A project is in the run if it has rows in either file. For each project `P` and domain (`memories`, `notes`), read `P`'s `mc_authority` row for **this** file's `context_store_uuid` (`context_store_meta`, `migrations:2222`) and whether `authority_managed` (`migrations:2226`) lists `P`:

| Authority | Memories and notes | Mappings |
|---|---|---|
| `MODULE` in both domains, and `authority_managed` lists `P` | **store wins**: twin updated to store values, store-only rows inserted | store wins |
| `TS`, or no authority row, and `authority_managed` does not list `P` | **context wins**: twins left alone, store-only rows inserted (module writes the mirror had not pulled yet) | context kept |
| `PREPARING` or `DRAINING`; `MODULE` in one domain only; or store and `authority_managed` disagree | refuse `single_store_authority_in_transition`, naming `P` and both states, unless `--prefer P=store` or `--prefer P=context` | follows `--prefer` |
| authority rows exist only under another `context_store_uuid` | refuse `single_store_foreign_context`, naming `P`, the uuid and row counts, unless `--skip-foreign`. With the flag, `P`'s store rows stay only in the backup, and the report says so | same |

`--prefer` is an explicit operator choice, not a guess. The refusal lists the exact flag to pass.

Session-keyed rows (compartments, events, candidates, primers) belong to the session:

- **Compartments: store wins**, for every session that has `mc_compartments` rows. The module is the only writer of a Rust-mode session's compartments, and the host's context rows are mirror copies (`mirrorModuleCompartments`).
  - A context compartment at the same `(session_id, sequence)` is updated in place, keeping its `id` so chunk embeddings survive.
  - A missing sequence is inserted.
  - Context sequences above the store's maximum are removed (`CompartmentTrim` in `plan`).
- **Events, candidates, primers:** each store row is matched to a context twin by value (`match_multiset`, `ssm:1383`) and missing ones are inserted.
- **User memories and workspaces:** context wins without copying (1.1).

### 2.6 Ids and references

- **Twins keep their `context.db` id.** Twins are found by `resolve_memory`/`resolve_note` (`ssm:1026-1177`): `mirror_identity` first, then the seeded `context_row_id` if it is in the same file, then a unique match on the natural key. A twin owned by another project refuses with `single_store_verify_mismatch` (`ssm:1043-1049`).
- **Store-only rows get a new AUTOINCREMENT id.** The engine keeps a `store id → context id` map for the run.
- **References are remapped through that map:**
  - `superseded_by_memory_id`. Rows are inserted in supersession order (`supersession_order`, `ssm:788`) so a target always has its id first.
  - The ids inside `merged_from`, a JSON array of memory ids. The specimen has 476 such rows.
  - `mc_memory_mappings.memory_id` becomes `memory_verifications.memory_id`, one row per file in `mapped_files_json`, with `verified_at = 0` and `mapped_at = updated_at`. A null array (independent) writes no row, as the dreamer's mapper does (`packages/plugin/src/features/magic-context/dreamer/map-memories.ts:608`).
  - `mc_compartment_events.compartment_id` (a sequence) becomes the context `compartments.id` of `(session_id, sequence)`, after compartments are written (`desired_event`, `ssm:1239-1251`).
  - Candidates and primers reference compartments by sequence range, and sequences are copied verbatim, so they need no remap.
- **A reference that cannot be resolved refuses the run.** Examples: a `superseded_by_memory_id` naming a store id that is neither in the model nor in `mirror_identity`, or a `merged_from` id with no row. The code is `single_store_dangling_reference`; the run never writes NULL in its place.
- **Embeddings.**
  - Store-only memories are inserted without embeddings. Each such project's `memory_embedding_watermarks` row is raised to the highest id inserted, as `raise_embedding_watermark` does (`host_store:1414`).
  - A twin whose content the copy changed loses its `memory_embeddings` row.
  - Hosts re-embed both through `drainSingleStoreEmbeddingWatermarks` on their next pass.
- **Claude Code sessions.** A session whose `meta.last_serializer_profile` is the Claude Code profile rendered module ids (`transform:2778-2783` renders host ids only for host-backed sessions). Where a store id it rendered now names a different memory in `context.db`, the run refuses with `single_store_claude_code_ids`, listing the sessions, unless `--accept-id-change`. An agent in such a session could otherwise act on an id that now points at another memory of the same project. Host-backed sessions only ever saw host ids, which are the context ids. The exception is unacknowledged rows, which rendered as id 0 (`crates/mc-module/src/m0_compose.rs:498`), and an agent cannot act on 0.

### 2.7 Rows that exist only in `context.db`

This is the earlier ruling, kept as slice A built it (`plan`, `ssm:1586-1669`):

- A context **event** or **user-memory candidate** with no store twin is classified by the compartment it points at (`event_fate`, `candidate_fate`, `ssm:1327-1378`):
  - unchanged, so kept;
  - superseded (the store rewrote the compartment, or truncated below it), so deleted;
  - anything the engine cannot show, so the run refuses `single_store_unclassified_rows`, naming the session, table and id.
- An event whose `compartment_id` names a compartment id that no longer exists is an **orphan** (`CompartmentFate::Orphan`, `ssm:1298-1302`). It is kept, never copied or deleted, and counted in the report (`orphans_kept`).
- A context **memory or note** in a store-wins project with no store twin:
  - if a `mirror_identity` row maps it to a store row that no longer exists, the module deleted it and the mirror had not applied the tombstone, so it is deleted;
  - with no identity row, the run refuses `single_store_verify_mismatch`, as `verify` does today (`ssm:2080`).
- Context-only rows in a context-wins project are simply kept.

### 2.8 Cache reset

Every `mc_cache_state` row is changed in the same transaction:

- `meta.project_memory_epoch_pending = true`. This is the existing eager-HARD lane (`store:4629-4634`). It feeds `hard_fold_requested` (`transform:2920`, `:2984-2986`; compaction-off pipeline `transform:4188`, `:4353`), which the classifier turns into `Hard` before any m1 composition (`classify` rule 4, `crates/mc-core/src/lib.rs:135-138`). The pass records `materialize_reason = "project_memory_epoch"` (`transform:3306-3307`).
- `meta.max_memory_id = 0`, `meta.memory_mutation_cursor = 0`, `meta.m1_revision = 0`, `meta.rendered_memory_ids = []`. These are store-space numbers (`store:4600`, `:4676-4684`). The HARD rewrites all four, and zeroing them means nothing between load and that HARD compares a store id with a context id.
- Uninitialised sessions need nothing. Their first pass is the bootstrap HARD (rule 1, `crates/mc-core/src/lib.rs:116-118`).

Everything else in `meta` stays (historian state, coverage, revert epoch, latches), and the other per-session cache tables (`mc_tags`, `pending_agent_drops`, `mc_pass_trace`) are not touched.

TypeScript-mode sessions of a migrated project take one HARD too. The migration bumps `project_state.project_memory_epoch` for every project it changed, and TS treats an epoch or workspace-fingerprint change as HARD (`packages/plugin/src/hooks/magic-context/inject-compartments.ts:1821-1829`). That is right: the migration may have rewritten memories those sessions rendered.

**Why the pending mutation tail is not copied.**
- The synthesis asked to translate and copy each session's log tail after its m0 cursor, so that pending SOFT work stayed SOFT (`.cortexkit/alfonso/reviews/b2-cutover-athena-synthesis.md`, item 3).
- A HARD recomposes m0 from the current rows and sets the cursor to the current head (`transform:3106-3130`). Every addition and correction the tail described is then already inside the new m0, and nothing is left to render as a delta.
- The tail only mattered if the first pass could stay SOFT. The owner accepted one HARD per session instead.
- The `store.db` mutation log is dropped with the table.

### 2.9 Flags and fences

**`context.db` v92.** It is the next free number on master (`migrations:3134` is 91). The ordinal-checkpoint migration on `window/b0-v92-v93` is renumbered to 93. It is a TypeScript migration, applied by any new plugin's opener:

```sql
CREATE TABLE IF NOT EXISTS single_store_state (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    state         TEXT NOT NULL CHECK (state IN ('required', 'migrated')),
    migrated_at   INTEGER,          -- equals store.db mc_privilege_state.single_store_set_at_ms
    migrated_by   TEXT,             -- ck-mc build identity
    backup_dir    TEXT,
    report_json   TEXT
);
INSERT OR IGNORE INTO single_store_state(id, state) VALUES (1, 'required');
```

- It is additive, so a plugin that starts before the doctor runs does no harm. Rust mode stays refused (3.6) and TS mode works.
- It bumps `LATEST_SUPPORTED_VERSION` (`storage-db:109`) and `BUILT_CONTEXT_FENCE_VERSION` (`host_store:67`) to 92.
- Older plugins then fail closed at their fence (`docs/architecture/storage.md:30`).
- v92 also adds nullable `start_block_index INTEGER` and `end_block_index INTEGER` to `compartments` and its recompaction staging table, `recomp_compartments`. The migration remains additive over populated v91 tables. Dates stay in the `store.db` cache. Because v92 is unshipped, this extends v92 rather than consuming v93; scratch databases made with an earlier B2 draft must be recreated from their pre-cutover backups.

**`store.db` migration 61.** It carries:

- `mc_compartment_dates(session_id, sequence, start_message_id, end_message_id, start_date, end_date, PRIMARY KEY(session_id, sequence))`;
- `mc_single_store_pending_publish` (slice A's 62, unchanged);
- `DROP` of the moved tables (`mc_memories`, `mc_memory_mutation_log`, `mc_notes`, `mc_note_deliveries`, `mc_compartments`, `mc_compartment_events`, `mc_primer_candidates`, `mc_user_memory_candidates`, `mc_memory_mappings`, `mc_user_memories`, `mc_workspaces`, `mc_workspace_members`), of the mirror and authority tables and triggers (section 4.1), and of the unused `shadow_memories`, `shadow_memory_mutation_log`, `shadow_user_profile`;
- `UPDATE mc_privilege_state SET single_store = 1, single_store_set_at_ms = ?, single_store_set_by = ?` (columns from migration 58).

The tables are dropped here, not in a later cleanup:

- The new binary has no code that reads them (section 4).
- A present-but-empty table would let a missed read return nothing silently instead of failing.
- The backup holds the rows.

The engine runs `VACUUM` on `store.db` after the commit and reports the size before and after.

`McStore::open` must never apply 61 to a store that still holds rows. Before migrating, if the recorded version is 60 or lower and any moved table has a row, `open` refuses `single_store_migration_required` (3.6). A store with no domain rows (a fresh install) gets 61 applied by `open` as usual. The engine applies 61's statements inside its own transaction and writes the version row itself, so 61 is kept as named statement constants shared by `MIGRATIONS` and the engine.

`SINGLE_STORE_CAPABLE` flips to `true` (`store:3098`). A marked store is now the normal case, and the check is inverted.

What older builds do:

- **ck-mc from v0.44.0 on** refuses the migrated store twice: store-ahead (61 is above its 60, `store:7844-7851`, MC-C13) and the marker (`store:7864-7872`, `single_store_marker`).
- **ck-mc before v0.44.0** logged store-ahead and kept going (comment at `store:7839-7843`). It does not know the marker. On a migrated store it fails later with "no such table" on the first domain read. The failure is loud, but it does not name the cause. This is the honest limit. The release notes tell Rust-mode users to update ck-mc and the plugin together, and the only outside Rust-mode user is on v0.44.x.
- **Older plugins** refuse `context.db` v92 at the fence.
- **The module's `context.db` fence is reported, not enforced** (`BUILT_CONTEXT_FENCE_VERSION`, `host_store:61-67`; per-table fingerprints decide writability). So an old `ck-mc` is stopped by `store.db` (store-ahead and the marker), not by `context.db` v92.

The two flags carry the same stamp: `single_store_state.migrated_at = mc_privilege_state.single_store_set_at_ms`. The module compares them at start (3.6), which binds this `store.db` to this `context.db`.

**Fresh installs.** A host-less install (for example Claude Code through Thalamus, or a module test rig) must first run `npx @cortexkit/magic-context doctor store init`. This provisions `context.db` through the same TypeScript schema/migration path hosts use, reports its path and schema version, and leaves an existing store unchanged (refusing a newer schema). It honours `XDG_DATA_HOME` and `MAGIC_CONTEXT_STORAGE_DIR`; no OpenCode or Pi session is needed. `setup` also provisions the store, except in dry-run mode. The module deliberately does not create this database itself.

When `McStore::open` applies store migration 61 to an empty store, the module then writes `single_store_state` to `migrated` with the same stamp and an empty report, in one `BEGIN IMMEDIATE` on `context.db`. It also clears the `authority_managed` and mirror rows. Nothing needs moving, so a new Rust-mode user never has to run `doctor single-store migrate`.

### 2.10 Verification before `COMMIT`

Any failure rolls back both files.

1. **Row counts per project and per table.** For store-wins tables, every store row has a twin equal on the compared columns, so the store count equals the matched count. For context-wins tables, every store-only row was inserted. For session tables, the context compartment set for each session equals the store set, sequence for sequence. The report prints `source / copied / updated / kept / deleted / orphans_kept` per table and project (the `TableCounts` shape, `ssm:219`).
2. **Reference integrity, over the moved projects:**
   - every non-null `superseded_by_memory_id` and every `merged_from` id names an existing `memories` row;
   - every `memory_verifications.memory_id` exists;
   - every `compartment_events.compartment_id` is null, names a compartment of the same session, or is one of the counted orphans;
   - `PRAGMA foreign_key_check` passes on `memory_verifications`;
   - no `mirror_identity`, `authority_managed` or `authority_repair_pending` row is left.
3. **Render check.** The sample is every session with an `mc_cache_state` row active in the last 7 days (`last_activity_at`, `store:1955-1961`), plus 100 other sessions picked with a seed that the report prints. For each, the engine composes m0 twice with the module's composer (`compose_m0_from_store`, `crates/mc-module/src/m0_compose.rs:429`): once from the old rows in the attached `store` schema, through a read-only legacy reader that lives only in the engine, and once from `context.db` plus `mc_compartment_dates`.
   - Both use the session's stored render config, `now = meta.expiry_cutoff_ms`, and a memory budget that admits every memory. Tie order inside a budget cut then cannot change which memories are selected.
   - **Must be equal:** the compartment block, byte for byte, including the date segment of every heading; and the memory block as a multiset of `(category, content)` lines per category.
   - **Allowed to differ, and why:**
     - Memory id tokens: store ids, or 0 for unacknowledged rows, before; context ids after.
     - The order of lines inside a category: the block sorts by category, then rendered id (`memory_render_order`, `crates/mc-module/src/memory_render.rs:59-77`, applied at `:127`), and ids changed.
     - Date placement cannot differ. The cache is copied from the same strings and matched on message ids, so a date difference is a copy bug and fails.
   - A mismatch refuses `single_store_render_mismatch`, naming the session and the first differing line.

### 2.11 Idempotency and failure

- **Re-run after success.** `single_store_state.state = 'migrated'` and the store marker are set with equal stamps. The command prints "already migrated at `<time>` by `<build>`; backup `<dir>`", writes nothing, and exits 0.
- **Only one flag set, or stamps differ.** This cannot happen through this command, because the commit is atomic. If seen, it refuses `single_store_state_split`, prints both, and points at the backup.
- **Failure mid-run.** The refusals of 2.2 and 2.5-2.7 happen before any write. Anything after `BEGIN` rolls back both files. The backup already exists either way. `--dry-run` runs everything through verification, then rolls back and prints the report.

### 2.12 Report

The report prints, per project: the winner, the per-table counts, orphans kept, and whether the project was refused or skipped. It also prints the sample size and result of the render check, the number of sessions reset, the backup path, and `store.db` sizes before and after `VACUUM`. The transaction's report goes into `single_store_state.report_json` before commit. The returned report additionally contains the completed transaction/VACUUM timings and post-VACUUM size; the CLI prints those final measurements rather than starting another metadata write after commit.

## 3. Runtime after the migration

### 3.1 Connections and transactions

- **The seam.** `McStore` does not own `context.db`. The module opens it and installs a `ContextDomain` (`crates/mc-store/src/single_store_domain.rs`) on the store: `read` runs a callback in one read transaction, `write` runs one in one `BEGIN IMMEDIATE` and names the tables it writes so the module can fence them. `McStore` holds the SQL for the domain rows; the module's implementation (`ModuleContextDomain`, `crates/mc-module/src/single_store_reads.rs`) supplies the reader connection and the fenced writer below. Tests and tools use `SqliteContextDomain`, a plain two-connection implementation.
- **Writer.** The module keeps one writer connection to `context.db`: `HostStore`, opened with `open_with_fence` (`host_store:754`), 5 s busy timeout (`host_store:77`). Every write is one `BEGIN IMMEDIATE` transaction (`host_store:892`), as project memory #20181 requires for multi-process SQLite writers, with the in-transaction fingerprint recheck (`host_store:897`).
- **Reader.** It keeps one reader connection, the read half of `ModuleContextDomain` (slice B1's `ContextDomainReader` was never merged into this tree). A read that needs a consistent set (the revision heads with the rows they describe) runs in one read transaction, as `load_memory_render_snapshot` does today (`store:14776`).
- **`store.db`.** It keeps its own connection for cache rows only.
- **Busy.**
  - Transform passes only read `context.db`, and WAL readers do not wait on writers.
  - A historian publish that hits `SQLITE_BUSY` after the timeout stays pending and is retried (3.3).
  - A facade write answers with the existing busy error (`HostStoreError`, `host_store:209-280`) so the caller retries.
  - A write never waits longer than the host's own 5 s.
- **Lock order.** The module never holds a `context.db` write transaction while taking the `store.db` write lock, or the other way round. The copy-era reason for reading one file inside the other's write transaction (the cross-file head re-read) is gone (3.2).
- **Privilege bracket.** `with_privileged_transaction` keeps flipping `context_privilege_state` (`host_store:903-928`). Once `authority_managed` is empty the guard triggers never fire, so the flip is harmless. Bracket and triggers are removed together by the cleanup migration (4.2).

### 3.2 Noticing writes the module did not make

Other writers share `context.db`: TypeScript-mode sessions of the same project, the dashboard, the dreamer, the CLI. The module reads the same signals TypeScript reads for its own cache (`readCurrentM0SnapshotMarkersUncached`, `packages/plugin/src/hooks/magic-context/inject-compartments.ts:1496-1550`), so there is no new counter or receipt table:

| Change | Writers (evidence) | What the module reads in `context.db` | Pass effect |
|---|---|---|---|
| New memory | TS `ctx_memory`, dreamer, dashboard, module | `MAX(memories.id)` under the render-pool filter, same predicate as TS (`inject-compartments.ts:1244-1260`) | m1 addition at the next bust opportunity (unchanged rule) |
| Update, archive, merge, supersede, expire | `queueMemoryMutation` (`packages/plugin/src/features/magic-context/storage-memory-mutation-log.ts:66`) from `ctx_memory` (`packages/plugin/src/tools/ctx-memory/tools.ts:853`, `:1055`), dreamer (`dreamer/expire-memories.ts:186`, `dreamer/verify.ts:683`, `:693`), Pi `ctx_memory`; dashboard `queue_memory_mutation` (`packages/dashboard/src-tauri/src/db.rs:5525-5554`); module facade | `MAX(memory_mutation_log.id)` over the union | m1 `<memory-updates>` at the next bust opportunity |
| Metadata only (classification, verification, mural cue, counters) | dreamer, TS | nothing | Picked up at the next HARD, exactly as in TS mode (the TS markers ignore these too) |
| Project identity or workspace change | `migrate-session` (`packages/cli/src/commands/migrate-session.ts:473`), identity merge (`packages/plugin/src/features/magic-context/storage-identity-merge.ts:487`), workspaces (`packages/plugin/src/features/magic-context/workspaces.ts:361`) | `project_state.project_memory_epoch` and the workspace fingerprint (`workspaces.ts:299-312`) | eager HARD, through the existing lane (`transform:2917-2920`, `:2984-2986`) |
| User profile | dreamer, dashboard (`db.rs:5556`) | `project_state['__global__'].project_user_profile_version` | m1 delta (unchanged) |
| New compartment | module fold; TS historian in TS-mode passes | `MAX(compartments.sequence)` per session (`inject-compartments.ts:1230-1242`) | m1 delta (unchanged) |
| Compartment rewritten in place | TS recomp (`packages/plugin/src/hooks/magic-context/compartment-runner-recomp.ts:117-133`, logs at `:125`); module recomp, revert and rewrite | `MAX(m0_mutation_log.id)` per session, the TS `maxMutationId` marker (`packages/plugin/src/features/magic-context/storage-m0-mutation-log.ts:117`), skipping the module's own rows (below) | eager HARD |
| Notes | TS `ctx_note`, dashboard, dreamer | nothing | Notes are not a prefix input (`crates/mc-module/src/m1_compose.rs:60-62`) |

**Ready smart notes.** The module surfaces nothing for a ready note: not in m1 (since `d0edf4016d`), not in the tail, not as a reminder. It never had a caller for a delivery API, and that dead API is deleted. `context.db` has no `surfacing`/`surfaced` states; the migration lands module notes in those states as `ready` (2.6). In OpenCode Rust mode the TypeScript note nudger owns surfacing (`armNoteNudgeOnRustPublish`, `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:756`, then `onNoteTrigger`, with its per-session cooldown and trigger state in `context.db` `session_meta`). `a_ready_note_is_never_injected_and_defers_replay_while_it_stays_ready` pins the module side.

**Known parity gap:** Claude Code sessions driven directly by the module get no ready-note surfacing at all, and never had it. Closing it is a separate feature with its own cache rules.

How the values enter the revision:

- The memory head, mutation head, compartment head and profile version feed `in_session_revision` (`m1_compose.rs:63`) as they do now. They are read from `context.db` in one snapshot.
- `project_memory_epoch`, which used to arrive through state sync, and the session's `m0_mutation_log` head are read from `context.db` in the same snapshot and folded into the external revision next to the workspace fingerprint (`m1_revision_signal_parts_for_pass_timed`, `crates/mc-module/src/m1_compose.rs`). The profile version is read the same way, from `project_state['__global__']`.
- **The module's own `m0_mutation_log` rows.** The module appends a row whenever it rewrites a session's compartments, so TypeScript-mode readers of the session see the change. The module does not read those rows back: it stamps them `target_id = -1` (`MODULE_M0_MUTATION_TARGET`, `crates/mc-store/src/context_writes.rs`), and its head read skips them. It already handles its own rewrites through its boundary machinery, and counting them would force a HARD on the pass after every module recomp or revert. No reader uses `target_id` as a row reference; TypeScript compares only `MAX(id)`. A change there is already an eager HARD (`transform:2917-2919`), so both use a lane that exists. No new column is needed: `meta.m1_external_revision` stores the combined value.
- `commit_transform` (`store:10889`) keeps its `row_version` CAS on `mc_cache_state`. It stops re-reading domain heads inside the `store.db` transaction, because those tables are gone. That is sound because the revision it stores is the one the pass rendered from, read in one `context.db` snapshot. A write that lands after that snapshot shows up as a changed head on the next pass, which is pending work, exactly like a write that lands just after a commit today.

Blocker 3 of the synthesis (in-place compartment rewrites invisible to `MAX(sequence)`) is covered by `m0_mutation_log`, a mechanism TypeScript already uses, instead of a new trigger-maintained generation. The gap: every writer that deletes or rewrites existing compartments of a session must append an `m0_mutation_log` row in the same transaction. TS recomp does. The module's rewriters (`replace_compartments`, `reset_session_for_recomp`, `truncate_compartments_for_revert`, `store:12833`, `:12862`, `:12964`) must start doing so. Slice S2 also audits every TypeScript `DELETE FROM compartments` / `UPDATE compartments` writer and adds the row where it is missing. That is the smallest addition: a row in a table that exists, read by a marker TypeScript already compares.

### 3.3 The module's writes

- **Fold publish.** The historian's publish touches both files, because historian phase and coverage live in `mc_cache_state`:
  1. **`store.db` transaction.** It does the checks (row version, phase, revert epoch; `publish_historian_chunk`), writes `mc_compartment_dates`, records the `context.db` half as a tagged `PendingContextWrite` row in `mc_single_store_pending_publish`, and commits.
  2. **One `context.db` transaction** (`apply_pending_tx`, `crates/mc-store/src/context_writes.rs`). The fold's compartments are compared with what is stored at their sequences: an equal row is left alone, a different one is updated in place (keeping its id and so its chunk embeddings, synthesis blocker 5), and a missing one is inserted. The `m0_mutation_log` row is appended only when an existing sequence changed. Promoted facts dedupe on the project's active content. The side channels (events, primer candidates, user observations) are written only when the fold added or changed a compartment. When every compartment was already in place, the fold has been applied before, and writing them again would duplicate them.
  3. **`store.db`.** It deletes the pending row.
  4. **Crash between steps.** Every write for the session, the next pass and the module's start first finish a pending row: step 2 from the row, then step 3. A crash before step 2 committed replays the whole fold once. A crash after it replays nothing. Both windows are pinned by `a_fold_resumed_after_either_crash_window_lands_its_side_channels_exactly_once`.
- **Compartment rewriters** (`replace_compartments`, recomp reset, revert truncate, `append_compartments` at `store:13116`) use the same three steps with a tagged pending row.
- **Facade writes** (`ctx_memory` and `ctx_note` from direct callers such as Claude Code):
  - They use the context writer, not `mc_memories`/`mc_notes`.
  - The idempotency ledger stays in `store.db` (`mc_facade_mutation_ledger`; `with_facade_command`). A command with a recorded reply returns it without running again.
  - The ledger row cannot be written in the `context.db` transaction, so it is written after it. A process that stops between the two leaves the mutation applied and no ledger row. The retry runs the command again. That is safe only because of how each write is shaped, not because of the ledger:
    - inserts are idempotent on the natural key `(project_path, category, normalized_hash)`, so the retry finds the row and inserts no twin (`facade_mutation_command_crash_between_files_leaves_the_mutation_and_a_retry_does_not_duplicate_it`);
    - an update re-applies the same values and appends one more `memory_mutation_log` row with the same content, which the m1 render coalesces. A retry that lands after a later update by someone else would re-apply the older values; there is no receipt table to prevent that (synthesis blocker 4 stays open for this window);
    - an archive or merge retry finds its sources no longer active and answers "unavailable" instead of the original reply. Nothing is applied twice, but the caller sees an error for a command that did land.
  - A note update compares `updated_at` and `content` together, which closes the within-a-millisecond ABA the synthesis raised.
- **OpenCode Rust mode stops routing `ctx_memory` and `ctx_note` to the module.** The host's own TypeScript tools write `context.db` directly, as in TS mode, and the module sees those writes through 3.2. This removes the tool id translation completely.
- **Dreamer metadata routes** (`memory.set_classification`, `set_mural_cue`, `set_verification`, `set_mapping`, `module:13113-13121`) write the same columns in `context.db`, and `memory_verifications` for mappings, in one `BEGIN IMMEDIATE` each. The `MODULE` authority gate on them goes.

### 3.4 Ids

Every memory and note id the module renders, accepts or returns is a `context.db` row id. There is no translation layer:

- `rendered_memory_ids` are context ids;
- `host_row_id` and both id-map functions are gone;
- `memory_id_lane` and `note_id_lane` are removed. A caller that still sends `memory_id_lane: "host"` or a `note_id_map` gets `invalid_params`.
- A lookup by id always carries the project predicate (`WHERE id = ? AND project_path = ?`), so a foreign id reads as not found, as `load_owned_memory` (`crates/mc-module/src/memory_tool.rs:575`) answers today.

### 3.5 Which project a route reads

Memories and notes are keyed by the host's project identity (`git:<root commit>` or `dir:<hash>`). A route is bound to a filesystem root, and the table that mapped roots to identities (`mc_authority_route_bindings`) is dropped by migration 61. The module resolves a bound route's project (`route_project_identity`, `crates/mc-module/src/lib.rs`) as:

1. the `session_projects.project_path` the host recorded for the bound session in `context.db`, newest first; else
2. the identity of the route root, computed the way the host computes it (`crates/mc-module/src/project_identity.rs`, a port of `resolveProjectIdentity` / `resolveProjectIdentityForSession`, golden-tested against values the TypeScript functions printed); else
3. a refusal by name. A root with no computable identity never reads under a key nobody writes.

Claude Code sessions driven directly by the module have no `session_projects` row, so they take step 2. A facade write whose `memory_project` names another project is refused `facade_project_vocabulary_mismatch`.

### 3.6 The refusal on an unmigrated store

- **Code.** `single_store_migration_required`, a new constant next to `STORE_AHEAD_OF_BINARY_REFUSAL_REASON` (`store:3116`). User-facing code `MC-C14`, the next free one after `MC-C13` (`packages/plugin/src/shared/user-facing-codes.ts:207-212`).
- **Sentence.** "Magic Context's Rust mode needs a one-time migration of its store. Quit OpenCode and every ck-mc process, then run `magic-context doctor single-store migrate`. (MC-C14)"
- **Where it fires:**
  - In `McStore::open`, at module start (the store open after the subc handshake), before any row is read or written, when `store.db` is at 60 or lower and holds domain rows.
  - After open, when the module finds `single_store_state` missing or `required` while the store is marked.
  - When the two stamps differ, the same refusal is raised with code `single_store_state_split`.
  - It is held as a `StoreRefusal` variant (`module:415-470`) and answered on every lane except `echo`, exactly like store-ahead (`module:14809-14820`). Health reports `storage_state: open_refused_unmigrated`.
- **What the adapter shows.** The Rust-mode adapter reads `single_store_state` itself at session start.
  - On `required` it refuses the turn with the MC-C14 sentence, without calling the module.
  - It maps the module's `single_store_migration_required` frame to a new `SingleStoreMigrationRequiredError`, handled like `StoreAheadOfBinaryError` (`packages/plugin/src/hooks/magic-context/store-ahead-refusal.ts:37`, `:83`): not a module failure, no LKG replay, no parking, turn refused (`docs/architecture/rust-module.md:43`, `:61-66`). Facade tools reply with the sentence.
- **TypeScript mode.** It runs as before. The one exception is a project still listed in `authority_managed` on an unmigrated file: its memory and note writes would hit the guard triggers. `ctx_memory`, `ctx_note` and the dreamer then answer with the MC-C14 sentence instead of the trigger's error.

### 3.7 Canonical compartment boundaries and cold adoption

Both runtimes share one stored boundary representation:

- `start_message_id` and `end_message_id` are **raw host message IDs**, never module flat IDs.
- `start_block_index` and `end_block_index` are nullable integers. NULL means a whole-message boundary; a non-null index names the block within that raw message.
- The TypeScript historian writes raw IDs and NULL indices. Rust publication splits its internal `<mid>#<index>` coordinates before writing; Rust readers reconstruct those internal coordinates from the canonical columns. Recompaction staging and same-host session cloning preserve the indices.
- The offline engine splits copied module boundaries and normalizes flat IDs already present in `context.db`, inside the same atomic transaction. Its report includes `normalized_context_compartments`. Sessions whose existing boundaries were normalized receive an existing `m0_mutation_log` notification so a frozen TypeScript prefix rebuilds once.

A cold switch from TypeScript to Rust resolves whole-message boundaries against the host's immutable raw-message list. Missing starts or ends heal only from a contiguous neighbour (or the first raw message for an initial missing start), as in the prior TypeScript seed path. If no range is provable, the adapter refuses visibly with `context_compartment_boundary_unresolved`; it neither invents coverage nor serves a last-known-good prefix over an unproven boundary.

Only boundary coordinates and date labels travel in `resolved_compartment_boundaries` metadata: no summaries, facts, memories, or notes. The module checks the source coordinates against the shared row and persists the read-coordinate cache in existing session metadata. Cached coordinates apply only while the original raw IDs, block indices, and ordinals still match. The inventory reports whether this cache remains valid, avoiding a new raw-history scan on a warm seed. Restart does not discard it. This is a cache, not another authoritative compartment table.

TypeScript conservatively keeps a message raw whenever its covered end has a non-null block index; it never drops the uncovered blocks. Both direct-ID and immutable-source-order trimming obey this rule. Whole-message native compaction markers cannot represent partial ends and must not advance over them. OpenCode 2's module-boundary record instead trims only before the nearest user turn, retaining that turn and its partial boundary message. Pi retains the prefix at a partial boundary rather than letting its split-tool orphan cleanup discard an uncovered suffix. This can duplicate covered content, but cannot lose uncovered content.

Other consumers: `ctx_expand` uses ordinal ranges and can safely return the whole boundary message; dates now resolve by canonical raw IDs; same-host cloning and recompaction retain indices. Dashboard readers display summaries and inclusive ordinal spans, not permission to discard raw messages. Cross-host OpenCode-to-Pi conversion refuses indexed boundaries before staging or journalling because its current entry map cannot faithfully translate partial blocks; TypeScript recompaction to whole-message boundaries is required first.

## 4. What gets deleted

### 4.1 Rust

- **`crates/mc-store/src/lib.rs`:**
  - every method of 1.2's store list (authority, seed, drain, changefeed, identity acknowledgement, host/module id maps);
  - the `mc_*` domain readers and writers, replaced by the context seam;
  - `apply_state_sync`'s domain half (seed compartments, memory and mutation replacement, user profile, workspace; `store:11357+`, including `replace_workspace_tx` `store:17880`, `replace_authority_user_profile_tx` `store:18193`);
  - `commit_state_import`'s compartment insert (`store:10773`);
  - `normalize_authority_route_tx` (`store:3197`);
  - the facade-authority scope as runtime state (`facade_authority_scope`). The UDF registrations at `store:7788-7831` stay, because stores below v53 still run migrations whose triggers call them (comment at `store:7788-7790`);
  - `read_single_store_marker`'s "not capable" branch (`store:7864-7872`);
  - `SingleStoreMarker::remediation`'s build-mismatch text.
- **Store tables dropped by migration 61:** the moved tables (2.9), `mc_changefeed`, `mc_authority`, `mc_authority_seed_rows`, `mc_authority_pending_memory_references`, `mc_authority_route_bindings`, `mc_memory_visibility_epoch`, `shadow_memories`, `shadow_memory_mutation_log`, `shadow_user_profile`, and every trigger on those tables. The `facade_authority_domain`, `facade_authority_route` and `note_caller_project` columns of `mc_privilege_state` are left in place: nothing reads them once the triggers that used them are gone, and leaving them avoids a table rebuild of the row the marker lives in.
- **`crates/mc-module/src/lib.rs`:**
  - the routes and handlers of 1.2 (`module:14826-14842`, `:9372-9750`);
  - `MemoryIdLane`, `memory_id_lane`, `host_memory_ids`, `NoteIdSpace`, `rendered_note_id` (`module:17975-18457`);
  - the `session.status` compartment page;
  - the `single_store` mode admission (`module:5481-5485`).
- **`crates/mc-module/src/host_store.rs`:** `SingleStoreMode` (`host_store:151-199`), the shadow report and comparison (`:1753-1945`), `shadow_publish` (`:2024`), the mode switch `set_mode`/`mode`/`admit_mode` (`:2105-2134`), `shadow_scratch_dir`, `last_shadow_summary` and the mode-refusal record (`:2175-2233`), `ModePublish` and `apply_publish_for_mode` (`:2284-2301+`). `status_value` (`:2234`) keeps only the writer's fence and table health. The writer, fence, fingerprints and `resolve_context_db_path` (`:2135`) stay.
- **`crates/mc-module/src/historian.rs:1025-1034`:** the shadow call becomes the real publish.
- **Tests:**
  - `crates/mc-module/tests/single_store_apply.rs`, `single_store_off_opens_nothing.rs`, `single_store_pins.rs` (shadow-mode pins);
  - every `mc-store` and `mc-module` unit test that drives `authority_*`, `pull_changefeed`, `seed_authority_row(s)`, `acknowledge_host_memory_ids` or the id lanes;
  - the B0 gate tests that assert marker tripwires (`crates/mc-module/src/tests/gate_a1_b0.rs` marker cases).

### 4.2 TypeScript and `context.db`

- **Deleted files:**
  - `packages/plugin/src/features/magic-context/context-authority.ts`, except `getContextStoreUuid`/`ensureContextStoreUuid` (`authority-ts:159-180`), which move to a small module;
  - `packages/plugin/src/plugin/memory-id-translation.ts`;
  - `packages/plugin/src/plugin/rust-note-backend.ts`;
  - `packages/plugin/src/features/magic-context/memory/mirror-reembed.ts`.
- **Edited:**
  - `rmt`: remove `prepareRustMemoryAuthority` and the mirror block (`rmt:1340-1501`, `:4073-4157`), and keep `drainSingleStoreEmbeddingWatermarks` as its own per-pass step;
  - `module-state-sync.ts`: remove the domain fields and compartment mirror (1.2);
  - `module-tool-backends.ts`: remove the memory and note routing;
  - `packages/plugin/src/hooks/magic-context/transform.ts:405-545`: remove the authority recovery;
  - `dream-timer.ts:702-706` and `rpc-handlers.ts:803-811`;
  - the transport and wire methods for the deleted routes (`module-transport.ts:875` and its siblings, `module-client.ts:37`).
- **CLI:** `doctor drain-authority` and the authority report in `packages/cli/src/commands/doctor-authority.ts`.
- **`context.db` rows cleared by the migration (2.4 step 5):** `authority_managed`, `authority_repair_pending`, `authority_capture_bounds`, `mirror_identity`, `mirror_cursors`, `mirror_pending_references`, `mirror_note_revisions`, `mirror_live_memory_rows`, `mirror_live_staging`, `mirror_resnapshot_state`, `domain_mutation_epoch`.
- **`context.db` tables and guard triggers dropped by a cleanup migration in the next release**, not in v92. Dropping them in v92 would run on plugin start, before the copy that still reads `mirror_identity`. They are the tables above, `context_privilege_state` and the `*_authority_guard_*` triggers (`migrations:2216-2550`), together with the module's privilege bracket.
- **Tests:**
  - `packages/plugin/src/features/magic-context/context-authority.test.ts`, `completed-authority-recovery.test.ts`, `storage-notes-authority-heal.test.ts`, `storage-notes-authority-heal-gate.test.ts`, `memory/mirror-reembed.test.ts`;
  - `packages/plugin/src/hooks/magic-context/transform-authority-flip-back.test.ts`, `transform-completed-authority.test.ts`;
  - the mirror and domain cases of `module-state-sync.test.ts`;
  - `packages/plugin/src/plugin/memory-id-translation.test.ts`, `rust-note-backend.test.ts`;
  - `packages/e2e-tests/tests/rust-memory-mirror-resume.test.ts`, `dreamer-authority-preflight.test.ts`, `dreamer-verify-slice-authority.test.ts`;
  - `packages/plugin/scripts/repair-mirror-created-at.test.ts` and its script;
  - the drain cases of `packages/cli/src/commands/doctor-authority.test.ts`.

## 5. Test plan

Each test names what goes red when the mechanism is wrong. The failures a test exists to catch are silent (a wrong winner, a dropped reference, a SOFT that should have been a HARD), so each gets a mutation proof: break the mechanism, name the test that reddens.

### 5.1 Step-through migration test (project memory #14597)

A `ck-mc single-store-migrate` fixture builds `store.db` through the real chain to 60 and `context.db` through the real chain to 92, then populates both:

- a store-wins project with twins found each way (identity row, seeded id, natural key);
- a context-wins project with a store-only memory and a differing twin;
- supersede chains and `merged_from` across store-only rows;
- notes in the module-only `surfacing`/`surfaced` states, which `context.db` does not have, so they arrive as `ready` (see 3.2, Ready smart notes);
- compartments where context has a stale copy and extra sequences;
- context-only events (unchanged, superseded, orphan) and candidates;
- mappings, including a null array.

It runs the engine and asserts each table afterwards.

| Assertion | Reddens when |
|---|---|
| store-wins twin holds store content, context-wins twin holds context content | the winner rule is inverted or ignores `authority_managed` |
| `superseded_by_memory_id` and `merged_from` name the new ids | references are not remapped, or are remapped out of order |
| orphan event kept and counted; superseded event deleted; unchanged kept | fates are merged or orphans are treated as unknown |
| compartment ids of updated sequences unchanged | compartments are replaced instead of updated in place |
| `store.db` at 61 with the marker and stamps equal to `single_store_state` | flags written separately or not at all |
| every `mc_cache_state` row has `project_memory_epoch_pending` and zeroed ids | cache reset skipped |

Mutation proofs: invert the winner rule; skip the `merged_from` remap; classify `Orphan` as `Unknown`; update compartments by delete-and-insert. Each must redden only its row above.

Refusal cases, each asserting that **both files are unchanged** (a logical dump digest of every table plus both version rows, compared before and after):

- `authority_in_transition`, `foreign_context`, `unclassified_rows`, `dangling_reference`, `claude_code_ids`;
- a render mismatch planted by corrupting one copied compartment through a test hook between copy and verification;
- an injected error after the copy.

### 5.2 Real-store drill on a scrubbed copy

Specimen: `~/.local/share/cortexkit/magic-context/specimens/b2-pair-20260927/`, the pre-move pair slice A drilled (`context.db` v91, 6.9 GB; `store.db` v60, 956 MB). For this document it was read only with `mode=ro&immutable=1`.

- It contains 6,285 store memories over 10 projects; 1,697 notes; 14,350 compartments over 111 sessions; 1,257 cache rows; 5 `authority_managed` projects.
- `mc_authority` names 5 `MODULE` projects and 1 `TS` project under this file's uuid, and 2 `MODULE` projects under a foreign uuid.
- 4,092 store memories have no `host_row_id`.

The drill copies the pair (scrubbed of message content if it is not already) to `$TMPDIR/magic-context/<task>/<root>/cortexkit/magic-context/` (the layout 2.3's path rule requires) and runs the doctor against it with `MAGIC_CONTEXT_STORAGE_DIR` and `XDG_DATA_HOME` set to that root. It never touches the live stores. The specimen's `context.db` carries `memories.content_version`, a column from an old development build; the engine refuses on it and names the `ALTER TABLE memories DROP COLUMN content_version;` to run first. The runtime half is the ignored test `single_store_drill` (`crates/mc-module/src/tests/single_store_drill.rs`), pointed at the migrated copy with `MC_DRILL_DIR` and `MC_DRILL_PROJECT`. It never touches the live stores. It must:

- first refuse `single_store_foreign_context` for the two foreign projects;
- pass with `--skip-foreign`;
- print a render-check sample of every recently active session;
- record the wall time of the transaction and of `VACUUM`;
- on a re-run, report "already migrated".

### 5.3 The refusal

- A new `ck-mc` on an unmigrated populated store answers every lane except `echo` with `single_store_migration_required`, and the store still has all its rows and version 60.
  - Mutation: remove the pre-migration check in `McStore::open`, so 61 auto-applies. The test reddens on the row-count assertion (the drop happened).
- An empty store gets 61 and flips `single_store_state` with equal stamps.
- Stamps that differ give `single_store_state_split`.
- On the plugin side, a Rust-mode session on a `required` file refuses the turn with MC-C14 and sends no transform request (the transport records none).

### 5.4 Fleet-shaped end to end

Setup: an isolated root with a fixture pair (store v60, context v91), warmed by real Rust-mode passes before the migration. Then `doctor single-store migrate`. Then, for one **TS host** session (the OpenCode plugin in Rust mode) and one **Rust host** session (the Claude Code serializer calling the module directly):

- the first pass is served by the module (`mc_pass_trace` advanced, no LKG replay logged) with plan `Hard` and `materialize_reason = "project_memory_epoch"`;
- the next three passes are defers, served by the module, with byte-identical prefixes through m1 (the four-defer replay shape of `packages/e2e-tests/scripts/pure-replay-differential.ts`).

This is not the vacuous "first pass is a hit". The reason is asserted, and so is the module serving.

Mutations:

- drop the cache reset: the first pass is not `Hard`, and the reason assertion reddens;
- leave `rendered_memory_ids` in store space for the Claude Code session: its `ctx_search` exclusion test reddens.

Plus two cross-writer checks on the migrated root:

- A TS-mode session writes a memory update through `ctx_memory` (a `memory_mutation_log` row). The Rust session's next priced pass is a `Soft` carrying the new content in `<memory-updates>`. Mutation: stop reading the mutation head; this test reddens.
- A TS recomp on a Rust session writes an `m0_mutation_log` row. The next Rust pass is `Hard`. Mutation: drop the m0 mutation head from the external revision; this test reddens.

### 5.5 Render-equivalence check

These are unit tests of the comparator itself:

- a pair differing only in memory ids and in-category order passes;
- a pair differing in one memory's content fails;
- a pair differing in one compartment's date segment fails.

Mutation: masking content along with ids makes the second test pass. That is the red we want to see when the comparator is too loose.

## 6. Slices

Four slices, with disjoint files. Every slice is gated on its own branch and merged into one integration branch. Everything lands on master together in one restart window: the fence movers merge, then `bun run build:dists`, then every host restarts, as one step (`docs/architecture/storage.md:46`).

| Slice | Files | Gate | Depends on |
|---|---|---|---|
| **S1: migration engine** (Rust) | new `crates/mc-module/src/single_store_migrate.rs` (port from `ssm`, minus the online parts), `crates/mc-module/src/single_store_migrate_tests.rs`, `crates/mc-module/src/main.rs` (subcommand), new `crates/mc-store/src/single_store_schema.rs` (migration 61 statement constants, legacy read-only source reader) | `cargo test -p mc-module single_store_migrate` (5.1 with mutation proofs); the 5.2 drill | S2's reader seam, for the render check only; everything else stands alone |
| **S2: module runtime on `context.db`, and the refusal** (Rust) | `crates/mc-store/src/lib.rs` (migration 61 wired into `MIGRATIONS`, open check, refusal, deletions of 4.1, the context domain seam), `crates/mc-store/src/single_store_domain.rs`, `crates/mc-module/src/{lib.rs, host_store.rs, single_store_reads.rs, transform.rs, m0_compose.rs, m1_compose.rs, memory_tool.rs, historian.rs, historian_chunk.rs}`, the Rust test files of 4.1 | `cargo check`/`test -p mc-store` and `-p mc-module` (one workspace build at a time); 5.3 Rust half; the Rust half of 5.4's cross-writer checks | S1's `single_store_schema.rs` constants (a small, early merge) |
| **S3: TS adapter cleanup and mirror deletion** (TS) | the TypeScript files of 4.2 except CLI; new `packages/plugin/src/hooks/magic-context/single-store-refusal.ts`; `packages/plugin/src/shared/user-facing-codes.ts` (MC-C14); the recomp-style `m0_mutation_log` rows added to any TS compartment rewriter missing one | `bun run typecheck` (tsc) for the plugin; `bun test` for the touched suites; 5.3 plugin half | the S2 wire contract (error code, removed routes) |
| **S4: doctor command and `context.db` v92** (TS) | `packages/plugin/src/features/magic-context/migrations.ts` (v92), `storage-db.ts:109`, new `migrations-v92.test.ts`, `schema-version-fence.test.ts`, one-behind fixtures; new `packages/cli/src/commands/doctor-single-store.ts` and its test (preflight with a fake `lsof` naming a PID, `lsof` failure refuses, disk check); `packages/cli/src/index.ts`, `packages/cli/src/lib/cli-help.ts`; the drain half of `doctor-authority.ts` | tsc for plugin and CLI; `bun test` for migrations and CLI; 5.4 end to end | S1's CLI flags and report JSON |

Merge order into the integration branch:

1. S1's schema constants.
2. S2 and S1, which carry the Rust fence movers: store 61 and `BUILT_CONTEXT_FENCE_VERSION` 92.
3. S4, which carries the TS fence mover: `LATEST_SUPPORTED_VERSION` 92.
4. S3.

The ordinal-checkpoint branch rebases onto the result as v93. Then 5.2 and 5.4 run on the integration branch, and it merges to master, followed by `build:dists` and a restart of every host. No slice merges to master alone: a plugin at v92 without the engine, or an engine without the runtime, strands Rust-mode users.

## 7. Choices made here that the owner may want to overrule

- `--prefer`, `--skip-foreign` and `--accept-id-change` exist so a refused project can move by an explicit operator choice instead of a guess. The drill specimen needs `--skip-foreign`.
- The pre-v0.44.0 `ck-mc` limit (2.9) is accepted, not fenced.
- `context.db` mirror tables are emptied now and dropped one release later.
- OpenCode Rust mode's `ctx_memory`/`ctx_note` run the TypeScript tools directly (3.3).

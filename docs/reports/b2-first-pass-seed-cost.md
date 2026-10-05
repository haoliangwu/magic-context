# First Rust-mode seed cost after the single-store migration

## Reproduction

Measured on 2026-09-30 with Bun 1.4.2 using direct
`buildModuleStateSyncPayload` calls, fresh sender state, `force: true`, and
inventory `{ boundaryId: null, contextBoundariesResolved: false }`. APFS `cp -c`
cloned context.db (7.0 GiB), opencode.db (32 GiB), and their WAL/SHM files into
`$TMPDIR/magic-context/seed-cost/pool-1193/`. Free space was 188 GiB before
cloning, above the required 20 GiB reserve. OpenCode was opened read-only;
context writes, profiles and payload captures stayed in throwaway roots.
`lsof` confirmed profilers and isolated modules never opened a live store.
The incident log was read in place, not copied.

The five largest sessions by tag count were joined through `session_projects`
and the cloned OpenCode session directory to identify their fleet projects:

| Project / session | Tags | Before CPU-profiled ms | Final CPU-profiled ms | Final ordinary ms | Raw messages before → after |
| --- | ---: | ---: | ---: | ---: | ---: |
| MC / `ses_331acff95fferWZOYF1pG0cjOn` | 195228 | 367309.6 | 3040.7 | 589.4 | 147367 → 416 |
| AFT / `ses_313660571ffeZTsf4koSJwk50Q` | 148121 | 285963.6 | 4457.9 | 526.6 | 134427 → 460 |
| ALF / `ses_227ce5788ffeRPA9THoPLOQreO` | 121956 | 307399.8 | 4351.0 | 500.5 | 122381 → 654 |
| SUBC / `ses_12a4fa38dffe81Fz7Y2AsWb5Cg` | 95582 | 2634.8 | 1354.7 | 170.6 | 83939 → 1172 |
| BROCA / `ses_114f158ccffet7znXAgI7lc3Kp` | 61783 | 39902.6 | 1390.5 | 264.1 | 50574 → 1832 |

Times measure assembly, not startup or writing captured JSON. Two independent
baseline processes ran concurrently; each final profile ran sequentially.
These are snapshot measurements, not extrapolations from the incident's
134431-message count. `--cpu-prof` materially changes native SQLite timings on
this machine: the final identical AFT/ALF calls took 4.46/4.35 seconds with it
and 0.53/0.50 seconds without it. Earlier profiled runs ranged from 0.67 seconds
to 6.81 seconds for AFT. Therefore the ordinary wall times and separate real
module RPC measurements establish the budget, not a cherry-picked profile.
**The complete ordinary AFT payload is below two seconds.**

## Measured cause and fix

The dominant cost was **not canonical JSON or block mapping**. In the combined
AFT/ALF baseline CPU profile, native SQLite `get` self-time was 537567 ms;
536751 ms was under `readRawSessionMessageOrdinalByIdFromDb → endpoint`.
Resolving each compartment's two endpoints rescanned session history. SQLite
`all` self-time was 51068 ms, including 46942 ms in the unbounded raw seed-tail
query and 3505 ms in dropped-tag collection. JSON parsing contributed 2957 ms;
canonical JSON and block mapping contributed only 51 ms and 45 ms. The other
baseline profile attributed 376222 ms to endpoint ordinal scans.

The fix reads the ordinal map once per boundary resolution, without a redundant
JSON-based ordinal-count scan, and caches endpoint parts by message ID. With no
module boundary, seed eligibility falls back to the persisted OpenCode
compaction marker's **boundary message**, not its later summary target; the
marker row remains included. Hidden host seeds are excluded without independently
authorizing removal of the module's cached prefix. Block mappings are reused
per owner; canonical drop JSON is computed once per candidate.

Scoped dropped-tag reads now use separate, disjoint tool/message queries with
explicit owner/address indexes and a bounded JSON-set input. This avoids scanning
AFT's 141352 historical dropped tags. The live query's actual `EXPLAIN QUERY PLAN`
is asserted in a regression test: SQLite otherwise prefers a session-wide index
to satisfy ordering, even when the eligibility list is small. No new indexes or
schema changes are needed.

Final CPU-profile self-time totals across all five sessions: ordinal-map reads
6799 ms, endpoint parts reads 3545 ms, bounded raw tails 2556 ms, shared boundary
rows 561 ms, endpoint metadata 373 ms, JSON parsing 215 ms, and scoped dropped-tag
reads 74 ms. No per-endpoint ordinal-count scan remains. Ordinary execution no
longer takes minutes; chunk yielding was unnecessary after removing repeated work.

## Payload equality and the boundary rejection found by real RPC

All post-boundary drop, pending-drop, hint, strip and note-anchor seeds were
canonical-JSON identical, including order, for all five sessions. AFT/ALF have
no eligible drops in this snapshot; MC/SUBC/BROCA have respectively 37/606/1692
drops, 284/410/110 pending drops and 68/228/419 hints. Watermarks, module trim
boundaries, todo state, emergency state and pending compaction markers match.

A real isolated module probe then exposed an existing AFT/ALF rejection:
`state_sync_seed_boundary_mismatch: invalid host-resolved context boundary`.
The original AFT payload reproduced it. Installed `ck-mc --version` reported
`ffff1f3ad653b972069760839e51cb1227a8ab3f`; this was not a stale-binary conclusion.
The parent authorized a separate boundary fix after the performance commit.

The problematic rows have an empty legacy start ID and nullable start block:
AFT sequences 1676, 1682 and 1831, and ALF sequence 1523. Neighboring endpoints
already prove their canonical ordinal range, but the host previously serialized
`#0`, which is not a valid flat address. The resolver now obtains the actual
message at the inferred ordinal. Rust permits this substitution **only when the
source ID is empty and its block index is absent**. Nonempty source IDs and
explicit block indices remain strict. The raw row's empty source identity stays
in the cache fingerprint; neither shared IDs nor source ordinals are rewritten.
Later source repairs invalidate cached coordinates. Partial end indices remain
unchanged. Only those four resolved start IDs and their date labels change;
all other resolved boundary fields remain equal to the original payload.

## Final real first-pass RPC and replay proof

Built the modified worktree module with
`cargo build --locked -j 2 -p mc-module --bin ck-mc`. A fresh second APFS clone
backed an isolated ck-subc/module pair, with historian production disabled and
teardown in finally. `lsof` again showed only throwaway stores. All five large
sessions started with null module boundaries and **acked** their forced sync:

| Project | Boundary resolver ms | Inventory RPC ms | Whole forced sync ms | Result |
| --- | ---: | ---: | ---: | --- |
| AFT | 417.2 | 279.8 | 1699.0 | acked |
| ALF | 340.9 | 169.3 | 1573.8 | acked |
| MC | 364.5 | 284.7 | 1804.5 | acked |
| SUBC | 1.1 | 41.6 | 204.2 | acked |
| BROCA | 113.4 | 58.8 | 683.3 | acked |

Local persisted Todo reads were 0.02–0.04 ms. The host SDK Todo RPC was not
benchmarked: no OpenCode service was started, so that external latency is not
claimed here. The measured inventory, boundary work and full forced sync show
no second minutes-long assembly stage.

A real module synthetic fixture with an empty legacy start, nullable index and
partial end acked its seed. Its bootstrap was HARD (`first_render`), followed
by SOFT (`m1_delta`) and SOFT+ defer. The SOFT and following defer served exactly
67393 identical bytes, SHA-256
`4e518d6787513b5f10527f930fbd0792b7f20fd14e321d66380d46b8efdda797`.
Initial direct raw-tail transform experiments on the historical clones returned
stable PASSTHROUGH, not a managed defer; those incomplete host-wire fixtures are
not counted as defer proof. The synthetic managed fixture and replay gates are.

## Gates and guard evidence

Plugin typecheck and full lint passed. A pre-existing formatter error in
`scripts/self-tag-trial/host-plugin.mjs` was fixed in a separate, parent-authorized
format-only commit. The final seed/boundary tests passed (32 tests); the complete final
seed/boundary/Rust-mode/prefix replay gate passed (180 tests). All 175 mc-store
tests passed. Pure replay differential
against the staged implementation returned `RESULT IDENTICAL defer_passes=4`.

Synthetic guards cover 100000 messages/tags with a null inventory (two eligible
messages, one raw query, assembly below 2000 ms), 2000 legacy compartments over
100000 messages (one ordinal basis, two endpoint reads), and the actual scoped
SQL plan over 100000 dropped tags. Forced assembly emits
`rust.state_sync_detail phase=seed` in finally before transport, including
assembly failures; full-pass timing remains in its existing finally block.

Safe stage/mutate/restore controls all reddened their intended guard:

- Removing the host-marker fallback: only the cold 100K-message test failed;
  27 others passed.
- Restoring per-endpoint ordinal scans: only the large legacy compartment test
  failed (4000 ordinal reads instead of 1); four others passed.
- Allowing replacement of known unindexed source IDs: the exact Rust source-ID
  validation test failed; 174 unrelated tests were filtered, not claimed as run.
- Removing the message-address index hint: only the scoped SQL-plan test failed;
  23 others passed. The returned seed array was still empty, demonstrating why
  checking the query plan itself matters.

Every mutant had a nonempty working diff and an empty working diff after restore.
No mutation marker, live-store copy, profile, raw payload or build artifact is
committed. Deploy both the plugin and rebuilt module: the previously installed
module still rejects the empty-source boundaries.

# Entry projection and mural refresh costs

## Changes

LKG (last-known-good) snapshots preserve a successfully served request for safe replay. A HARD opportunity is a pass that may rebuild the injected history prefix and replace its mural image; other passes replay the frozen image.

- Rust-mode transforms no longer build the unused TypeScript LKG entry projection. The Rust adapter captures its own pristine input and returns before TypeScript capture.
- TypeScript entry projection retains exact typed content tokens and immutable digests in a transform-local, session-keyed LRU. It uses `exactReusablePrefix`, not ids or a probabilistic signature alone. Only the first changed entry and its successors are SHA-256 hashed. Snapshots are made before tagging or heuristics mutate the host graph. Retention is limited to 16 sessions and an estimated 64 MiB of token storage; oversized inputs fall back to full hashing on the next pass. There is no persistent cache.
- Mural layout planning is separated from rasterization and PNG encoding without changing any layout, drawing, encoding, or hash rules. A cold stored-image match now needs layout only. Warm refreshes still check coverage and resolve the overflow pool, then compare the exact ordered entries before layout. The database-owned weak cache retains at most 16 projects and an estimated 16 MiB, including serialized entry keys, PNG bytes and data URLs. Stored hash, dimensions and PNG bytes are also checked before reuse, so another writer cannot silently replace the stored artifact behind this cache.
- The refresh predicate is unchanged. Commit `9b3968653d18766441ce7c101a79fb5781094592` replaced authority-mirror versions with host-visible HARD opportunities; pressure at the threshold deliberately over-approximates those opportunities while the module freezes non-materializing output. Removing that refresh would risk missing a changed pool on a materializing pass. Making its unchanged-pool work cheap preserves the original purpose.
- No schema, migration, fence, or wire-format changes.

## Copy-only profiling

Live stores were read only by `cp -c` (APFS copy-on-write cloning), including their write-ahead-log sidecars, into:

`$TMPDIR/magic-context/per-pass-profile/{mc,oc}` (`mc` contains Magic Context stores; `oc` contains the OpenCode message store)

No live database was opened. The log override pointed inside the same temporary root. The two copied sessions were AFT (`ses_313660571ffeZTsf4koSJwk50Q`) and the TypeScript BROCA session (`ses_114f158ccffet7znXAgI7lc3Kp`). The probe reads the recorded session/project binding and cuts history at the latest completed OpenCode compaction summary. This yielded 2,025 and 2,925 visible messages, respectively. Budget was held at 4,000 tokens; resolved overflow pools contained 1,114 and 598 entries.

Run the same isolated stage-equivalent probe before/after:

```sh
ROOT="$TMPDIR/magic-context/per-pass-profile"
bun packages/plugin/scripts/profile-per-pass-costs.ts "$ROOT" \
  ses_313660571ffeZTsf4koSJwk50Q ses_114f158ccffet7znXAgI7lc3Kp
PERF_OPTIMIZED=1 bun packages/plugin/scripts/profile-per-pass-costs.ts "$ROOT" \
  ses_313660571ffeZTsf4koSJwk50Q ses_114f158ccffet7znXAgI7lc3Kp
```

The baseline branch reproduces the previous full-render-before-stored-compare operation. Each process performs six passes; the table uses the mean of passes 1–5, excluding cold initialization. Both runs use freshly cloned message graphs, the same cloned database and the same phase measurements. These are isolated costs, not whole transforms or module round trips; shared-machine contention affects absolute numbers. Rust's omitted entry stage is measured as an empty projection branch, not a Rust-module benchmark. BROCA's mural numbers are a render microbenchmark, not a claim that its TS pass emits the Rust timing stage.

| Operation (ms) | AFT before | AFT after | BROCA before | BROCA after |
|---|---:|---:|---:|---:|
| TS entry projection (including exact prefix comparison after optimization) | 293.15 | 17.93 | 497.07 | 25.75 |
| Rust entry projection branch | 293.15 | 0.0035 | — | — |
| Whole mural refresh | 229.68 | 30.58 | 431.33 | 25.74 |
| Coverage, separately sampled | 6.46 | 7.09 | 3.27 | 3.25 |
| Pool resolution, separately sampled | 34.84 | 21.88 | 15.73 | 20.74 |
| Full recompute layout, separately sampled | 42.36 | 35.46 | 20.07 | 25.51 |
| Full recompute raster, separately sampled | 1.55 | 1.50 | 1.39 | 3.54 |
| Full recompute PNG encode, separately sampled | 181.50 | 172.86 | 183.16 | 169.38 |
| Stored PNG base64, separately sampled | 0.0122 | 0.0115 | 0.0171 | 0.0121 |

Phase samples are separate calls and need not sum to the whole refresh. The unchanged optimized refresh does not execute layout, raster, encoding or base64 conversion. PNG encoding, rather than base64, was the largest render cost in these samples. Coverage and pool resolution remain proportional to the memory pool.

Raw measurements remain under the throwaway root in `before-paired.jsonl` and `after-paired.jsonl`. The script asserts every optimized LKG digest against a full pristine recompute and each mural data URL/text hash against full rendering. Before/after digests and PNG hashes were identical on every measured pass:

| Session | SHA-256 of digest array | PNG SHA-256 | Layout text SHA-256 |
|---|---|---|---|
| AFT | `a1073c3217e40dfa682d3cb77154f5fbe03038fc5a72596950843363a894520c` | `7da4c9e6c3e666bdc0ff36f2de1a5d190105cf9787269682ac5be45f8448f63f` | `f1b2bd3d29e9579b8b223045734e0c3d7a31ff03ec75226dbfaddb3fdb1663f4` |
| BROCA | `d089dc88158cc861e4d9c594b48000c5629cbcc95a5a4c8bd23d7eb2faabe061` | `7f399d09cd1c8164926a0c42a5611a7b59f1584c9233d9ff5367121d9889344f` | `ae28abd174459654ea150ef41cbce6f0dbb7aa0105848bd07419b5e2a2a46ca3` |

## Regression controls

Tests compare optimized results to full recomputation using long text, Unicode, nested completed-tool payloads, actual database memories and cues. Separate cases cover appended input, same-id edits, reordered messages, session isolation, added memory, cue edits, budget edits, stale cues and a non-vision gate. Existing Rust adapter tests additionally cover vision revocation on the same model and repeated HARD opportunities.

Safe staged mutations proved the tests fail: full prefix hashing, restoring render-before-compare, a constant mural input key, projecting Rust input again, and bypassing the vision gate. Each control was restored from the index before normal checks. Full prefix hashing failed only `entry projector hashes only the new tail while matching pristine full digests` (121 hashes instead of one). Restoring render-before-compare failed only `unchanged mural skips layout raster and PNG while preserving full wire bytes` (one layout instead of zero). Constant-key controls independently failed each `mural cache matches full wire after ...` case at the data-URL equality assertion. Reintroducing Rust projection failed `skips TypeScript entry projection in Rust mode`; bypassing model capability failed `mural cache cannot bypass the nonvision model gate`.

The existing HARD-opportunity regression formerly asserted five full renders. It now asserts five pool resolutions and one raster/PNG render, preserving its pool-recheck and stored-artifact claims while removing the redundant-work requirement.

`bun run typecheck` and `bun run lint` passed. The complete plugin suite had 6,307 passes, four skips and four unrelated timing failures (SSRF deadline, two async storage boot checks, and non-git git-log smoke). All 95 tests in those three untouched suites passed when rerun in isolation. Those failures exercise DNS/HTTP wall-clock deadlines, database subprocess boot timing, and git subprocess completion, not entry projection or mural rendering. No unrelated test contracts were changed. The final focused LKG/mural/Rust-adapter run passed all 203 tests; the workspace build also passed.

# Tokenizer calibration Phase A verification

This is an execution record, not a declaration that the full Phase A inventory is complete. Outstanding implementation limitations remain explicitly listed in root and package `PARITY.md`. Release notes are drafted in `.cortexkit/alfonso/release-notes/v0.42.8.md`.

## Pinned revisions and isolation

- Master: `7486664df07096385e3a5985427b335a221a2bd2`.
- Runtime candidate: `6eddf386937058ffcde18b88179c3bb987d517f0`.
- Every host comparison used fresh throwaway HOME/XDG roots, synthetic prompts, the existing OpenCode mock-provider capture and no paid completion, live database, private prompt dump or credentials.
- Both extracted refs use one throwaway project path so system/tool comparisons do not conceal different working-directory prompts. The instrument is held constant; application code comes from each pinned ref.

## Gate: matching wire captures and seeded consecutive defers

Executed:

```sh
root=$(mktemp -d "$PWD/.calibration-replay.XXXXXX")
HOME="$root" XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" \
XDG_CACHE_HOME="$root/cache" XDG_STATE_HOME="$root/state" \
bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only \
7486664df07096385e3a5985427b335a221a2bd2 \
6eddf386937058ffcde18b88179c3bb987d517f0
```

The owned throwaway root was removed after the command. Result: **IDENTICAL, four corresponding captured requests**. The original decision labels came from the persisted decision ledger. The later priced gate strengthens this: it reads current per-request scheduler observations, establishes a nonempty cached generation and verifies four actual defers including restart. The comparator uses the existing serializer for captured messages/system/tools, not a new provider serializer.

| Pass | Message bytes | Messages SHA-256, equal on both refs |
|---|---:|---|
| 1 | 262 | `165aed197ad1aa46c0684bd42be821ce39aba9c766afe42ff3e6b992f117c938` |
| 2 | 428 | `05945f88a5aabd1dd6152301133488ce317d4b400485496a3d65a22b4a53be73` |
| 3 | 594 | `d649359b66b444497d1e4d8be711382c23aefcccd2d19fd00a69d8d4c322eaed` |
| 4 | 760 | `9e81ff690576752bb4c5d9b87f69ae93474f6c10dca4230b278617a2fc552ae2` |

All four corresponding system hashes were `47e20ddbc55f5979ac072d42344f43a3131f6b83af746e0ebe3fa6ae3d5ac2ce`; all four tools hashes were `25ad4f7756af5cc9f1957c094d19d04e0570b1281fcd4cfca1e4c61861f9c0b1`. Model: `anthropic/mock-sonnet`, neutral decision seed. These system/tool hashes describe this run's shared throwaway path, not a normalized prompt.

The E2E package's `tsc --noEmit` was attempted. It reports 11 diagnostics in unchanged files (retina-local-fs alias resolution, a readonly symbol assignment, the existing Rust harness SDK type, and OpenCode-2 tests), and none in the changed comparison script. This is not recorded as a clean package typecheck; plugin/Pi typechecks remain clean.

The earlier message-only differential also passed after runtime commits `7a4060b3afd9494062ceee9f424e1cbcad8a3187`, `daab52e32a7bac1ff36e45bbad889e053644e6fc`, `f026f1fe64712aedb69393a4c55f5964bb040709`, `3532a5b1c71ea8d4b59230665aa508b9b6ba52e9`, and `f5b35b07485e22cab122037e6c6e7c1395c4bdaf`. Each had the four message hashes above against pinned master. No row required a defer-divergence rollback.

This initial comparison does not by itself prove a table-revision transition. The seeded HARD, tail-only and restart checks below supply the later priced evidence.

## Other executed checks

- `cargo check -p mc-module`: passed.
- `cargo test -p mc-module`: passed after fixing verification-discovered lifecycle regressions; 1,213 library tests passed, 8 existing tests ignored, and every integration target passed.
- `cargo clippy -p mc-module --all-targets -- -D warnings`: passed.
- Plugin and Pi `typecheck` scripts: passed.
- Plugin and Pi `build` scripts: passed.
- Targeted history, protection, producer, fallback/replay, emergency, table-freeze and calibrated-hygiene tests: passed. Runtime learning and its candidate-only tests were removed by owner ruling.
- AFT diagnostics were incomplete because authoritative TypeScript/Biome producers were unavailable; compiler/typecheck gates are the authority.
- Migration delta check against master covering `**/migrations.ts`, `**/storage-db.ts` and `crates/mc-store`: empty.

## Gate: priced neutral and Fable comparison

Committed evidence: [`priced-neutral.json`](tokenizer-calibration-gates/priced-neutral.json) and [`priced-fable.json`](tokenizer-calibration-gates/priced-fable.json). Both compare the pinned revisions above using the same real OpenCode capture harness and isolated fixture project path.

The fixture creates 52 real raw messages, seeds 52 versioned compartments, restarts to load those rows, and switches mock-sonnet to Fable to cause an existing model-change HARD. It supplies explicit model windows and output reservation. Neutral mode overrides only the resolver inside both extracted throwaway refs; no production configuration knob is added. Expectations supply local budgets **60,000** and **38,173** independently of the production calibration conversion.

| Capture | Master | Candidate |
|---|---|---|
| Neutral HARD messages SHA | `1c3f62d971bbeeb35805064dc6352e13037f0e6297b196e34163accdca89d458` | same |
| Fable HARD messages SHA | `1c3f62d971bbeeb35805064dc6352e13037f0e6297b196e34163accdca89d458` | `5cea1515c7ac3f022da203550cbf1011a1cee161490205b98a47ba5f8b6ac868` |
| Fable history SHA | `4ce19ae00732aa6549dfe829aaf01c8ee6da2dd212b86f9ac5a0718c2511a777` | `e5a3fd05041f16ea952e2aab1a46a59b1d99e0f4c733bfb5681714e9000d0a52` |
| Fable history local allowance | 60,000 | 38,173 |
| Independently expected and actually dropped tool tags at tail-only execute | `[56,59]` | `[56,59,62,65]` |

For the tail-only scenario both revisions adopt the same legacy cached history, SHA `4ce19ae00732aa6549dfe829aaf01c8ee6da2dd212b86f9ac5a0718c2511a777`. A fresh 85.5% provider sample after restart authorizes queued drops without yielding the protection window at 95%. The execute preserves cached history bytes **and its materialization timestamp**. It does not manufacture a HARD to pass the test.

Each path then observes four consecutive scheduler defers, with another restart between defers two and three. Cached history remains equal. In neutral mode all four corresponding messages/system/tools hashes also match between master and candidate. Fable intentionally produces different tail wire hashes because four rather than two tool tags are eligible. The runner's legacy terminal word `IDENTICAL` in the priced artifact means its **priced expectation predicate passed**, not that Fable's deliberately changed whole message arrays are equal. The individual hashes and expected/actual tag sets are the authority. The runner now prints `PRICED_EXPECTATIONS_MET` for that mode to remove the ambiguity; this output-label change does not alter the captured requests or predicate.

## Gate: suites and compiler checks

- [`full-plugin.json`](tokenizer-calibration-gates/full-plugin.json): 5,213 pass / 1 skip / 37 fail on the one full serial run. [`plugin-followup.json`](tokenizer-calibration-gates/plugin-followup.json): all failing groups covered by **68 pass / 0 fail**, with plugin/Pi typechecks passing. The existing v1 six-sequence byte golden was not regenerated.
- [`full-pi.json`](tokenizer-calibration-gates/full-pi.json): 1,193 pass / 3 skip / 31 fail on the one full serial run. [`pi-followup.json`](tokenizer-calibration-gates/pi-followup.json): affected groups had **340 pass / 4 fail**, followed by **4 pass / 0 fail** for those remaining nested-historian cases and a clean Pi typecheck. The four OMP HOME errors and smart-note check passed unchanged once the isolated HOME existed.
- The expanded gate instrument was typechecked after its edits. Two Bun-versus-cross-runtime SQLite declaration mismatches were corrected at the fixture/helper boundary; the final E2E check reports only the same 11 diagnostics in unchanged files, none in the gate script. This is not represented as a clean E2E package typecheck.
- The owner requested that recorded gates not be repeated. Accordingly these are **initial full-suite results plus passing targeted follow-ups**, not claims of a second all-green full run.
- [`cargo.json`](tokenizer-calibration-gates/cargo.json) preserves the already-passed full `cargo test -p mc-module` and clippy gates. Source-equivalence inspection confirmed no Rust, manifest, shared-fixture or seed-table changes since the validated runtime revision; no repeat build was needed.

Fixture changes do not bypass fit predicates. They declare mock model identities and model-specific windows. The 1.02× atomic-source case intentionally changes contract: raw-source clipping no longer authorizes the complete calibrated prompt; no producer prompt is sent and no range is published. Likewise incomplete Pi raw/LKG requests are refused, while durable capture/hydration and an explicitly observed fitting replay remain covered. Those intentional changes are stated in commit messages and the release-note draft.

## Gate: recorded mutation controls

[`mutation-evidence.json`](tokenizer-calibration-gates/mutation-evidence.json) contains nine executed **NON-VACUITY BREAK** records with the sole reddened test, positive controls and the staged/nonempty/restored-empty diff evidence. They cover unknown-envelope raw fallback, raw completeness, LKG completeness, emergency disarm, unsupported parts, TS complete producer fit, Pi calibrated wall, Pi missing observations and Rust producer admission before start. All mutants were restored; none is in the source tree. These runs were preserved rather than repeated.

## Explicit limitations and remaining release work

- Tail-hygiene T/U, absolute floors, cadence/grace and reminder figures now use the frozen static class ratios. Legacy U watermarks convert once at the first authorized bust and carry a durable v2 unit stamp in existing JSON state.
- Legacy historian projected-reclaim attribution and the full docs/memory/profile/facts/m1 cap inventory remain unresolved. The runtime delivery is not a declaration that every original section-3 row is complete.
- Table-revision upgrades were driven against persisted TS and Rust session state: both defer/restart reads retained the old revision, and the next priced pass adopted the changed revision. The missing hygiene-unit stamp mutation caused the second priced transition to re-run and reddened its sole named control.
- The full scheduler-to-provider adversarial HTTP matrix on every harness is not claimed. Actual caller/unit controls prove refusal of locally fitting over-wall estimates and positive fitting controls; the producer capacity fixtures observe real executor/SDK submission callbacks, not paid provider completions.
- Calibration is static-only; there is no runtime observation, EMA or learned provenance. Pi child tool schemas and later host/provider framing remain outside the static decision representation.
- No SQL migration, schema fence movement, new knob, learned-state persistence or wire dump was introduced. TS uses the existing `deferred_execute_state` JSON; Rust adds backward-defaulted keys inside existing `mc_cache_state.meta` JSON.

## Fable fixture units

The fixture calculations are independent arithmetic using static prose `1.571778` and tool policy seed `1.551639`; they are estimates in provider-token units, not a new provider measurement. A 60,000-provider-token history budget converts to 38,173 local tokens (`59999.481594` estimated provider tokens). Eight 1,000-local-token tool tags under a 6,000-provider-token floor retain tags 5–8 instead of tags 3–8. Whole crossing tags and the newest-three minimum remain protected.

Fable 5.1 fixture: history allowance 94,307 → at most 60,000 estimated real tokens (38,173 local); protected reach 6 tags / 9,310 → 4 tags / 6,207 estimated real tokens.

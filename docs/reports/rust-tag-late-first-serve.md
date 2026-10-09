# Rust: untagged first replay, then tagged recovery

Investigation: 2026-10-06 UTC. **Report only; no runtime change.** Source base:
`3b64fe4c2d832781a6751eff2fa384362bdc5c9d`. The brief identifies the deployed
build as `b6ee864f91bb01abe287e647de8d2d5c6f77a07f`; the relevant Rust transform,
Rust adapter, and LKG replay sources have no diff between that revision and this
base. This investigation did not independently attest the running binary hash.

## Result first

**The two assistant examples are a failed-transform/LKG recovery defect, not a
tag overlay applied one successful Rust pass late.** There is also a specific
array-aliasing bug that explains why recovery releases the frozen bytes on the
*very first* healthy pass:

1. A native/projection cache miss demands a large full-array upload. Concurrent
   paged uploads exceed the module's handler-wide staging cap. The first request
   is served from **LKG plus an untransformed raw tail**, not from native Rust
   output. Completion already stripped the assistant's self-tag; that raw tail
   therefore has no authoritative prefix.
2. `replayLastGood` installs the short replay **in place**, then reads
   `currentMessages.length` to initialize the freeze's *raw input* baseline.
   OpenCode's transform passes the same array as input and output. The length now
   counts the **short served output**, not the thousands of raw input messages.
3. The next healthy `SOFT+`, scheduler-defer pass compares its full input count
   against that short count. The apparent growth immediately exceeds 16. It logs
   `lkg_frozen_replay_released reason=raw_tail_growth_limit`, adopts the module's
   tagged output, and changes previously cached assistant **and user** text.

This is **older than tonight**. The alias-count regression was introduced on
October 2; the broader count-triggered release policy dates to September 5.
The October 2 ALF report already records an older raw tool-result → tagged
tool-result release, with a much larger cache price.

**The 20:50 AFT and 21:06 ALF examples are different.** They append new text to
an already-served provider user message. Neither retags the existing payload.
Calling all four `unaccounted_tail_rewrite` does not make them one tag-mint bug.

## Evidence boundaries and exact first command

The first analyzer invocation was exactly the requested one:

```sh
cd packages/plugin && bun scripts/analyze-cache-busts.ts --session 'ses_313660571ffeZTsf4koSJwk50Q' --since '2026-10-06T22:49:45.424Z' --until '2026-10-06T22:49:57.550Z' --show-diff --all-rows
```

It found two requests, one metered bust: `rewritten≈7,397`, first divergence
`message[432]`, `unaccounted_tail_rewrite`, `meterVsBytes=AGREE`, body sizes
**1,526,283 → 1,541,923 bytes**. The old text starts `I'm shipping…`; the next
starts `§37762§ I'm shipping…`. The analyzer's message index includes its
synthetic system segment: **message[432] is `body.messages[431]`**, not array
element 432 in the raw Anthropic body.

Sources read:

- **P:** `$(getconf DARWIN_USER_TEMP_DIR)opencode/magic-context/magic-context.log`,
  resolved to `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/opencode/magic-context/magic-context.log`.
- **M:** `~/.local/share/cortexkit/magic-context/logs/magic-context.2026-10-06.log`;
  also the surviving October 2 module log.
- **D:** the same temporary root's `opencode-anthropic-auth-dumps/`.
- Targeted SQLite **SELECTs only**, using Python 3.9.6's
  `sqlite3.connect('file:/Users/ufukaltinok/.local/share/opencode/opencode.db?mode=ro', uri=True)`.
  No live database was copied, written, migrated, or opened read-write.
  An unnecessarily broad text lookup was stopped; indexed `message_id`/`id`
  lookups supplied the part evidence below.

No host run, daemon invocation, restart, or signal to a live host was needed.
The executable reproduction uses the adapter's existing in-memory test fixtures,
not an OpenCode process. Thus no host-isolation/lsof claim is necessary. Only
this report is retained in the commit; exploratory tests were restored/removed.

## 1. The exact first-serve and recovery path

### 22:49 AFT timeline

Session: `ses_313660571ffeZTsf4koSJwk50Q`. Times and log line numbers refer to
the files read during investigation, not guaranteed future rotated files.

| UTC | Evidence | Meaning |
| --- | --- | --- |
| 22:43:18.629–18.642 | Read-only stored part `prt_11362b5e5001gJ0YX8hdekgvCo`, message `msg_113628bd30011Z5OIbZVewdIOK` | Completed text is untagged. Its other parts are `step-start`/`step-finish`, **not reasoning**. It was completed minutes before replay. |
| 22:49:40.428 | P:51491; M:18126–18127 | Tail delta cannot find its projection: `projection_cache_missing_or_reverted`; retry full, keep ordinal memo. |
| 22:49:42.677–42.973 | M:18129–18130 | AFT's two full-upload pages are 50,301,593 and 29,612,673 bytes. |
| 22:49:43.826–43.827 | P:51495–51505 | `transform page staging exceeded the handler-wide byte cap`; `decision=NEED_FULL_SYNC`, `committed=false`, `served_from=lkg`, `in=8115 out=380`, `applied=false`, `row_version=0`. No successful Rust tag/render pass served this request. |
| 22:49:45.424 | D, first request | Assistant at message[432] and user reminder at [433] are both untagged. |
| 22:49:53.574 | M:18140 | Successful full transform: `tag_mint_new=3`, `tag_mint_tokenized_bytes=17088`, `native_cache_reused_messages=0`, `native_cache_encoded_messages=380`, `native_cache_reencode_drift=0`. |
| 22:49:55.686–55.687 | P:51540–51543 | Synchronous priced capture; **local** release `raw_tail_growth_limit`; module still `SOFT+ reason=none scheduler=defer`, `committed=true`, `served_from=transform`, `in=8116 out=381`. |
| 22:49:57.550 | D, second request | Existing assistant gains `§37762§ `; existing user reminder gains `§37763§ `. The remaining previously present normalized segments are unchanged. |

The staging failure has a concrete concurrency explanation. ALF's five pages
at M:18120–18124 total **210,231,194 bytes**. Its handler remains applying until
22:49:44.352 (M:18132), overlapping both AFT pages. Together the two uploads
would require **290,145,460 bytes**, exceeding the **268,435,456-byte (256 MiB)**
handler-wide cap. AFT alone is below the cap. `TransformPageCoordinator` counts
both collecting and applying phases; `handle_transform_paged` releases the
applying charge only after the unpaged handler returns. The logs do not print
the coordinator's entire occupancy at rejection, but these two overlapping
uploads alone exceed it. This is not an out-of-memory or tokenizer diagnosis.

### Why one new raw message looks like thousands

The exact relevant source chain is:

- [`transform.ts`](../../packages/plugin/src/hooks/magic-context/transform.ts):716,1005
  assigns `const messages = output.messages as MessageLike[]`, then calls the
  Rust adapter with `messages` and `output`. **Array identity is shared.**
- [`rust-mode-transform.ts`](../../packages/plugin/src/hooks/magic-context/rust-mode-transform.ts):535–539
  `replaceMessagesInPlace` splices `output.messages`; it does not replace the
  array object. This is intentional so OpenCode serializes the installed result.
- `replayLastGood`, :2066–2069, does this in the wrong order:

  ```ts
  replaceMessagesInPlace(output, replay.messages);
  enterLkgReplayFreeze(ensureState(states, sessionId), currentMessages.length);
  ```

- `enterLkgReplayFreeze`, :1103–1108, stores that count if no freeze baseline
  exists. `run` already captured the correct `inputCount` at :2404, but this
  helper does not use it.
- On a healthy defer, :4060–4073 computes
  `inputCount - state.lkgFrozenAtInputCount`, releases at 16, sets the local
  `cacheBustingPass=true`, and uses module output instead of frozen replay.

For the observed AFT shapes, the short counts would be **380** and **278**,
not **8115** and **8013**. The next raw counts are **8116** and **8014**. The
false growth is therefore **7736**, rather than **1**, in both cases. The logs
do not expose the stored baseline directly; the aliased adapter reproduction
below proves this calculation with the same production code and array identity.

### Tag minting is not the overlay, and neither is LKG

[`transform.rs`](../../crates/mc-module/src/transform.rs) keeps separate stages:

1. `compute_active_overlay_decisions` (:10652–10860) chooses mint candidates and
   appends authoritative `McTagRow`s. `tag_mint_new` is the **number of rows minted
   in the accepted pass**, not the number of tags observed by the provider or a
   promise that a previous fallback rendered them.
2. `apply_once` refreshes `tag_numbers` immediately after minting (:4246–4272),
   constructs `tag_overlay_state` (:6191–6199), and builds output with that overlay.
   `apply_tag_overlay_to_message` (:10171–10233) prefixes text/tool outputs and
   marks modified retained-wire blocks. There is no general “wait one pass” queue.
3. For OpenCode/OwnedBroca, newly minted tags on blocks the **module** knows it
   previously served are held in `pending_tag_block_ids` on defer (:5207–5223).
   That protects successful module replay. It cannot recognize a brand-new raw
   tail which only the **host's failed-pass LKG** served; the failed upload never
   committed a module output fingerprint for those blocks.
4. The module's newest reasoning-first assistant protection can withhold minting
   and overlays mid-turn. Claude Code has a tag-only first-sight exception
   (:10689–10697,15370–15384). This is not the explanation here: both stored
   target assistants have text plus step metadata, with no reasoning part.
   The later mint applies on the first **successful** engine pass.

[`lkg-replay.ts`](../../packages/plugin/src/hooks/magic-context/lkg-replay.ts):675
instead serves `[...capturedPrefix, ...entry.pristineTail]`. There is no call to
the tagger for that pristine tail. `experimental.text.complete`'s persistence
cleanup already removed the self-tag. The TypeScript-mode experiment in
[issue 625](issue-625-persistence-strip.md) exercised a successful transform on
the first replay; it did not exercise this Rust failed-upload recovery path.

### Native deltas and the host apply path

`applyNativeMessagesVerbatim` (:1355–1393) either installs the module's native
array or splices `previous.nativeOutput[0:replace_from] + delta.messages`, after
checking the acknowledged fingerprint. It does not add tags. The healthy apply
path (:3915 onward) first decodes that **module** representation, then chooses
whether to serve it or the frozen LKG representation. It retains the unmodified
module array as the native-delta basis (:4087–4090), distinct from the actual
provider-served LKG bytes. Full-wire mode during a freeze keeps those bases apart.

Here the recovery uses a full upload and re-encodes all native output after cache
loss; `native_cache_reencode_drift=0`. Cache misses/evictions lead to the upload
and fallback, but the evidence does **not** show a native delta dropping a prefix
or a stale native-attachment entry replaying untagged text. Tagging the returned
array again in the TypeScript apply path would be the wrong fix.

The sentinel calls the eventual change unaccounted because the serving pass
still logs the module's `SOFT+ reason=none`, not an independent engine bust.
The local `lkg_frozen_replay_released` line is the missing causal evidence. It
explains the rewrite; it does not make the lost provider cache harmless.

## 2. The earlier three windows, separated by cause

The same analyzer was run with `--show-diff --all-rows --all-busts` over
20:50:00–20:50:35 AFT, 21:00:30–21:01:10 AFT, and 21:05:45–21:06:30 ALF.

| Current request UTC | First divergent segment | Actual existing-content change | Analyzer rewritten tokens |
| --- | --- | --- | ---: |
| AFT 20:50:25.970 | [233], user/tool-result carrier | Identical `toolu_014RTUE48LciFKYgZd1mRoie` result payload; **new separate text block** `§37629§ First we need to figure out broca issue. ` | 2,843 |
| AFT 21:01:00.105 | [252], assistant | `BROCA confirmed…` → `§37644§ BROCA confirmed…`; [253] user notice also gains `§37645§ ` | 994 |
| ALF 21:06:21.843 | [463], user | First text already contains `§41026§ ` and stays identical. **Second block added**, starting `§41027§ <system-reminder>\nWake digest` | 1,806 |

AFT 21:00:44.606 is the same failed staging/LKG shape as 22:49:43: P:10072–10086
records `native_cache_missing`, full retry, byte-cap error, `in=8013 out=278`,
`committed=false served_from=lkg`. At 21:00:54.597, M:16422 records
`tag_mint_new=3`, `native_cache_encoded_messages=278`, no re-encode drift. At
21:00:56.021, P:10131 records `raw_tail_growth_limit`, immediately before the
tagged provider request. The stored BROCA text part was completed at
**20:52:26.373** (`prt_112fd3483001qU8RfEtyDHyrEP`, `msg_112fd1dfb001mF7mzhEF4YdipS`),
again without a reasoning part.

In contrast, both passes on either side of the 20:50 AFT and 21:06 ALF append
are successful `SOFT+ served_from=transform` passes. AFT's added text is a
**distinct stored user message**, `msg_112fb1690001CALSzzq3xnikC6`, created at
20:50:07.632, with a text part at 20:50:07.634. It was not in the earlier
provider body, then was joined into the existing user/tool-result wire carrier.
ALF's original user message `msg_113098bd3001MDsvkhi5ZRQOuh` has only its original
stored text part (21:05:55.159); the wake-digest block is additional served
context, not a later prefix on that part. These store reads corroborate distinct
text/notice inputs, but cannot recover which upstream host/injection stage first
made each extra block eligible for a particular dispatch. That attribution
requires ingress/provider-conversion captures; it is not proven to be a Rust
tagger defect.

The raw payload comparisons exclude the **moving `cache_control` marker**,
which transfers from the old last content block to the new tail. The analyzer
likewise normalizes cache controls and the rotating Anthropic billing header.
“Unchanged payload” does not mean entire request JSON equality.

**Does it affect users/tool results?** The LKG mechanism is role-independent:
the two confirmed assistant incidents also retag the existing user reminder,
and older ALF evidence shows a tool-result retag. But **neither of the two
specified append examples is such a retag**. A tag-only fix will not prevent a
new block from being attached inside an older cached provider message.

## 3. Age: two distinct historical facts

| Commit / date | Relevant behavior |
| --- | --- |
| `ea547890d4`, August 27 | Freeze LKG bytes across deferred recovery. |
| `ed0cf2b120af6693187daeecf3ef0b2adaf8eb85`, September 5 | Introduces eight-healthy-pass / sixteen-raw-message **forced adoption**. The failure ladder initially used `run`'s captured `inputCount`, so this was not yet the alias-count bug. |
| `96f1a2bdf3212cb8cec34006b0a56c2867c8c734`, September 6 | Fixes Claude Code's reasoning-first late tags by minting/rendering tag-only overlays on first sight; explicitly leaves OpenCode native replay policy unchanged. |
| `3d38f87c876203b3dd441321dee5102953dbb0cc`, September 19 | Defers late OpenCode tags on module-observed served blocks; it is not a host fallback-tail publication protocol. |
| `d7012f17639ba731b1cbac4b09d64cb29f992f7c`, October 2, 06:04:01 UTC | Moves freeze entry inside `replayLastGood`, **after in-place installation**, using `currentMessages.length`; removes the failure ladder's captured-input-count version. This introduces the demonstrated immediate-release regression. |
| `b20c1e71d7`, July 16; `905f11a541`, September 4 | Staging-cap machinery/error and later cap adjustment predate tonight. Current cap is 256 MiB. |

`git log -S` and the actual October 2/September 5 diffs establish the order above.
There is no relevant product-source diff from tonight's reported build to this
worktree base.

**Older observation:** [the October 2 ALF investigation](2026-10-02-alf-ckmc-sigkill-bust.md)
records a `SOFT+` raw-tail-count release at 04:02:44.444, changing a previously
served tool result at message[627] from `queued pmid=…` to `§24990§ queued pmid=…`,
with **395,859** analyzer rewritten tokens. It predates the 06:04 alias regression
and demonstrates the *older forced-release policy*, not this immediate-count bug.
The surviving October 2 module log independently still has the 03:51:27.127
full-sync miss (M:1834) and 04:02:42.775 full upload / scheduler-defer records
(M:1895–1897). Module logs alone do not contain the provider bytes or prove tags.

Current dump retention starts **October 6 at 20:17:28.194**; no older Anthropic
request dumps were found in that directory. P has no rotated sibling and its
current session records start tonight. Thus the older raw diff is preserved
prior-report evidence, not a newly rerun comparison against surviving old dumps.
Exact earlier per-hour incidence cannot be reconstructed from the module logs:
they observe engine renders, not every fallback actually sent by the host.

## 4. Frequency and token price

Bounded scan: all retained dumps for the two exact sessions, initially upper filter
`2026-10-06T23:00:00Z`, using the repository's `__test.loadSnapshots` and
`analyzeSnapshots`, with `withSchedulerLogFallback`. The scan snapshot ended at
22:57:53.765 for AFT and 22:59:11.272 for ALF; verification pins those per-session
upper bounds so later live dumps cannot change the denominators. **356 requests, all metered**.
These are observed wall-clock windows, not estimates for the entire day.

| Session / UTC hour October 6 | Requests | Late-tag busts | Their rewritten tokens | Separate append busts | Their rewritten tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| AFT 20 (starts 20:49:42.779) | 14 | 0 | 0 | 1 | 2,843 |
| AFT 21 | 47 | 1 | 994 | 0 | 0 |
| AFT 22 (through 22:57:53.765) | 55 | 1 | 7,397 | 0 | 0 |
| ALF 20 (starts 20:17:28.194) | 102 | 0 | 0 | 0 | 0 |
| ALF 21 | 78 | 0 | 0 | 1 | 1,806 |
| ALF 22 (through 22:59:11.272) | 60 | 0 | 0 | 0 | 0 |

- **AFT:** 2 late-tag incidents in 2.13638 observed hours = **0.936/hour**,
  2/115 consecutive metered comparisons. All three small tail rewrites together:
  1.404/hour, **11,234** analyzer rewritten tokens.
- **ALF:** 0 late-tag incidents in 2.69530 hours; one separate append incident =
  **0.371/hour**, **1,806** analyzer rewritten tokens, 1/239 comparisons.
- **Combined small tail rewrites:** 4 incidents, **13,040** rewritten tokens;
  **8,391** belong to the two confirmed late-tag windows. All four are classified
  `unaccounted_tail_rewrite`.
- ALF additionally has two large **accounted HARD marker-drain/epoch** windows
  at 20:17:51.144 and 20:24:07.777: **260,342 + 247,106 = 507,448** rewritten
  tokens. They are excluded from the small/ordinary-pass count. AFT has two
  LATENCY short reads; ALF has two. They are not byte-rewrite incidents. One AFT
  and two ALF bytes-only/meter-stable rows are not charged as metered busts.

### Rewritten tokens are not all avoidable cache loss

For Anthropic the analyzer prints the response's **cache-creation tokens**.
That includes the genuinely new tail as well as old tokens rewritten after the
divergence. Treating 7,397 as 7,397 *additional* tokens caused by the tag is wrong.

| Incident | Previous read/write/direct total | Current cache read + direct | Shortfall of prior total | Cache creation reported |
| --- | ---: | ---: | ---: | ---: |
| AFT 20:50 | 299,602 | 298,027 + 2 | 1,573 | 2,843 |
| AFT 21:01 | 308,472 | 307,913 + 2 | 557 | 994 |
| ALF 21:06 | 348,428 | 347,992 + 2 | 434 | 1,806 |
| AFT 22:49 | 419,152 | 418,370 + 2 | 780 | 7,397 |

The two tag incidents therefore have **1,337** prior-total tokens missing from
the comparable read; all four have **3,344**. This is a meter-based cache-loss
proxy (the analyzer allows ε=64), not a token-by-token attribution or an invoice.
The incremental monetary price needs the model's actual cache-read/write rate;
apply the write-minus-read premium to lost reusable tokens, not the whole new
cache write. No dollar total is asserted here.

## 5. Smallest fix, and which tests fail today

### A. Two-line immediate-regression repair

Capture the ingress count **before** installing replay output:

```diff
+ const replayInputCount = currentMessages.length;
  replaceMessagesInPlace(output, replay.messages);
- enterLkgReplayFreeze(ensureState(states, sessionId), currentMessages.length);
+ enterLkgReplayFreeze(ensureState(states, sessionId), replayInputCount);
```

This fixes the false 7736-message growth without changing tag allocation,
serialization, signed reasoning, marker behavior, or the helper's signature.
It must cover both aliased and separate arrays and all replay callers. **It
prevents the demonstrated next-pass rewrite but does not by itself satisfy
“every ordinary pass is byte-identical”: the existing 8/16 real-count policy
would still retag the raw tail later.**

### B. Recommended byte-stability policy: never tag later on an ordinary pass

For a valid, fitting frozen replay, make the 8/16 bounds **recovery debt**, not
permission to adopt a different provider representation. Preserve the already
served raw tail on every ordinary defer; adopt module tags on the next genuinely
authorized prefix bust. Keep model/anchor/content validation, resource/context
fit admission, and provider-reasoning safety escapes; failures requiring a
refusal or explicitly priced safety recovery are not ordinary passes.

This reuses the existing LKG representation choice and is smaller than minting
authoritative tags during an outage. “Tag on first fallback serve” would require
an authoritative reservation/serialization contract available while the engine
is failing; guessing IDs or calling the ordinary TS tagger afterward is not
safe. A per-block permanent tagless mask is another possible protocol, but
requires publishing the host's actual served decisions back to the engine.
None is implemented here.

No tag-only change guarantees stability when an upstream stage actually adds
text inside a previously cached user carrier. Investigate the two append
windows separately at ingress/provider conversion; ensure fresh notices/user
input are present before their first dispatch or placed in genuinely new wire
segments. Do not silently drop operator input or fabricate an assistant turn to
force a cache boundary. Approval of a tag fix should not authorize that unrelated
host message-assembly behavior change.

### Red-first diagnosis, including the alias control

A temporary test block in the existing `LKG durability across restarts` fixture
used 40 raw user messages, a one-message captured representation, a forced
module failure, then exactly one appended raw message and a healthy `SOFT+`.
The only difference between the two cases was
`fallback.messages = alias ? raw : [...raw]`. It called the **real adapter** and
queried `getState`; the module client alone was scripted.

```text
bun test .../rust-mode-transform.test.ts -t 'report diagnostic:'
Bun 1.4.2 (744846f84); 2 tests, 2 assertions
REPORT ALIAS alias=false ingress=40 fallback=1 baseline=40 nextIngress=41 release=none
PASS: report diagnostic: separate output preserves freeze on one appended raw message
REPORT ALIAS alias=true ingress=40 fallback=1 baseline=1 nextIngress=41 release=lkg_frozen_replay_released reason=raw_tail_growth_limit
FAIL: report diagnostic: aliased output preserves freeze on one appended raw message
Expected lkgRepresentationFrozen: true; received: false
1 pass, 1 fail; no other failure
```

The existing bound tests use **separate** input/output arrays, so they miss this
alias regression. Preserve that new aliased-input test when implementing A.
The test file was restored exactly afterward; no permanent expectation changed.

Offline tests against the eight actual hashed bodies below also name concrete
currently-red claims (not merely hypothetical tests):

- `AFT 22:49 ordinary recovery preserves its previously served assistant text`
- `AFT 21:01 ordinary recovery preserves its previously served assistant text`
- `AFT 22:49 completed assistant is tagged on its first provider serve`
- `AFT 21:00 completed assistant is tagged on its first provider serve`

For the recommended policy B, the **first two** are the acceptance invariant;
the first-serve assertions distinguish the alternate tag-on-first-serve solution.
Passing controls compare the assistant payload with only its added leading tag
removed, the identical AFT tool-result payload plus a separate new user block,
and ALF's already-tagged original text plus a new wake block. These compare the
real provider body values, not expected values generated by the tagger.

Three existing runtime tests were run unchanged and **pass today**:

1. `releases a valid frozen replay on the eighth consecutive healthy defer`
2. `releases a valid frozen replay when the raw tail grows by sixteen messages`
3. `strips thinking after the raw tail an outage served when the first healthy pass releases on tail growth`

Under B, the first two need an **explicit contract change** to debt/byte-stable
expectations, with red-first tests for both bounds, restart, aliased arrays,
assistant/user/tool-result fallback tails, and a genuine bust landing debt once.
The third protects signed reasoning after an actual representation change; keep
that safety property and exercise it on a genuinely authorized/safety recovery,
not by deleting its assertions. Existing Rust first-sight and late-tag tests
(`tool_loop_first_sight_tag_bytes_survive_new_reasoning_assistant`,
`subagent_defer_replays_served_bytes_and_execute_releases_late_tag`) should remain
controls; they do not test the failed-upload host path.

## Reproduction inventory and verification

All files below end in `.body.json` under D. AFT suffix is
`ses_313660571ffeZTsf4koSJwk50Q-direct-sticky-wwaxgmail`; ALF suffix is
`ses_227ce5788ffeRPA9THoPLOQreO-direct-sticky-wwaxgmail`.

| Prefix before `-<session suffix>.body.json` | Bytes | SHA-256 |
| --- | ---: | --- |
| AFT `2026-10-06T20-50-09-885Z-000005` | 1,127,883 | `1a836fd389cbe5d766626b94d124e805fc35efc492d7f713c0729fd36f6c2a83` |
| AFT `2026-10-06T20-50-25-970Z-000006` | 1,135,011 | `664df095129132f530e23589e6a3de8288de00c9489db0aaf0ae70b28b7b7ac8` |
| AFT `2026-10-06T21-00-45-789Z-000015` | 1,159,864 | `4e648ebc0dedcc2aa8dcf18ef6f527a090ed74c8b188175a1e5c449844e0c759` |
| AFT `2026-10-06T21-01-00-105Z-000016` | 1,160,960 | `79f4759df4bd53de7e916ac85efa0b42f282bd5a48c6f2c9e0b8bf583146bbfa` |
| ALF `2026-10-06T21-06-05-170Z-000059` | 1,797,056 | `4e30c247472519a8ca8cb10e3c467fec85b65990860ddb6637428104006cfb06` |
| ALF `2026-10-06T21-06-21-843Z-000060` | 1,803,372 | `a0dad0ac2675a5e67c2ed385a28fb2a2bc452d0c1290926dae11dc344a4c38fe` |
| AFT `2026-10-06T22-49-45-424Z-000614` | 1,526,283 | `f9b7eae0620524351bf326457ae8be80937b94dc0e2c4182d721e8aa64e63fd7` |
| AFT `2026-10-06T22-49-57-550Z-000616` | 1,541,923 | `1076a3834f6100ca54340fee957376575e2da16a0751b06247634430d49711b2` |

Counting recipe from the repository root (Bun 1.4.2); no live store access:

```ts
import { __test } from "./packages/plugin/scripts/analyze-cache-busts";
import { withSchedulerLogFallback } from "./packages/plugin/scripts/cache-bust-scheduler-log";
for (const session of ["ses_313660571ffeZTsf4koSJwk50Q", "ses_227ce5788ffeRPA9THoPLOQreO"]) {
  const until = session.startsWith("ses_313") ? "2026-10-06T22:57:53.765Z" : "2026-10-06T22:59:11.272Z";
  const args = __test.parseArgs(["bun", "script", "--session", session,
    "--until", until]);
  const snapshots = __test.loadSnapshots(args);
  const rows = __test.analyzeSnapshots(snapshots, withSchedulerLogFallback([], session));
  for (const hour of ["20", "21", "22"]) {
    const selected = rows.filter(r => r.current.createdAt.startsWith(`2026-10-06T${hour}:`));
    const tail = selected.filter(r => r.verdict === "BUST" && r.divergenceClass === "unaccounted_tail_rewrite");
    console.log(session, hour, selected.length, tail.length,
      tail.reduce((n, r) => n + (r.rewrittenTokens ?? 0), 0));
  }
}
```

To distinguish tag-only versus append events, compare every previously present
`segment.canonical` at the same index for these small windows. Tag-only pairs
become equal after removing **leading `^§\d+§ `** from their text fields; append
pairs retain every old content block exactly and add a new block. Do not count
same-index coincidences across HARD history cuts as tag-only events. For raw
body controls, omit `cache_control` from content objects, not other payload fields.

Verification completed with Bun **1.4.2 (744846f84)**:

- Exact requested analyzer pair: 2 requests / 1 bust; earlier windows: 4, 2,
  and 2 requests / 1 bust each; bounded aggregate: 356 metered requests.
- Existing analyzer/scheduler suites:
  `bun test packages/plugin/scripts/analyze-cache-busts.test.ts packages/plugin/scripts/cache-bust-scheduler-log.test.ts`
  — **44 pass, 0 fail, 173 assertions**. The actual run also named two absent
  test paths; Bun ran the two existing suites above, not four suites.
- Current bound/release controls: `bun test packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts packages/plugin/src/hooks/magic-context/rust-mode-release-strip-gate.test.ts -t 'releases a valid frozen replay on the eighth consecutive healthy defer|releases a valid frozen replay when the raw tail grows by sixteen messages|strips thinking after the raw tail an outage served when the first healthy pass releases on tail growth'`
  — **3 pass, 0 fail, 25 assertions**.
- Aliased adapter diagnostic: **1 pass, 1 expected fail**, with the exact red
  name and passing separate-array control above. No production mutant was used.
- Retained-body diagnostic: **3 pass, 4 expected fail, 17 assertions**, seven
  tests naming the four red claims and three passing payload controls above.
- An offline report verifier checks all eight recorded body hashes/sizes, the
  pinned per-hour counts/costs, and relative source/report links. Its initial
  5-second scan timeout was insufficient; verification uses a 30-second timeout.
- Scoped inspection has no authoritative Markdown diagnostic producer, so its
  partial result is not claimed as a clean diagnostics pass.
- Report-only typecheck/build/lint: not required for Markdown. The prepared
  worktree's install/build had passed before diagnosis. No manifest changed.

**Decision requested for a later task:** approve the narrowly scoped alias-count
repair, and separately approve the ride-only recovery-debt policy if the required
contract is truly zero ordinary-pass retagging. Do not conflate either with the
two host text-append windows. No implementation has been made or authorized here.

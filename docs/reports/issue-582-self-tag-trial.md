# Issue 582: live DeepSeek self-tag trial

**Actual API response identity: `deepseek-flash`.** Every measured benchmark response returned that exact `model` field. DeepSeek's [pricing/model page](https://api-docs.deepseek.com/quick_start/pricing), accessed 2026-09-30, maps this alias to **DeepSeek-V4.1-Flash**; the responses themselves do not expose an immutable v4.1 snapshot ID. The person supplying model access authorized `deepseek-flash` after the API rejected `deepseek-v4.1-flash` and listed `deepseek-flash` as its supported Flash name. No other model was benchmarked.

## Result

**B improves compliance, but does not make self-tagging reliable enough for a byte-identity invariant.** Across seven sessions per variant, stripped-and-retagged text equaled raw provider text for **114/153 A text parts (74.5%)** and **142/153 B text parts (92.8%)**. B's first reply was correct in all seven sessions, but its first text-plus-parallel-tools reply was missing the tag in **every session**. Correct prefix numbers were not the problem: there were **zero wrong numeric prefixes**. Missing prefixes, tag-only tool framing, and mid-text/dangling tags still broke byte identity.

This is a small, controlled benchmark, not a general result about other models, thinking mode, or provider WebSocket cache behavior. The measured property is the exact assistant-text equality those continuation routes need. A 92.8% success rate is not an every-reply guarantee.

## Real tagging rule

Allocation is session-global, not a scan of visible tag-shaped strings. The allocator reconciles the memory counter, persisted counter, and database maximum, then allocates one more; existing identities reuse their number (`packages/plugin/src/features/magic-context/tagger.ts:438-488,809-855`). Removing old message text or tool outputs does not ordinarily rewind the counter.

All abbreviated colon-prefixed references in the following paragraphs refer to `packages/plugin/src/hooks/magic-context/tag-messages.ts`.

`tagMessages` walks messages and parts in array order (`packages/plugin/src/hooks/magic-context/tag-messages.ts:564-581`). Nonblank text uses identity `messageId:p<partIndex>` (`:727-733`), resolves an existing number or assigns a new one (`:805-838`), and gets the production prefix at `:862-864`. Fresh whitespace-only assistant text consumes no tag (`:731-800`). Reasoning is accounted on text/tool tags, not independently prefixed (`:572-575,826-836,917-938`).

An invocation without a completed output does not allocate a fresh tool tag. Completed tool outputs allocate through `assignToolTag`, keyed by session, owner message, and call ID (`:588-725,888-938`); separate tool-result messages pair to the invocation owner through FIFO resolution (`:590-615`). Parallel completed tools consume successive numbers in part order. OpenCode normally stores completed tool parts on the invoking assistant message.

Cases executed through the production tagger, with a preceding user text already tagged 1:

| New parts, in order | Actual assigned numbers |
|---|---|
| one text | 2 |
| two texts | 2, 3 |
| reasoning, text | reasoning none; text 2 |
| text, completed tool | text 2; output 3 |
| completed tool A, completed tool B, text | outputs 2, 3; text 4 |
| invocation only | none until a result exists |
| whitespace-only assistant text | none |
| invocation plus separate result message | output 2, bound to invocation owner |

Raw arrays and assignments are committed in `issue-582-self-tag-probes.json`. These drive real `tagMessages`, not a simulated counter. The surrounding in-process controls also use `createTransform`, `applyPendingOperations`, and batch finalization.

Consequently “one more than the highest visible tag” is not universally equivalent to allocation: earlier new text/tool parts can consume numbers, absent history can hide the maximum, and quoted head strings can be much larger. In this sample, well-formed emitted text prefixes nevertheless always matched the actual assignments. The head fixture explicitly labels `§9001§` as a quoted literal, so this is not an adversarial test of an unexplained high-numbered string.

## Guidance and execution conditions

A is the product's **full guidance for a primary assistant with the `ctx_reduce` tool available**, unchanged. Its composer is `buildMagicContextSection` (`packages/plugin/src/agents/magic-context-prompt.ts:157-168,203-206`). The harness wrapper first delegates to the real system hook; only B appends this exact additional system entry:

> Start the text of each reply with exactly §N§ followed by one space, where N is one more than the highest tag number in the conversation. Never write tags anywhere else: not mid-text, not in tool arguments, and not on tool-call-only replies.

No C variant was run. OpenCode 1.18.30 hosted the built Magic Context dist from this worktree. Provider generation was non-thinking (`thinking.type=disabled`) with a 512-token output cap, applied identically by the relay. The small fixture answers did not require long output; no benchmark response finished with a length-limit reason. No fixed seed or temperature was imposed.

### Primary and supplemental cohorts

“Fresh” starts an empty session. “Reduced” requests removal of an older fixture tool output via `ctx_reduce`. “Literal-head” adds quoted `§9001§` text to the injected memory/history head. A dropped output is represented by `[dropped §N§]` when production rules retain its tool-call skeleton.

- **Primary:** six sessions per variant, two each of fresh, reduced, and literal-head; 16 user turns each, including requested 3–6-step tool loops on turns 3 and 8, mixed text/tools and parallel calls. Every session actually made parallel calls. Reply positions extend beyond 20. Requested real `ctx_reduce` calls ran, but these sessions did **not** serve a dropped placeholder.
- **Supplemental:** one reduced session per variant, 18 user turns each. A deterministic large **tool result**, not user-only padding, displaced the protected tail. Pending reductions still did not materialize until the host was restarted and the session continued, creating a fresh transform/cache decision. Both continued sessions then served the target placeholder to actual DeepSeek requests before counting the scenario as fulfilled.

There were harness setup mistakes, retained rather than hidden: early configuration used invalid `protected_tokens=0`; the primary and first supplemental attempt also used invalid `transform_mode=typescript` instead of `ts`. Magic Context therefore fell back to its product defaults. Both variants in the primary cohort used the same defaults and real full guidance; the tagging measurements remain real, but the intended reduced protection setting was not active. The final supplemental host validates its configuration with the production schema, uses `transform_mode=ts` and `protected_tokens=4000`, and disables background historian/dreamer work. **Do not treat the pooled results as one perfectly homogeneous configuration.** Primary results are also reported separately below.

The failed supplemental attempt, interrupted pilot, and their spend are preserved separately and excluded from benchmark rates. The valid A supplemental session was resumed, not discarded and replaced with a nicer answer. B was likewise resumed after its pending operation failed to appear on the wire. No product code was changed to force a drop or repair a model answer.

## What the loop measured

The host owns native roles, history and tool execution. `host-plugin.mjs` wraps the real built plugin rather than relying on relative ordering of two separate plugins:

1. The actual messages transform composes tags and synthetic head messages m[0]/m[1], the two leading history/memory records. The literal-head scenario appends the quoted memory fixture to the real m[0].
2. The relay forwards the provider request; it never records HTTP headers. It separately observes streamed raw text, tool arguments, actual response model, finish reason and usage.
3. `experimental.text.complete` captures raw text **before** delegating to Magic Context, then records the stripped text.
4. The next real transform is observed. Raw message/part IDs locate the first subsequent replay; the allocated number is independently read from the same session's throwaway tag database.
5. A final flush runs the real transform, captures the last reply, then throws **before** any further provider call. Both mock and live adapters assert that flushing did not increment request count. Flushes are not counted as paid replies or user benchmark turns.

Every benchmark session verifies that provider-stream text and the pre-strip hook text agree, and that paid provider calls correspond one-to-one with observed assistant replies. There are no unobserved final replies counted as successes.

The production strip removes leading, global complete, malformed, dangling and stray tag notation, then trims whitespace (`packages/plugin/src/hooks/magic-context/tag-content-primitives.ts:88-96`). Correct numbers alone do not establish byte equality. Comparisons are exact string/UTF-8 text identity, with no normalization of spaces or punctuation.

Metric definitions: `wellFormed` means a closed leading `§digits§`; `canonicalPrefix` additionally requires the following ASCII space. `malformed` detects lettered, dangling or otherwise incomplete section-mark notation, including mid-text instances. A closed tag-only frame such as `§34§` is not malformed notation, but it is misplaced tool framing, has no taggable persisted text, and is not a correct-number success. Tool-only replies with **no raw text** have separate denominators. Raw streamed arguments are checked as well as arguments delivered to native tools.

## Overall benchmark results — seven sessions per variant

Each provider reply had at most one raw text part in this run. The 325 benchmark replies contain 306 raw text parts and 19 genuinely text-free tool-only replies.

| Variant | Replies | Raw text parts | Closed leading tag | Canonical prefix | Correct number | Wrong number | Malformed notation | Misplaced tags | Byte-identical text |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A | 167 | 153 | 117 | 116 | 116 | 0 | 6 | 6 | 114 (74.5%) |
| B | 158 | 153 | 146 | 145 | 145 | 0 | 3 | 4 | 142 (92.8%) |

A had 14 and B had 5 text-free tool-only replies; none contained tags in arguments. There was one **tag-only text frame accompanying tools** in each variant, counted in the raw-text columns rather than disguised as a successful text-free reply. Malformed and misplaced categories overlap. The signed numeric delta is emitted number minus the tagger's allocated number. None was nonzero; malformed `§28a§` is not converted into a guessed numeric error.

### By reply position (all benchmark sessions)

Buckets are disjoint: 1, 2–5, 6–20, and **strictly greater than 20**. Position counts every assistant reply, including text-free tool replies; denominators below count raw text parts at those positions.

| Variant | Position | Text parts | Closed tag | Correct number | Wrong number | Malformed | Misplaced | Byte-identical |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| A | 1 | 7 | 0 | 0 | 0 | 0 | 0 | 0 |
| A | 2–5 | 24 | 12 | 11 | 0 | 0 | 1 | 11 |
| A | 6–20 | 96 | 79 | 79 | 0 | 6 | 5 | 77 |
| A | >20 | 26 | 26 | 26 | 0 | 0 | 0 | 26 |
| B | 1 | 7 | 7 | 7 | 0 | 0 | 0 | 0 | 7 |
| B | 2–5 | 28 | 21 | 21 | 0 | 0 | 0 | 21 |
| B | 6–20 | 101 | 101 | 100 | 0 | 3 | 4 | 97 |
| B | >20 | 17 | 17 | 17 | 0 | 0 | 0 | 17 |

Late-session success is encouraging but does not erase early failures. A's tendency to start copying prefixes after tagged history is served is visible here; B fixes the initial reply but not the first mixed tool reply.

### Cohorts kept separate

| Cohort | Variant | Sessions | Calls | Text parts | Correct number | Byte-identical |
|---|---|---:|---:|---:|---:|---:|
| Primary, product-default fallback | A | 6 | 138 | 129 | 97 | 96 (74.4%) |
| Primary, product-default fallback | B | 6 | 132 | 131 | 124 | 122 (93.1%) |
| Supplemental, validated config and restart | A | 1 | 29 | 24 | 19 | 18 |
| Supplemental, validated config and restart | B | 1 | 26 | 22 | 21 | 20 |

### Real dropped-history proof

| Variant | Supplemental session | Target | Durable status | Provider requests that actually served it |
|---|---|---:|---|---|
| A | `ses_f0d195cb8ffebp1ygdGT8mjsmo` | 28 | dropped | calls 27–29 |
| B | `ses_f0d0ceb8affersrAuCX1brRsg2` | 24 | dropped | calls 53–55 |

The proof checks three independent observations: an actual tool-result placeholder in the transformed wire, durable `tags.status='dropped'`, and the target number in the relay's **outgoing provider tool-result messages**. For resumed B, the relay refused to make a paid call if the required target was absent. It was present. Thus these are not merely queued reductions or model-written placeholder text. The protection window prevents recent tool outputs from being dropped. It considers **tool rows only**, always includes at least the newest three tool tags, and walks backwards until their stored token counts reach the configured budget (`packages/plugin/src/features/magic-context/protection-window.ts:104-118,168-203`); user-only padding was not an adequate way to age this window. No tail-protection product fix is included in this trial.

## Rows and answer quality

Complete raw text, first 60 characters, actual assignment, signed delta, notation/location flags, byte identity, response model and usage are committed in JSONL/CSV, not only percentages. Representative primary rows:

| Variant / scenario | Session | Position | Raw beginning | Assigned | Outcome |
|---|---|---:|---|---:|---|
| A / fresh | `ses_f0d2dc6dfffe5HvngA0c8pWK6k` | 1 | `Apples: 3, pears: 4, total: 7.` | 2 | no prefix; byte mismatch |
| B / fresh | `ses_f0d2d307effePqboiMimisWXLM` | 3 | `I'll start by reading the fixture and listing the directory` | 6 | missing prefix with parallel calls |
| A / literal-head | `ses_f0d2aae28ffe2FwtvetaVLVwH7` | 16 | `§28a§ 3 plus 4 equals 7.` | 29 | malformed prefix; no guessed numeric delta |
| B / reduced | `ses_f0d2731deffeAcXLQC6sJgo6Y1` | 16 | `§34§` | none | tag-only tool framing; byte mismatch |
| B / reduced | `ses_f0d2c9f01ffesqMT1l2ohzrewN` | 17 | `§35§ Done — I queued a drop for §25,` | 35 | correct leading number; dangling mid-text tag; byte mismatch |

Three actual answer/trace examples from this one model (A/B variants):

1. **Mixed-tool preamble:** B wrote “I'll start by reading the fixture and listing the directory in parallel.” It is a useful explanation and the native parallel calls really happened, but the missing leading tag defeats the instruction. This failure recurred in all seven B sessions.
2. **Normal arithmetic with malformed tagging:** A wrote “§28a§ 3 plus 4 equals 7.” The arithmetic is correct; the notation is not. B generally preserved normal concise prose while adding a correct prefix. No quality score is assigned and no broad claim about coding ability follows from fruit arithmetic.
3. **Correct prefix, damaged retained trace:** B wrote “§35§ Done — I queued a drop for §25, the completed directory-listing output; it's held for now…” and then correctly explained 3+4=7. Persistence removed the dangling tag reference. A also wrote “Stamped — §25's drop is queued…”; its retained text lost the handle and became awkward. The instruction did not eliminate these inline-tag/trace defects.

The quoted fixture answers are substantively correct. There is no obvious degradation from B in these selected examples, but the unnecessary tag-only tool frame and inline malformed handles are real damage, not numerical successes to gloss over. The literal-head sessions never produced a well-formed 9002 prefix (one more than the quoted 9001); all their well-formed prefixes used the real lower allocation numbers.

## Calls, tokens and spend

| Phase | Provider calls | Input tokens | Output tokens | Included in benchmark rates? |
|---|---:|---:|---:|---|
| Primary | 270 | 1,222,444 | 9,009 | yes |
| Successful supplemental sessions, including their continuations | 55 | 379,394 | 1,761 | yes |
| Interrupted pilot | 150 | 563,259 | 5,292 | no |
| Failed supplemental configuration attempt | 25 | 346,320 | 1,030 | no |
| Unsupported model spelling setup | 2 HTTP 400 requests | no completion usage | none | no |

**Total: 502 requests, 500 model calls with completion usage, 2,511,417 input tokens and 17,092 output tokens.** Input splits into 2,313,344 cache-hit and 198,073 cache-miss tokens. One pilot call was not checkpointed when its host was stopped; its usage was recovered from the isolated host's recorded end-of-model-step token counters. Its response-model field was not recovered or guessed. All 325 benchmark responses have independently captured model identity and pre-strip text.

Using the cited DeepSeek Flash rates, estimated spend for **all phases**, including debugging, is **$0.0469 off-peak to $0.0938 peak**. This is a token-based estimate, not a read of the operator's balance or invoice. The documentation lists cache-hit $0.003/$0.006, cache-miss $0.15/$0.30, and output $0.60/$1.20 per million tokens for off-peak/peak. No credential or billing endpoint was queried to calculate cost.

## Credential handling and isolation

The operator staged only the DeepSeek entry under `$TMPDIR/magic-context/self-tag-trial/creds/auth.json`, mode 600. It was copied, without printing its contents, into each throwaway host's `data/opencode/auth.json` and kept mode 600. The original staging file was deleted after the primary cohort; the operator explicitly restaged it for the supplemental sessions.

**The staging file, including its restaged replacement at the same path, and all known copied auth files are now deleted.** Deletion was checked for the primary, pilot, failed supplemental, and final supplemental roots. No live auth file, live config, live database, or credential table was read. No key appears in report/data. The relay never records headers, so no Authorization header is present in the dumps; error messages are additionally sanitized against both the complete authorization value and bare key before recording.

Hosts use fresh HOME/XDG/config/cache/store directories under the trial temporary root and a minimal child environment, with only `deepseek` enabled. The sole live endpoint is the relay forwarding to `https://api.deepseek.com/v1/chat/completions`. Native file/network tools are disabled for the agent; deterministic fixture tools and real `ctx_reduce` are available. Title generation is disabled. `lsof -Fn -p <host pid>` before/after sessions is committed in the summaries, and every sampled forbidden-live-path list is empty. These are sampled host-PID checks, not continuous tracing of every descendant.

No product code, product guidance, tagger, ARCHITECTURE.md or STRUCTURE.md changed.

## Artifacts and verification

- `issue-582-self-tag-live.{jsonl,csv}`, `-summary.json`, `-analysis.json`: primary rows, native snapshots, provider stream records, usage and lsof proof.
- `issue-582-self-tag-supplement.*`: actual dropped-history sessions and outgoing `servedDroppedTags` evidence.
- `issue-582-self-tag-all.jsonl`, `-aggregate.json`: 325 benchmark rows with cohort labels and pooled/position tables plus all-phase spend.
- `issue-582-self-tag-pilot.*`, `issue-582-self-tag-supplement-failed.*`: excluded attempts and their raw rows/costs. The interrupted pilot's incomplete session is not counted as a completed session.
- Existing `-probes.json`, `-offline.jsonl`, `-offline-snapshots.json`: real production-code plumbing controls, not model-compliance evidence.
- `issue-582-self-tag-host-proof.json` and `-rows.jsonl`: deterministic pinned-host proof, including a no-paid-call final flush.

Harness entry points are under `packages/plugin/scripts/self-tag-trial/`: `live.ts`, `live-adapter.ts`, `host-plugin.mjs`, `measure.ts`, `analyze.ts`, `aggregate.ts`, and recovery/control scripts. Use `bun .../live.ts <output-prefix>` only with an operator-staged mode-600 credential; it does not discover credentials. The factory validates Magic Context config before host launch. The read tool uses the committed fixture file; echo and listing are deterministic fake results. Adding file-backed fixture reading preserves the exact bytes used in the measured runs. `reduction-supplement` selects two bounded sessions; `resume-A`/`resume-B` continue their existing isolated histories. Successful completion deletes staged and copied files. On failure, the copied credential is deleted while the staged file is retained for an explicitly authorized retry; an operator abandoning the run must delete the staging file.

A safe redaction-control mutation, using only a fake unit-test credential, made exactly `provider errors redact authorization and bare credential values` fail while the other ten tests passed. The staged source was restored and the six measurement tests passed again; no mutated code was committed or used for live calls.

Typical setup and checks, from repository root:

```sh
BASE="${TMPDIR:-/tmp}/magic-context/self-tag-trial"
mkdir -p "$BASE/host"
bun add --cwd "$BASE/host" --exact opencode-ai@1.18.30
bun install --frozen-lockfile
bun run --cwd packages/plugin build
# The operator stages the approved auth.json, without printing it.
bun packages/plugin/scripts/self-tag-trial/live.ts docs/reports/issue-582-self-tag-live
# Supplemental runs require explicit restaging after primary cleanup.
bun packages/plugin/scripts/self-tag-trial/live.ts docs/reports/issue-582-self-tag-supplement reduction-supplement
bun packages/plugin/scripts/self-tag-trial/analyze.ts docs/reports/issue-582-self-tag-live
bun packages/plugin/scripts/self-tag-trial/analyze.ts docs/reports/issue-582-self-tag-supplement
bun packages/plugin/scripts/self-tag-trial/aggregate.ts
bun run --cwd packages/plugin typecheck
bun test packages/plugin/scripts/self-tag-trial/engine.test.ts packages/plugin/scripts/self-tag-trial/measure.test.ts
```

The current factory fixes the invalid configuration used in the recorded primary cohort; a new run uses the validated configuration rather than reproducing that fallback mistake. Model outputs are not expected to reproduce deterministically.

Verification commands: plugin package typecheck; focused engine/measurement tests; pinned mock host probe; live per-session provider/hook equality, actual DB number readback and last-reply flush guards; independent outgoing placeholder checks; sampled lsof fence; explicit credential deletion checks; and git whitespace checks. No new dependency or lockfile change was required for this follow-up. The earlier standard plugin build supplies unchanged product dist. The repository formatter still rejects its existing `rules.preset` configuration; no unrelated formatter cleanup is included.

**Decision supported by this trial:** explicit self-tagging helps this Flash model, especially on the first reply, but the tested B wording does not meet the required every-reply/cache-byte contract. Fixing the first mixed-tool preamble and preventing inline/tag-only output would require a further experiment or a different mechanism; this report does not assume either fix works.

## Follow-up: variants C and D (2026-09-30)

The A/B observations and conclusions above are retained as the original trial record. This follow-up adds C, and D (C's wording with thinking enabled); it does not retroactively change the A/B data or guidance.

### Exact instruction and corrected conditions

C appends the following **separate system entry after the unchanged full product guidance**, exactly where B appends its own line. D uses the same bytes as C:

> Every user message, every text you write and every tool result in this conversation carries a tag such as §12§, numbered in the order they arrive. Start the text of each reply with exactly §N§ and one space, where N is one more than the highest tag number you can see, tool results included. That applies to every reply that has text, including a short sentence written alongside tool calls, for example `§12§ Reading both files in parallel.` followed by the calls. A reply that is only tool calls gets no tag. IMPORTANT: NEVER write tag notation anywhere else: not mid-text and not in tool arguments. To refer to an item in your prose, write "tag 12".

The exact line quoted above was compared byte-for-byte with the operator's `.cortexkit/alfonso/plans/issue-582-variant-c.md`, section “Variant C system line”, to verify that no punctuation or spacing changed. The pinned-host mock probe checks the actual system hook: C's line is present for C and D, absent for A and B; B's original line remains present only for B. No A/B instruction or product guidance was replaced.

**C's and D's primary sessions ran with corrected, production-schema-validated config; the original A/B primary sessions ran on defaults after their invalid config fell back.** These are not perfectly matched historical cohorts. The earlier A/B successful supplements already used validated config. The follow-up explicitly uses `transform_mode: "ts"`, `protected_tokens: 4000`, full guidance, disabled historian/dreamer/compressor, and disabled automatic memory search/promotion. No product code changed. Two new fresh-session controls (one A, one B) use this corrected config, reported separately rather than pooled into the original A/B rates.

All calls still request and return `deepseek-flash` through the same relay and use OpenCode 1.18.30 with the built product dist. C and the A/B controls use `thinking.type=disabled` and `max_tokens=512`; **D alone uses `thinking.type=enabled` and `max_tokens=4096`**. Host model output-limit metadata is 4096 in the follow-up, while the relay enforces those per-variant generation caps. No seed or temperature is added. Raw reasoning and provider-reported reasoning-token counts are retained per call and in D's rows/trajectories; only reply text is scored.

Each C/D benchmark contains two fresh, two reduced and two literal-head 16-turn sessions plus one 18-turn reduced supplement. Prompts, deterministic tools, requested 3–6-step loops and parallel-call requests are unchanged. Every completed session actually made parallel calls. Supplemental turns 17–18 continue the original 16-turn scenario with the same reduction-flush and arithmetic prompts used for the A/B continuations.

The scheduler defers history reductions while the provider can reuse a cached prompt prefix: dropping old content would invalidate that prefix. A same-root restart alone did not expire this five-minute reuse window: the first C supplemental attempt stopped after 16 paid turns when the relay refused to forward a request without the required placeholder. Its 25 paid calls and provider-only recovered rows are retained as excluded data. The first capture file was overwritten on restart in that attempt; the harness now preserves capture history across restarts. The successful C and D supplements wait 301 seconds after turn 16, then restart the isolated host, allowing the five-minute cache TTL to expire before the guarded turn 17. This makes the implicit pause in the historical manual continuations explicit, without changing product scheduling or writing to its DB. A combined C/D runner also rejected a D startup locally because C's guard leaked across sessions; no upstream call was made. The guard now resets at session start; D's standalone supplement is the counted D session. Neither rejected request is counted as a model reply.

### Pooled results next to the original A/B

**C achieved 155/155 byte-identical text parts in this sample (100%). D achieved 169/171 (98.8%).** This is evidence for C's wording in these fixtures, not proof of an every-reply invariant. Thinking did not improve this sample: D had one wrong prefix and one unprefixed closing acknowledgment. Both C and D fixed the first mixed text-and-tools reply in all seven sessions, unlike historical B's 0/7.

| Variant | Replies | Text parts | Closed tag | Canonical prefix | Correct number | Wrong number | Malformed | Misplaced | Byte-identical |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A, historical | 167 | 153 | 117 | 116 | 116 | 0 | 6 | 6 | 114 (74.5%) |
| B, historical | 158 | 153 | 146 | 145 | 145 | 0 | 3 | 4 | 142 (92.8%) |
| C, corrected config | 160 | 155 | 155 | 155 | 155 | 0 | 0 | 0 | 155 (100%) |
| D, corrected config + thinking | 176 | 171 | 170 | 170 | 169 | 1 | 0 | 0 | 169 (98.8%) |

C and D each had five text-free tool-only replies, with no argument tags. Neither had a tag-only text frame accompanying tools. Denominators still count raw text parts; reasoning is never included in these scores.

| Variant | Reply position | Text parts | Closed tag | Correct | Wrong | Malformed | Misplaced | Byte-identical |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| A, historical | 1 | 7 | 0 | 0 | 0 | 0 | 0 | 0 |
| A, historical | 2–5 | 24 | 12 | 11 | 0 | 0 | 1 | 11 |
| A, historical | 6–20 | 96 | 79 | 79 | 0 | 6 | 5 | 77 |
| A, historical | >20 | 26 | 26 | 26 | 0 | 0 | 0 | 26 |
| B, historical | 1 | 7 | 7 | 7 | 0 | 0 | 0 | 7 |
| B, historical | 2–5 | 28 | 21 | 21 | 0 | 0 | 0 | 21 |
| B, historical | 6–20 | 101 | 101 | 100 | 0 | 3 | 4 | 97 |
| B, historical | >20 | 17 | 17 | 17 | 0 | 0 | 0 | 17 |
| C | 1 | 7 | 7 | 7 | 0 | 0 | 0 | 7 |
| C | 2–5 | 28 | 28 | 28 | 0 | 0 | 0 | 28 |
| C | 6–20 | 101 | 101 | 101 | 0 | 0 | 0 | 101 |
| C | >20 | 19 | 19 | 19 | 0 | 0 | 0 | 19 |
| D | 1 | 7 | 7 | 7 | 0 | 0 | 0 | 7 |
| D | 2–5 | 28 | 28 | 28 | 0 | 0 | 0 | 28 |
| D | 6–20 | 101 | 100 | 99 | 1 | 0 | 0 | 99 |
| D | >20 | 35 | 35 | 35 | 0 | 0 | 0 | 35 |

### First mixed text-and-tools reply, one row per session

Every row below is reply position **3**, assigned **tag 6**, has real parallel tool calls and is byte-identical. Raw text is quoted without normalization. The session ID disambiguates the supplemental reduced session from primary replicate 1.

| Variant / scenario / replicate | Session | Raw first mixed reply | Byte identity |
|---|---|---|---|
| C / fresh / 1 | `ses_f0c697af9ffesBxM5SUS7mUfRN` | `§6§ Reading the fixture and listing the directory in parallel first.` | yes |
| C / reduced / 1 | `ses_f0c691d65ffe1tpRRbiiruHgIb` | `§6§ Reading the fixture and listing the directory in parallel first.` | yes |
| C / literal-head / 1 | `ses_f0c68bf26ffe49CmalvP6tLOxd` | `§6§ Starting with a parallel read and list, per your request.` | yes |
| C / fresh / 2 | `ses_f0c68653fffewLiYUKv8MscCZ0` | `§6§ Starting with a parallel read and list.` | yes |
| C / reduced / 2 | `ses_f0c67f555ffeLQeksL8sEkEaJV` | `§6§ Reading the fixture and listing the directory in parallel to start.` | yes |
| C / literal-head / 2 | `ses_f0c6796d2ffeWYgcM2p0GTBa5P` | `§6§ Reading fixture.txt while listing the fixture directory in parallel first.` | yes |
| C / reduced supplement / 1 | `ses_f0c60a4d0ffe5JyxT1v7RJJwpO` | `§6§ Reading the fixture and listing the directory in parallel first.` | yes |
| D / fresh / 1 | `ses_f0c64207bffe7FzR46wH4qZuT4` | `§6§ Starting by reading the fixture and listing the directory in parallel.` | yes |
| D / reduced / 1 | `ses_f0c63a8e8ffesNGQCzGHjel9SL` | `§6§ Reading fixture.txt and listing the directory in parallel first.` | yes |
| D / literal-head / 1 | `ses_f0c631727ffe1w1CoA48W7GY4b` | `§6§ Starting with a parallel read of fixture.txt and listing of the directory.` | yes |
| D / fresh / 2 | `ses_f0c62a17dffeGn1HPv6fTjM8gk` | `§6§ Starting by reading the fixture and listing the directory in parallel.` | yes |
| D / reduced / 2 | `ses_f0c620c12ffe6Mr5VXOVIY2zeE` | `§6§ Reading fixture.txt and listing the fixture directory in parallel to start.` | yes |
| D / literal-head / 2 | `ses_f0c61900effep2ssFBn9q5ALR2` | `§6§ Starting with a parallel read of the fixture and a listing of the fixture directory.` | yes |
| D / reduced supplement / 1 | `ses_f0c5f3009ffe6D6Z3pD9EnlJoG` | `§6§ Starting with a parallel read of the fixture and a listing of the directory.` | yes |

### Controls and actual reduction evidence

| Corrected fresh control (not pooled above) | Calls / text parts | Correct / byte-identical | Wrong / malformed / misplaced | First mixed reply |
|---|---:|---:|---|---|
| A, `ses_f0c607977ffethfiBIjp63uzOE` | 22 / 22 | 18 / 18 (81.8%) | 0 / 0 / 0 | position 3, no prefix, mismatch |
| B, `ses_f0c601507ffeycvRH3VDfpDoWi` | 20 / 20 | 19 / 19 (95%) | 0 / 0 / 0 | position 3, no prefix, mismatch |

Both controls wrote `I'll start by reading the fixture and listing the directory in parallel.` Their first mixed reply should have carried tag 6. The same B defect survives the config correction in this one-session control, supporting the interpretation that C's explicit mixed-reply example helps. One control per variant cannot isolate all config or sampling effects, so the historical A/B-versus-C rate difference should not be attributed entirely to wording.

| Supplement | Target | Durable status | Actual outgoing provider calls serving target |
|---|---:|---|---|
| C, `ses_f0c60a4d0ffe5JyxT1v7RJJwpO` | 25 | dropped | 26–28 |
| D, `ses_f0c5f3009ffe6D6Z3pD9EnlJoG` | 28 | dropped | 29–31 |

Each counted supplement has 18 user turns, transformed-wire placeholder evidence, durable DB readback, and independent outgoing **tool-message** placeholder evidence. Primary C/D reduced sessions, like the old primary cohorts, queued reductions but did not serve a dropped placeholder. Corrected-config primary C was 131/131 byte-identical text parts; its supplement was 24/24. Primary D was 141/143; its supplement was 28/28.

### Prose references, reasoning and the two D failures

C used the requested plain-prose `tag N` reference form in **9 text parts**; D did so in **3**. There was **no mid-text section-mark notation** in either variant's reply text and no section marks in tool arguments. These are counts of text parts containing a reference, not counts of individual references. The literal-head fixture never caused a `§9002§` prefix (one greater than its quoted, non-live `§9001§` handle).

D did write tag notation inside its reasoning: **164/176 calls** contained a section mark in reasoning, including statements identifying tool tags and planning the next prefix. There were 169 calls with nonempty reasoning; all 169 have an exact reasoning-part replay in the captured transformed history. No empty or cleared reasoning replay was observed in these short sessions. The raw reasoning strings, per-call `reasoningTokens`, finish reasons and observed reasoning replays are in JSONL/summary files; trajectories include reasoning separately, unscored. All 176 D calls reported reasoning-token usage, including zero counts. Their total is **9,188 reasoning tokens**, already included in the 15,554 completion-token total, not an extra billable total. C/controls did not report a reasoning-token breakdown and produced no reasoning text; their rows retain `null` rather than inventing a reported zero.

Magic Context removes section-mark tag notation from assistant text before storing it, through `experimental.text.complete`; typed reasoning is a separate part, not a leading-tagged text part. The TS cleanup/replay path targets reasoning `text`/`thinking` fields, and records a separate clear watermark (`strip-content.ts:245–388`, `transform-postprocess-phase.ts:2204–2255`, `storage-meta-persisted.ts:1012–1038`, under `packages/plugin/src/hooks/magic-context/` except the storage file under `features/magic-context/`). Thus observed reasoning notation was not stripped as reply text. No reasoning cleanup was observed here, and these runs do not prove what a longer cleared-reasoning session would do. Exact provider-text/pre-strip-hook equality held in every counted session; reasoning handling caused **no observed change to reply-text byte identity**.

D's two mismatches are ordinary reply-text failures, not a reasoning-stripping artifact:

- Fresh replicate 1, position 7: raw `§13§ is the complete answer; the stamping was merely deferred, so no further action is needed.` Actual assignment was 15 (delta **−2**), and replay began `§15§`. The reasoning itself recognized that a new text reply would need tag 15, yet the text reused 13.
- Fresh replicate 2, position 10: raw `Done.` Actual assignment was 21; replay was `§21§ Done.` The reasoning debated ending without more text and knew that another reply required tag 21, but the acknowledgment omitted it.

**No counted C or D reply finished with `finish_reason=length`**, including D's tool-only replies. There was no captured stream error or failed provider response in the counted cohorts.

### Follow-up calls, tokens and cost

| Phase | Paid model calls | Input tokens | Completion tokens | Reasoning tokens (subset) | Benchmark? |
|---|---:|---:|---:|---:|---|
| C primary | 132 | 778,124 | 4,389 | not reported; no reasoning text | yes |
| C supplement | 28 | 201,567 | 1,067 | not reported; no reasoning text | yes |
| D primary | 145 | 801,492 | 13,146 | 7,816 | yes |
| D supplement | 31 | 250,478 | 2,408 | 1,372 | yes |
| Corrected A/B fresh controls | 42 | 157,464 | 1,422 | not reported; no reasoning text | separately |
| Excluded first C supplement | 25 | 159,673 | 937 | not reported; no reasoning text | no |
| Relay guard rejections | 0 (2 local requests) | 0 | 0 | 0 | no |

Follow-up total, including excluded work: **403 paid model calls, 2 locally rejected requests, 2,348,798 input tokens and 23,369 completion tokens**. Input comprises 2,163,584 cache-hit and 185,214 cache-miss tokens. At the same cited Flash rates, estimated incremental spend is **$0.0483 off-peak to $0.0966 peak** (about 5–10 cents). C's counted sessions cost $0.0181–$0.0362, D's $0.0238–$0.0476, controls $0.0030–$0.0060; the remainder is excluded C debugging. Adding the historical estimate gives roughly $0.0952–$0.1904 across both trials. These remain estimates, not invoice reads; reasoning tokens are not double-counted.

### Follow-up isolation, cleanup and reproducibility

All hosts used throwaway roots only. The summaries retain `lsof -Fn -p <pid>` before and after completed sessions, with empty forbidden-live-path lists. No live auth/config/database/store was opened by the harness, and no live credential source was discovered. Checks are sampled host-PID evidence, not exhaustive descendant tracing. The relay records no headers and sanitizes provider-error credential values. A direct artifact scan for the exact operator-staged DeepSeek API key found zero occurrences in the 47 then-generated files; all later artifacts derive only from those sanitized captures.

**The staged credential was retained until D's supplemental run finished, then deleted. All six throwaway auth-copy paths, including the failed C root, were checked absent.** `issue-582-self-tag-cleanup-c.json` records the deletion checks. Per-run summaries correctly show that staging was retained at their own completion; the cleanup artifact is the final state. No key or Authorization header is committed.

New artifacts, next to the old A/B files:

- `issue-582-self-tag-live-c.*`, `issue-582-self-tag-supplement-c.*`: C raw rows/CSV, summaries and analyses.
- Corresponding `-live-d.*`, `-supplement-d.*`: D data, including full raw reasoning and reasoning tokens per call.
- `issue-582-self-tag-all-c.jsonl`, `-aggregate-c.json` and corresponding `-d` files: seven-session pooled and per-position results, first-mixed rows, usage and cost.
- `issue-582-self-tag-controls-c.*`, `-all-controls-c.jsonl`, `-aggregate-controls-c.json`: corrected A/B controls kept separate.
- `issue-582-self-tag-supplement-failed-c.jsonl` and `-supplement-failed-c-summary.json`: excluded provider-only recovered rows, not guessed byte-identity scores. `-relay-rejected-c-summary.json` preserves the second local rejection. `-spend-c.json` includes both rejections and all paid work.
- `issue-582-self-tag-host-proof-c.json` and `-rows.jsonl`: zero-paid-call actual-host A/B/C/D system and storage/replay proof.
- `issue-582-self-tag-trajectories-c/` and `-trajectories-d/`: one file per session, showing every prompt, raw reply text, native provider tool calls, assignment and text-part verdict; D reasoning is shown separately. A control trajectory folder is also included. The earlier `issue-582-self-tag-trajectories/` folder was not present in this checkout; the committed `followup-report.ts` renders prompts, raw text, calls, assignments and verdicts directly rather than relying on an unavailable renderer.

Run from the repository root after install/build and after the operator stages the DeepSeek-only `auth.json` at `$TMPDIR/magic-context/self-tag-trial/creds/auth.json`, with mode 600 (read/write for its owner only):

```sh
SELF_TAG_VARIANTS=C SELF_TAG_KEEP_STAGED=1 bun packages/plugin/scripts/self-tag-trial/live.ts docs/reports/issue-582-self-tag-live-c
SELF_TAG_VARIANTS=D SELF_TAG_KEEP_STAGED=1 bun packages/plugin/scripts/self-tag-trial/live.ts docs/reports/issue-582-self-tag-live-d
SELF_TAG_VARIANTS=C SELF_TAG_KEEP_STAGED=1 bun packages/plugin/scripts/self-tag-trial/live.ts docs/reports/issue-582-self-tag-supplement-c reduction-supplement
SELF_TAG_VARIANTS=D SELF_TAG_KEEP_STAGED=1 bun packages/plugin/scripts/self-tag-trial/live.ts docs/reports/issue-582-self-tag-supplement-d reduction-supplement
SELF_TAG_VARIANTS=A,B SELF_TAG_FRESH_CONTROL=1 SELF_TAG_KEEP_STAGED=1 bun packages/plugin/scripts/self-tag-trial/live.ts docs/reports/issue-582-self-tag-controls-c
# Delete staging after all runs; each host close deletes its isolated copy.
# Analyze each of the five prefixes with analyze.ts, then:
bun packages/plugin/scripts/self-tag-trial/followup-report.ts docs/reports/issue-582-self-tag c live-c supplement-c
bun packages/plugin/scripts/self-tag-trial/followup-report.ts docs/reports/issue-582-self-tag d live-d supplement-d
bun packages/plugin/scripts/self-tag-trial/verify-followup.ts
bun test packages/plugin/scripts/self-tag-trial/engine.test.ts packages/plugin/scripts/self-tag-trial/measure.test.ts packages/plugin/scripts/self-tag-trial/host-probe.test.ts
bun run --cwd packages/plugin typecheck
```

The live C/D sessions passed independent DB assignments, provider/pre-strip equality, next-transform replay, final no-provider flush and sampled isolation checks. The final artifact verifier checks session/scenario balance, every call's model/thinking/cap, actual system entries, D reasoning usage, supplement wire/DB/provider evidence and raw-versus-replayed identity. Removing C/D's appended system entry made exactly `C and D guidance reaches the pinned host and is absent for A` fail with `C guidance variant not applied`; all seven measurement tests still passed. Staged source was restored, its working diff returned to empty, and all eight tests passed again. `issue-582-self-tag-mutation-c.json` records the named red/green control and diff evidence. No mutated harness was used for any live request.

**Interpretation:** C eliminates the observed B mixed-reply and inline-reference defects in this bounded sample. Its 100% sample rate is not a universal byte-identity guarantee. D demonstrates that enabling thinking does not enforce the contract: the reasoning may correctly plan a tag while the emitted reply omits or misnumbers it. The corrected controls support, but do not fully isolate, a wording effect relative to historical B.

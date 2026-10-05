# Issue 552: primer refresh, end to end

Baseline inspected: `950c57dd4643eb8c3ced05c1e4a7211f8ea58097`, including the fix merged as `b6248b04`: same-project primer candidate selection, separation of Pi from OpenCode storage, and paged summary reads for OpenCode primer seeds. The reporter's September 28 follow-up correctly distinguishes project scoping from memory boundedness. Starting in the right project did **not** make the old whole-session reader safe.

## Conclusion and scope

* The fixed **OpenCode origin-history path** does not accumulate previous pages, tool outputs, or a rendered whole-session transcript. The actual `refresh-primers` task executor stays flat on the 10,000-message fixture. Restoring whole-session hydration inside its visitor makes the same test fail, with an additional 87 MiB sampled heap.
* The baseline **Pi-native origin-history path was still unbounded**. Its factory called `SessionManager.listAll`, loaded the selected JSONL in full, converted every entry, and retained that array throughout the refresh. This change replaces that primer-only path with header-only discovery and synchronous, projected JSONL pages. The same task-runner test now uses about 26 MiB additional sampled heap rather than 155 MiB for the large fixture.
* Two adjacent compartment summaries and the closed-book fallback were clipped **after** reading their full SQL values. They now clip in SQLite, including titles. This also prevents a very large stored compartment body from defeating a closed-book refresh's memory bound.
* This is not a universal heap ceiling for arbitrary model/tool behavior. The child is a new investigation, not the origin session. Its own tool results can be large; those are distinguished below. The tests deliberately stub model transport, but execute task setup, lease, candidate selection, seed, prompt, child creation/prompt/result retrieval, grounding check, answer persistence, and child deletion.

## Trace: historical data and strings

Paths below are relative to `packages/`; line references describe the delivered source, except where explicitly marked baseline. `P` means `plugin/src`, `PI` means `pi-plugin/src`.

| Stage / location | Live material | Bound / disposition |
| --- | --- | --- |
| `P/features/magic-context/dreamer/task-executor.ts:403,847` | Task metadata, backlog, arguments to refresh | No origin messages. Calls refresh directly; does not pre-read the origin. |
| `P/features/magic-context/dreamer/refresh-primers.ts:71,169,182` | Active primer rows, stale-primer filter/sort, selected primers | All active primer metadata is read before selecting at most **5** sequential refreshes. This scales with primer count, not origin message count; it is not an origin transcript cache. |
| `P/features/magic-context/dreamer/primer-seed.ts:124` and `P/features/magic-context/storage-primers.ts:368` | Candidate IDs, candidate rows, filtered/sorted array | Metadata proportional to the primer's support IDs, not raw session length; not a fixed candidate-count cap. Most recent **same-project** candidate wins. Selection is repeated by origin lookup (`refresh-primers.ts:367`) and seed assembly. |
| Baseline `PI/dreamer/primer-raw-provider-pi.ts:50,61,62` | Discovery previews, full file/entries, converted raw-message array, closure retaining messages | **Unbounded before this change**, even for the right project. Replaced; not merely sliced after hydration. |
| `PI/dreamer/primer-raw-provider-pi.ts:30,117,142,162,182` | JSONL read buffer, one line/parsed entry, projected entry, directory iterator/header | 64 KiB reads, **1 MiB maximum serialized entry**, one bounded header per discovered file, no list of transcript previews. Only text and rendered tool-input fields survive projection; outputs, diagnostics, images and reasoning do not survive into raw-message pages. A single bounded line is temporarily parsed before projection. Files/descriptors close on generator early return and failure. |
| `PI/read-session-pi.ts:299,313,319,342` | At most one output page plus pending tool-result parts folded into a user row | Existing canonical converter now accepts an iterable; ordinal/folding logic unchanged. Primer provider requests at most **50 messages**. Entry content and consecutive tool-result runs are limited to **256 parts/results**; exceeding a safety bound throws into the seed's existing closed-book fallback, rather than dropping rows and shifting ordinals. Pages re-open and scan from the start, trading extra bounded work for no retained file descriptor/history/index. |
| `P/features/magic-context/dreamer/refresh-primers.ts:225`; `P/hooks/magic-context/read-session-chunk.ts:419` | Cache scope and visitor's current page | The visitor does **not populate the full-message cache**. OpenCode uses a 50-message summary page; Pi supplies projected pages. The generic fallback still calls `provider.readMessages()` for a provider lacking paging, but the new Pi primer provider has paging and refuses full reads. |
| `P/hooks/magic-context/read-session-raw.ts:279,307,331` | Message rows, selected part rows, `partsByMessageId`, assembled page | Only the current OpenCode page. SQL excludes tool output/diagnostics/reasoning/files; text is clipped to **8192 characters**, tool summary fields to **512**. Bounds are on message count and projected fields, not an absolute bound on the number of parts in a pathological single message. |
| `P/features/magic-context/dreamer/primer-seed.ts:73-115` | Per-message `out`, user text maps/join, tool summary strings, accumulated `lines`, final orientation join | Stops reading at **4000 estimated tokens**. No previous raw pages retained. The original first-line exception remains: the first line can exceed the token cap, so the cap is not a strict universal byte ceiling. Its input comes from the projected page, not full tool output. |
| `P/features/magic-context/dreamer/primer-seed.ts:132-159,160-177` | Adjacent rows / closed-book row, rendered context join | At most two neighbors or one origin row. Now SQL-clipped before JS: **1200 characters** per neighbor body; **2000** for fallback; **512** per title. Former post-read slices alone did not bound hydration. |
| `P/features/magic-context/dreamer/refresh-primers.ts:88,239,293` | Orientation header, complete prompt string, SDK text part | Combines bounded seed/context with primer question and stored answer; not a session-sized join. Primer question/answer storage is independent of origin message count. |

Pi's projection preserves long but low-token-cost rendered fields that fit the orientation budget; larger fields use the OpenCode character limits. That avoids changing an under-budget seed merely because a field crosses 512/8192 characters. Differential coverage includes Unicode, images/reasoning, long low-token text/description, tool-result folding, unknown-role ordinal slots, final pending results, and a page boundary. Inputs beyond the explicit entry/part safety limits intentionally fall back closed-book. Discovery uses the running host's `getAgentDir()/sessions`, or the explicitly supplied session directory, and scans project subdirectories without following directory symlinks. An unsupported host without `getAgentDir` falls back closed-book.

## Trace: the child and results

| Location | What is held / joined | Bound and relation to origin size |
| --- | --- | --- |
| `P/features/magic-context/dreamer/refresh-primers.ts:276-324` | New child, prompt response, final output messages | Creates a **fresh child** and fetches at most **100 child messages**. Per-primer deadline is a fair share of the remaining task deadline. This is a message-count bound, not a bound on arbitrary individual tool-result bytes. No origin-history array is sent. |
| `P/shared/assistant-message-extractor.ts:62-93`; `refresh-primers.ts:155-164` | Filter/map/sort of child messages, latest assistant's joined text, regex capture, JSON answer | Processes only returned child output. Answer rejected above **20,000 characters**, after extraction/parsing; this is not a transport-byte limit. |
| `refresh-primers.ts:144-152,327-343,354-363` | Tool summary strings for grounding, invocation accounting, answer update | Iterates child parts; sequential per-primer cleanup retires settled children. Tool outputs are not rendered into grounding summaries. |
| `P/features/magic-context/dreamer/hidden-single-shot.ts:63` and `refresh-primers.ts:240-271` | Alternate hidden completion prompt/text/messages | Same seed and prompt; no origin read. Completion messages are host-owned child output, not an origin transcript; no universal byte bound here either. |
| `PI/dreamer/index.ts:496-618` | Pi facade's `sessionsById`, extracted prompt, two synthetic result messages, tool summaries | Holds the new child's user prompt and result, deletes the facade session at teardown. Does not load origin history again. |
| `PI/subagent-runner.ts:1228,1344,1367,1426,1454,1508,1537` | Argument/stdin prompt, stdout line/parsed event, `accumulatedMessages`, optional `agentEndMessages`, accounting aliases | Prompt size follows the seed. Stderr is clipped to **16,000 characters**. Stdout lines and the child's own accumulated messages have **no general byte cap**; they scale with this fresh investigation's output, not automatically with the historical origin's message count. No change to this general child transport in this follow-up. |
| `PI/subagent-runner.ts:2206,2243,2320` | Final assistant text join, completed-tool map/list, tool count | Derived from the fresh child above; no origin-session render/join. A model that deliberately reads huge current files can still require substantial memory. |

## End-to-end experiment

The fixtures are real throwaway SQLite/JSONL stores, not a provider returning a small fabricated array. Both candidate and primer have project identity `git:primer-heap-fixture`; the session and executor directory is `/fixture/primer`.

* Small: 500 turns, 1,000 OpenCode raw messages; Pi has 1,500 message entries / 1,001 canonical raw messages (the final tool result creates a synthetic user slot).
* Large: 5,000 turns, **10,000 OpenCode messages**; Pi has **15,000 message entries / 10,001 canonical raw messages**. Each of 5,000 tools has **16,384 ASCII bytes** of output and **40 diagnostics**. Tool output alone is 78.125 MiB. Fixture generation writes incrementally; it is outside the measured task window.
* Runtime: Bun 1.4.2, Darwin. Tokenizer warmed and `Bun.gc(true)` called before the task. `process.memoryUsage().heapUsed` sampled every 25 JSON parses and at task progress / model-client lifecycle boundaries. No forced GC during the task. Timers alone would miss synchronous reader spikes. These are **sampled JS heap high-water marks**, not RSS/native SQLite memory or a claim to observe every allocation. `0.00` delta means no sample exceeded the pre-task baseline, not zero allocations.
* The model client is deterministic: receives the real prompt, returns a grounded answer and a 16 KiB child-tool result. The test asserts the answer was persisted and the child deleted, along with U:/TC: evidence, absence of output/diagnostics, and a prompt below 30,000 characters. Thus a silent closed-book/no-op task cannot satisfy the test.

| Path | Fixture | Before MiB | Sampled peak MiB | Increase MiB |
| --- | --- | ---: | ---: | ---: |
| OpenCode paged, delivered | 1,000 | 19.71 | 19.71 | 0.00 |
| OpenCode paged, delivered | 10,000 | 20.35 | 20.35 | 0.00 |
| OpenCode whole-reader mutation | 1,000 | 19.71 | 19.71 | 0.00 |
| OpenCode whole-reader mutation | 10,000 | 20.33 | 107.34 | **87.01** |
| Pi paged, delivered | 1,001 raw | 19.72 | 44.71 | 24.99 |
| Pi paged, delivered | 10,001 raw | 20.49 | 46.56 | **26.06** |
| Pi original factory mutation | 1,001 raw | 19.72 | 59.99 | 40.27 |
| Pi original factory mutation | 10,001 raw | 38.97 | 194.24 | **155.27** |

The delivered Pi run parsed 3,381 JSON values at both fixture sizes; OpenCode parsed 1,380 at both sizes. The capped seed does the same work despite a tenfold increase in stored history. Prompt lengths were likewise identical between sizes: 12,573 Pi / 12,423 OpenCode. Restoring the old Pi factory gave 30,007 parses on the large fixture (discovery plus full load); restoring OpenCode full hydration gave 35,005.

The tests reject a large-fixture heap increase above **48 MiB**, or an increase over the small fixture's delta above **32 MiB**. These tolerances allow allocator/GC variation, while rejecting the measured old paths decisively. They are empirical regression envelopes, not an asymptotic proof by themselves; the page/cap trace supplies the structural explanation.

### Discovery specifically

The installed Pi 0.83.0 host is not header-only: `dist/core/session-manager.js:440-508` streams each file but collects `allMessages` (user/assistant text) at line 482 and returns `allMessagesText: allMessages.join(" ")` at line 507. `listAll` at lines 1289-1331 retains these previews across files, with up to ten concurrent builders (`:514`). The old-factory mutation measures that discovery inside the task, not outside its measurement window. The new factory never calls it. Header-only discovery and stopping before a deliberately oversized tail have separate tests; default host-root/subdirectory discovery is also tested in a throwaway root.

## Red-first and mutation controls

* Before implementing Pi paging, the new end-to-end test failed: large delta **178,883,897 bytes** against the original 24 MiB threshold. The final thresholds were widened for normal uncollected parser allocation, then re-proved against the original factory: **162,811,371 bytes** still fails the final 48 MiB bound.
* OpenCode whole-reader mutation in `visitRawSessionMessages`: only **`OpenCode primer refresh peak heap does not grow with same-project history`** ran and failed (91,239,954 bytes); prompt and persistence assertions still succeeded.
* Pi original-factory mutation: only **`Pi primer refresh peak heap does not grow with same-project history`** ran and failed (162,811,371 bytes); prompt and persistence assertions still succeeded.
* Compartment test failed before SQL projection (110,082 serialized bytes entering JS versus <5,000). Removing SQL clipping after the fix failed **`primer fallback and surrounding context are clipped before entering JavaScript`** again, while the OpenCode heap test passed. The test inspects actual returned SQLite rows, not only already-clipped rendered output.
* Every deliberate regression was marked as a temporary mutation, applied after staging live changes, observed with a nonempty unstaged diff, then restored from the index with an empty unstaged diff. No mutation is delivered.

## Other dreamer tasks: remaining reads (not changed)

| Task / location | Whole historical session? |
| --- | --- |
| Pi retrospective: `PI/dreamer/retrospective-raw-provider-pi.ts:50-76,127-142`; `PI/dreamer/pi-session-api.ts:349-376` | **Yes.** Discovery still uses the host `listAll` previews. `loadUserEntries` calls full-file loader; the default is `readFileSync` + `parseSessionEntries`. User-only filtering and count caps happen after loading. The same full loading is used for since, overlap and oldest-message queries (`:84,107,120`). This remains a separate risk. |
| OpenCode retrospective: `P/features/magic-context/dreamer/retrospective-raw-provider.ts:445-469,505-554` | **No full session read.** SQL limits message rows (80/session default, plus truncation sentinel; overall 240 messages / 20 sessions at `:15-20`). Overlap is also a limited window. But selected parts are loaded with full `data` before privacy filtering, so a single huge tool output/metadata payload can still cause a spike. |
| Map-memories: `P/features/magic-context/dreamer/map-memories.ts:381-420` | No origin history reader. Fetches **100 messages of its new child** at `:402-405`, maps current memories/source files. |
| Verify / verify-broad: `P/features/magic-context/dreamer/verify.ts:362-407` | No origin history reader. Fetches **100 child messages** at `:383-385`. |
| General task / retrospective children: `P/features/magic-context/dreamer/task-executor.ts:1360,1821` | Child-session result fetches, not historical origin reads. |
| Failed-child accounting: `P/features/magic-context/dreamer/failed-invocation-evidence.ts:24-47` | At most **200 child messages**, 5-second read deadline. Full individual part payloads remain possible. |
| Shared Pi dreamer client / subprocess runner | The fresh-child accumulators listed above apply to other tasks too, not only primers. Left unchanged. |

A search of the dreamer implementation found no remaining direct `readRawSessionMessages` / `readRawSessionMessagesFromDb` callers; primer seed uses the visitor. Those whole-read APIs still exist for non-dreamer callers and generic providers. This report does not claim the rest of historical loading has been redesigned.

## Verification and isolation

The plugin and Pi package suites, their `typecheck` and `lint` scripts, the focused heap/differential tests, and the mutation controls are the gates used for this change. The final gate is `bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only origin/master HEAD`, comparing serialized transform output between master and the committed change with no native daemon. Its terminal result is reported with the commit SHA in the task's final verification record.

All test runs use the repository preload's throwaway data/config roots; OpenCode fixture access uses a temporary `OPENCODE_DB`. No production OpenCode/Magic Context database or user OpenCode/CortexKit config was opened. No migration, schema change, GitHub post, or architecture/structure-document edit is part of this change.

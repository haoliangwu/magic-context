# OpenCode 2 adapter: read sessions through the server API, or keep opening `opencode.db`?

Investigation only. No product code changed. Evidence comes from the OpenCode 2.0.15 CLI bundle at
`~/.local/share/cortexkit/e2e-bin/opencode-cli/2.0.15/` (strings of the compiled binary), the
`@opencode/client@2.0.15` and `@opencode/plugin@2.0.15` packages, the live `/openapi.json` of a
throwaway 2.0.15 service, and runs of the probe committed beside this report:

- `packages/e2e-tests/scripts/probes/oc2-api-vs-store.ts` boots `opencode serve --service` from the
  shared 2.0.15 CLI on a private root under `$TMPDIR/magic-context/oc2-api-vs-store/`, builds a
  20,000-row session, measures API reads against `V2StoreReader`, runs the re-entrancy plugin,
  checks what a plain `opencode serve` registers, and (with `--v1`) converts a store written by the
  1.18.30 binary.
- `packages/e2e-tests/scripts/probes/oc2-reentrancy-plugin/server.js` is the minimal plugin that
  calls the service's own API from inside the `context` hook.

Isolation: every host run used an allowlisted environment with `HOME`, all `XDG_*` roots,
`TMPDIR`, `OPENCODE_DB=opencode2.db` and `MAGIC_CONTEXT_STORAGE_DIR` under the throwaway root. The
probe lists the host's open files with `lsof -p <pid>` and fails if it finds any `.db` outside the
root or any path under the live OpenCode or Magic Context directories. Every run listed only
`<root>/XDG_DATA_HOME/opencode/opencode2.db{,-wal,-shm}`. No live store was opened, and the live
`service.json` was never read.

## Short answer

**Stay on the store reader as the primary read path. Do not switch, fully or with a fallback.**

- The API returns the same rows in the same order and shape, including everything before the
  compaction. However, it exposes no position (`seq`), no count, no update stamp and no multi-type
  filter. Every ordinal the adapter depends on would have to come from walking the session from the
  start (101 requests and 16.6 MB for 20,000 rows) or from a new id-to-ordinal index that we would
  have to persist.
- The adapter's raw-message interfaces are **synchronous**. Calling the service from inside a hook
  works when awaited. A synchronous (blocking) call from the hook **deadlocks until it times out**,
  because the service answers on the thread the hook is blocking. Switching therefore means making
  the shared transform, historian, `ctx_expand` and tail-boundary read paths async.
- The API is not always present. `opencode acp` always runs a private server with no registration,
  and so do `--standalone` and a plain `opencode serve`. The store reader stays necessary, so
  "switch with a fallback" means two readers to maintain indefinitely.
- The costs we attributed to reading the store mostly come from how `V2StoreReader` maps ordinals
  to `seq` (`LIMIT 1 OFFSET n` subqueries), not from the store itself. A cold pass over 18,181 raw
  rows takes 3.5 s through `messagePage`, 0.1–0.3 s paging by `seq` from the same store, and 0.48 s
  through the API.

---

## Checking the claims from the other port (upstream/v2 `cc9011c1ae`) against the 2.0.15 bundle

The other port's findings were read against upstream source. They were re-checked here against
the shipped 2.0.15 binary and live runs:

| Claim | 2.0.15 verdict | Evidence |
|---|---|---|
| Service mode is the default; TUI, `run`, `mini`, `models`, `reload`, `api`, `auth`, `stats` and the session commands go through `ServerConnection.resolve` → `Service.ensure` → `serve --service` | **Confirmed**, with one omission | `cli.server-connection.resolve` (`us`) calls `Le.ensure({...ci()})`; `ci()` builds `command: [...execPath, "serve", "--service"]`. Every listed command calls `us`. **Omission: `opencode acp`** does not call `us`. It imports `dj` from the standalone chunk (`cli.standalone.endpoint`, which spawns `serve --stdio --port 0`) and calls it unconditionally, so ACP never has a registration. |
| Only a service-mode server writes the registration, from inside the serving process during `onListen`, so `pid === process.pid` identifies our own server | **Confirmed** | In `serve`, `o = mode==="service" ? ci() : undefined`, and `onListen` calls the writer only when `o` is set. The writer builds `{id, version, url, pid: process.pid, password}`, writes a temp file and renames it into place. Measured: `registration.pid === child.pid` on every service run. |
| Only three modes leave no registration: plain `serve`, `--standalone`, `--server` | **Incomplete** | `acp` is a fourth, as above. `--server` is a client flag; our plugin runs in whichever server the client connects to, so whether a registration exists depends on how *that* server was started. |
| Don't read the file synchronously during setup; before `onListen` it may still name the previous server; wait until the pid matches and re-check on reconnect | **Advice holds; the race did not reproduce in 2.0.15** | Probe: I planted a stale `service.json` (pid 1) and booted `serve --service` with a plugin that reads the file in `setup` and polls it. The plugin is loaded lazily on the first location request, after `onListen`, and it saw its own pid at setup. The race is still possible in principle (the file is written in `onListen`, and plugin load timing is not a contract), so match on pid and never cache a mismatch. The writer also re-reads the file every 5 s and **shuts the service down** when the file no longer matches; that is why a live registration always names its writer. `discoverOwnHostService` already reads per call and matches on pid. |
| Session list with `parentID` | **Confirmed** | `GET /api/session?parentID=` listed 3 imported children, with cursor paging (default 50). |
| `GET /api/session/:id/message`, paged, NO compaction bound | **Confirmed** | See section 1. An ascending walk returned all 20,000 rows, including the 14,000 before the compaction row. The page maximum is 200. |
| `GET /api/session/active` | **Confirmed, but it is not a history route** | "Foreground Session drains currently owned by this OpenCode process". It returned `{"data":{}}` when idle. It covers none of the adapter's reads. |
| `DELETE /api/session/:id` with a recursive child cascade | **Confirmed** | On a throwaway copy, deleting the 20k parent returned 204 in 1.2 s. All 3 children then returned 404, and `session_v2`/`session_message` held no rows for any of them. |
| Experimental resumable log `GET /api/experimental/session/:id/log` | **Exists, but it cannot serve history** | It is an SSE stream of the durable `event` table ("events after an exclusive aggregate sequence", `follow=true` for live). On both imported and prompted sessions it returned only `{"type":"log.synced","seq":N}`. After projection the `event` table held **0 rows**, so there is nothing to replay. In a follow stream, a new synthetic input produced only a new `log.synced` watermark (12 → 13). Its `seq` is the event aggregate sequence, not the `session_message` position. It is also experimental. |
| Ruling: use the server API for all of these, never read `opencode.db`, require `--service` | **Does not fit this adapter** | The other port's needs (listing, deleting, following) are covered by the API. Ours are positional and synchronous (section 1, section 3), and requiring `--service` disables us under `acp`, `--standalone` and plain `serve` (section 4). Where our needs match theirs we already use the API (child deletion) or could (see section 5). |

The message route against our five needs, on the 20k session (details in sections 1–3):

- **Stable order:** yes. The ascending walk equals `seq` order.
- **A position usable as an ordinal:** **no**. Rows carry no `seq` or index, and the cursor is an opaque, id-keyed anchor.
- **Lookup by id:** yes (`/message/{id}`), but it returns no position.
- **Count:** **no route**. It takes a full walk: 101 requests, 16.6 MB, 614 ms.
- **Cost:** see section 2.
- **Re-entrancy mid-prompt:** awaited calls work; a synchronous call deadlocks (section 3).

## 0. When is the API present? (the service-mode claim, checked against the 2.0.15 bundle)

The operator's reading is **mostly right, with one correction and one addition**.

Where the registration comes from:

- `serve` command: `mode: e.service ? "service" : e.stdio ? "stdio" : "default"`. The registration
  file is resolved and written only when `mode === "service"` (`o = e.mode==="service" ? yield* ci()
  : void 0`, then `onListen … z({address, password, id, file: o.file, …})`).
- Client `service.ensure` default: `e.command ?? ["opencode","serve","--service"]`. This matches
  `@opencode/client` `EnsureOptions.command`, documented as "Defaults to `opencode serve
  --service`". The CLI's own `ci()` helper builds `command: [...execPath, "serve", "--service"]`.
- Every interactive CLI entry point resolves its server through `cli.server-connection.resolve`
  (`us`):
  - `--server URL` connects to that URL;
  - `--standalone` calls `cli.standalone.endpoint`, which spawns `serve --stdio --port 0` with a
    random `OPENCODE_PASSWORD` and **no registration**;
  - otherwise it calls `Le.ensure(...)`, which starts or reuses `serve --service`.

What each mode starts, from the 2.0.15 bundle:

| Entry point | Server it uses | Registration (`service.json`) written? |
|---|---|---|
| `opencode` (TUI, the default command) | `us({standalone, mismatch:"replace"})` → service | yes, unless `--standalone` / `--server` |
| `opencode run …` | `us({server, standalone})` → service | yes, unless `--standalone` / `--server` |
| `opencode mini` | `us(…, mismatch:"replace")` → service | yes, unless flags |
| `session list/export/import/delete`, `models`, `stats`, `reload`, `api`, `auth …` | `us` → service | yes, unless flags |
| `debug agents`, `debug config`, `pair` | `Le.ensure(ci())` → service | yes, always |
| **`opencode acp`** | **`dj()` = the standalone endpoint, unconditionally** | **no, never** |
| `opencode serve --service` | itself | yes |
| **plain `opencode serve`** | itself | **no**. Measured: the private `XDG_STATE_HOME/opencode/` stayed empty and the host printed `server password …` on stdout instead. |
| `opencode serve --stdio` (what `--standalone` spawns) | itself | no |
| `--server URL` (any client) | a remote/explicit server | the plugin is loaded in *that* server, which may or may not be a registered service |
| Desktop app | not part of the CLI bundle | **not determinable from 2.0.15 sources.** The desktop app installed on this machine is 1.18.14 (a v1 host). A 2.x desktop that uses `@opencode/client`'s `service.ensure` with the default command would get `serve --service`. |

Correction to the operator's summary and to the other port's list: `opencode acp` is a further no-registration mode besides
`--standalone` and plain `serve`, and it has no opt-in. Editors that talk ACP to OpenCode 2 will
always load our plugin into a server with no registration.

"How common" cannot be quantified from source. There is no telemetry in the bundle we could read,
and the desktop build is not in hand. What the source does show: every default interactive path
(TUI, `run`, `mini`) uses the registered service. The no-registration paths are explicit
(`--standalone`, `serve` without `--service`) or ACP. Our own e2e harness is a no-registration
user: `spawnOpencode2` starts a plain `serve` unless `serviceMode: true` is passed, and only 2 of
the 36 test files that use it pass that option (`dream-loop`, `hidden-child-ga`).

The registration's `pid` is the serving process itself (`registrationPidIsHost: true`), which is
the process our plugin runs in. `discoverOwnHostService` (match on `process.pid`) found it from
inside the hook in every run.

## 1. Coverage: every read the adapter does, and the API route for it

Relevant routes in 2.0.15 (from `/openapi.json` and the handler code):

- `GET /api/session/{id}/message` (`session.message.list`) returns
  `{ data: Session.Message.Info[], cursor: { previous, next } }`.
  - Paging: `limit` default **50**, minimum 1, maximum **200** (`limit=201` is rejected with 400).
  - Order: `order` is `asc` or `desc` (default `desc`).
  - Cursor: opaque base64url of `{ id, order, direction }` for the first and last row of the page,
    keyed by **message id**. It cannot be combined with `order` (400).
  - Type filter: a single `type` from agent-switched, model-switched, location-switched, user,
    synthetic, system, skill, shell, assistant, compaction. **`idle` is not accepted** (400), and
    the filter takes one type only (a repeated `type` is rejected).
- `GET /api/session/{id}/message/{messageID}` (`session.message.get`) returns one message. It
  returns 404 `MessageNotFoundError` for an id not in the session.
- `GET /api/session/{id}/context` (`session.context`): "all messages after the last compaction",
  unpaged.
- `GET /api/session?parentID=…` (`session.list`): `limit` default 50, cursor paging, `limit=0`
  rejected. Its larger-limit behaviour is not validated in the schema: 500 and 1000 were accepted.
- `GET /api/experimental/migration/v1`: `{status: required | running | completed | error}`.
- `GET /api/experimental/session/{id}/export`: the complete transcript in one response.

What the rows look like: an API message is exactly the stored row's `data` plus `id` and `type`.
The probe compared all 20,000 rows field by field against `V2StoreReader.history()` and found
**0 shape mismatches**. There is **no `seq`, no `session_id`, no `time_updated`** on any API row.
An ascending unfiltered walk returned the 20,000 rows **in exactly `seq` order** (the probe uses
random ids, so this is not id order).

| Adapter read today (`V2StoreReader`) | Used by | API equivalent | Gap |
|---|---|---|---|
| `messagePage(after ordinal, limit, watermark)`: raw rows by ordinal | historian chunks, indexer reconciliation, `ctx_expand` ranges, tail boundary (`createV2RawMessageReader.readPage`) | `message.list` asc, walked from a cursor | Cursors are id-keyed, not ordinal-keyed. Reaching ordinal *k* needs either the id of ordinal *k*−1 (known only if we store it) or a walk from the start. Raw rows span 6 types, so pages must be unfiltered and filtered on the client. |
| `messageCount`: raw count | watermark for every pass | **none** | Only a full walk. Measured: 101 requests, 16.6 MB, 614 ms median. `session.get` carries no count. |
| `storedMessageCount`: all rows | ordinal drift detection | **none** | Same full walk. |
| `messageById` | `ctx_expand`, served-boundary lookup, boundary resolution | `message.get` | Equivalent, but without the row's position. |
| `messageExistsById` | `hasById` | `message.get` (200 or 404) | Equivalent. |
| `messageOrdinalById` | `ordinalOf`, `findById` | **none** | No position is exposed. Needs a walk or a persisted index. |
| `messageIdOrdinals(from, to)` | `ordinalMapForRange` | **none** | Same. |
| `messageOrdinalPage(after {seq,id})` including `json_valid(data)` | coordinate repair / ordinal page | `message.list` (partly) | No `seq` anchor, and there is **no way to enumerate invalid rows**: see "undecodable row" below. |
| `page` / `range` / `latestSequence` / `earliestSequence` / `sequenceForId` / `latestSequenceForIds` (all `seq`-based) | fold restore (`restore-rows.ts`), refusal recovery (`readRowsFrom`), compaction hook watermark, hidden-child baseline | `message.list` with id cursors | Everything expressed in `seq` has to be re-expressed in message ids. The compaction hook's "latest seq among these ids" becomes "the newest of these ids in a desc walk". |
| `spanRowStamps(after, through)`: id + `time_updated` + byte length per row, no decode | `RestoredRowCache` invalidation | **none** | No `time_updated` on API rows. The closest substitute is hashing the returned JSON, which needs the full payload. |
| `rawRowsThrough(seq, limit)` (desc) | boundary user message, served boundary | `message.list` desc from an id cursor | Works once the anchor is an id. |
| `latestCompaction` / `latestRunningCompaction` (`json_extract(status)`) | usage recording, context hook, compaction hook | `message.list?type=compaction&order=desc` then filter `status` on the client | Covered, 1–2 ms. The filter is by type only, so a session with many failed or running compactions needs more pages. |
| `latestAssistant` / `latestIdle` | hidden-child completion polling | `message.list?type=assistant&order=desc&limit=1` for assistant rows. Idle rows need an unfiltered desc page. | Idle cannot be filtered. |
| `history` (every row) | store-generation conversion / F1 coordinate rebase (`readAllV2RawMessagesForConversion`) | full `message.list` walk, or `experimental.session.export` | Covered, but paged at 200. |
| `window` (from latest completed compaction) | not called outside tests today | `session.context` | Covered. `session.context` **starts at the compaction row and slices everything before it** (measured: 6,000 of 20,000 rows, first row = the compaction). Use it only when the post-fold window is what is wanted, never for ordinals. |
| Child sessions | not read from the store today. Hidden children are tracked in `context.db`; deletion already goes through `DELETE /api/session/{id}`. | `session.list?parentID=` | Covered. Measured: 3 imported children listed, cursor paging works. |
| Store generation (`assertOpenCodeStoreGeneration`: v1 `message`/`part` tables beside `session_message`/`session_v2`) | reader constructor | `experimental.migration.v1` status only | The API does not expose the schema, so there is nothing to detect. On the API path the question disappears, because the host reads its own tables. It returns while any fallback reads the store. |

Pre-compaction history: `message.list` is **not** sliced at the compaction boundary. An unfiltered
walk returned all 20,000 rows, including the 14,000 before the compaction row. Only
`session.context` slices.

Stable ascending order: yes (matches `seq`). A stable per-message position we could use as an
ordinal: **no**. The API's only stable handle is the message id, and its pages carry no index.

Undecodable row (checked on a throwaway copy with one row's `data` set to invalid JSON):

- any `message.list` page containing it returns **HTTP 500**;
- `message.get` for it returns 500;
- a cursor anchored on the bad row's id resumes after it;
- `session.context` still answered, because the bad row was before the compaction.

`V2StoreReader.decode` also throws on that row, so neither path tolerates it. The store can detect
the row without decoding (`json_valid`); the API cannot.

Unknown cursor id: a cursor for an id that is not in the session returns `{"data":[]}` with 200,
not an error. An anchor that disappeared (revert, deletion) therefore looks exactly like "nothing
new". Any API-based steady pass would need a separate existence check.

A limitation found while building the fixture: `experimental.session.import` inserts the whole
transcript as one multi-row `INSERT` with 7 bound parameters per row. It succeeds at 8,000
messages and fails with HTTP 500 at 10,000 (`EffectDrizzleQueryError: Failed query: insert into
"session_message" … values (?, …), …`). Payload size is not the cause (10 MB with 5,000 messages
succeeded; 1.9 MB with 12,000 failed). The probe imports 8,000 messages and appends the rest to the
projection table in the same shape while the host is stopped. The import route itself writes no
`event` rows, so the result is the same as an import.

## 2. Cost

Setup: one session of **20,000 rows**:

- 18,181 raw rows (user and assistant, every third assistant with a tool result);
- 1,818 idle rows;
- one completed compaction at row 14,001;
- 30 MB store.

Host: 2.0.15 `serve --service` on loopback. The probe runs each read once cold ("first"), then 5
times and reports the median. It opens and closes a `V2StoreReader` around each page, as
`createV2RawMessageReader` does. Bytes are response bodies for the API and decoded `data` JSON for
the store. Machine: Apple Silicon laptop shared with other workers, so treat single-digit
milliseconds as noise.

| Read pattern | Store (`V2StoreReader`, as used today) | API | Notes |
|---|---|---|---|
| **Full count** (raw) | **2.1 ms**, 0 B | **614 ms**, 16.6 MB, 101 requests (first: 1,206 ms) | The API has no count, so it walks every page. |
| **Cold first pass** (count + every raw row) | **3,512 ms**, 15.4 MB (first: 6,422 ms) | **480 ms**, 16.6 MB, 101 requests (first: 1,152 ms) | The store figure comes from `messagePage`'s ordinal-to-`seq` CTE (`ORDER BY seq LIMIT 1 OFFSET n`), which is linear in the offset on every page. The same store read with `page()` (`seq` > cursor, 200 rows) took **102–307 ms** (probe helper `t/seqpage.ts`, 4 runs, not committed). |
| **Steady pass** (2 new raw rows) | **34 ms**, 2.8 KB (count + `messagePage` at the tail, both OFFSET-bound) | **4.2 ms**, 165 KB (one desc page of 200 until the known last id). **1.1 ms**, 9 KB with `limit=10`. | By `seq` from the store (`latestSequence` + `page(after)`): **0.6–1.3 ms**. The API steady pass depends on already knowing the last id and assuming it still exists (see unknown cursor above). |
| **Historian chunk** (500 raw rows, ordinals 4,546–5,045) | **33 ms**, 422 KB, 5 pages | **12.7 ms**, 498 KB, 3 requests, **only if** the id of ordinal 4,545 is already known (hand-built cursor). **138 ms**, 4.6 MB, 28 requests if it must walk from the start. | The hand-built cursor relies on an undocumented cursor encoding (`{id, order, direction}`). |
| Lookup by id | 1.0 ms (row + ordinal) | 0.7 ms (row only, no ordinal) | |
| Latest completed compaction | 0.6 ms | 1.9 ms | |
| `session.context` | n/a | 131 ms, 5.0 MB (6,000 rows, unpaged) | Cost grows with the size of the post-compaction window. |

Converted v1 store: 1,000 messages were written by the real **1.18.30** host (29.6 s through its
`noReply` route), then the 2.0.15 service booted on the same file:

- `migration/v1` reported `completed`;
- the `message`/`part` tables were **still present** beside `session_v2`/`session_message`, which is
  the shape behind issue 493;
- `V2StoreReader` opened it (the current generation guard handles it);
- the API returned the same 1,000 rows in the same order, with 0 shape mismatches.

Costs were small at this size: store count 0.8 ms against 58.5 ms for the API walk; cold pass
18 ms against 98 ms; steady pass 2 ms against 3–17 ms. This session has only `user` rows (the 1.x
route used cannot write assistant rows without a model call), so it checks conversion and shape,
not the mix of row types.

Reading the table: the API is not slow for rows it streams, and it is faster than today's
`messagePage` on a cold pass. It is **orders of magnitude slower for anything positional** (count,
ordinal, ordinal range, "chunk N" without a stored anchor), and every positional read the adapter
does becomes a full walk. The store's slow paths are specific OFFSET queries in `store-reader.ts`,
not direct store access as such.

## 3. Re-entrancy: calling the service's API from inside the `context` hook

Demonstrated with `oc2-reentrancy-plugin` loaded in the throwaway service. The hook fires for a
real prompt (mock provider) on a fresh session. While the prompt waits on the hook, the plugin
calls the same service for **the same session**:

| Call from inside the hook | Result |
|---|---|
| `GET /api/session/{id}` | 200, 10–56 ms |
| `GET /api/session/{id}/message?order=desc&limit=5` | 200, 2–16 ms. It already contains the in-flight user message. |
| `GET /api/session/{id}/context` | 200, 1–2 ms |
| `GET /api/session/{id}/message/{in-flight user id}` | 200, 1–6 ms |
| Full walk of the 20,000-row session (101 requests) | 200, **2,609 ms**, 16.6 MB. The prompt waited for it and then completed (`user, assistant, idle:succeeded`). |
| In-process `context.session.context(...)` (the plugin surface) | 1–2 ms |
| **Blocking** call: `spawnSync(curl … --max-time 5)` to the same service | **HTTP 000, curl exit 28 (timeout) after 5,023 ms**. The prompt resumed only after the timeout. |

Conclusions:

1. There is no session lock on reads: reading the session that is mid-prompt works, and the hook
   sees the in-flight user message.
2. The service answers from the same JavaScript thread the hook runs on. An **awaited** `fetch`
   works because awaiting yields the event loop. Anything **synchronous** that waits for a response
   deadlocks until its own timeout, and the whole host (every session) is stalled for that time.
3. Every call the adapter makes to the service from inside the hook adds its latency to the prompt.
   A full walk added 2.6 s to this turn.

Point 2 is the decisive one for Magic Context. `BoundedRawMessageProvider`, `RawMessageProvider`,
`V2RawMessageReader`, `HiddenChildRows`, `RestoreRowReader` and the `hostRawMessages`/`readMessages`
seams passed to `rebaseSessionCoordinates` all return values synchronously, and they are consumed
by shared, synchronous code. An HTTP-backed reader cannot implement them. The switch is therefore
an async refactor of the shared transform paths, not an adapter swap.

## 4. No-registration cases (`--standalone`, plain `opencode serve`, and `opencode acp`)

In all three the plugin runs inside a server that wrote no `service.json`, so
`discoverOwnHostService` returns nothing:

- `--standalone` spawns `serve --stdio --port 0` with a private random password in the child's
  environment;
- a plain `serve` prints its password to stdout;
- `acp` uses the same standalone spawn.

The plugin cannot learn the URL or password from the plugin surface (`Context` has no client or
address; `context.app` carries name/version/channel only).

Recommendation for these modes: **keep the store reader. Do not refuse.**

- `acp` always takes this path, and it is a supported editor-integration entry point.
- Refusing would turn Magic Context off with no user-visible reason, for a mode the user did not
  pick for us.
- Our own e2e lane runs almost entirely in this mode.

Because the store reader must stay, any API reader is an additional implementation, not a
replacement. That is the main reason the recommendation below is "stay".

The existing hidden-child deletion already degrades correctly here: it throws
`HostServiceUnavailable` and retries later. That behaviour needs no change.

## 5. Recommendation

**Stay on the store reader.** Reasons, in order of weight:

1. **The adapter is synchronous end to end, and a synchronous HTTP call deadlocks** the host it
   runs in (shown above). Switching requires making every raw-message consumer async (list below),
   including code shared with the v1 and Pi hosts.
2. **The API has no position.** Ordinals, counts, ordinal ranges, `seq` watermarks and row stamps
   have no route. Each becomes a full walk (0.6 s, 16.6 MB and 101 requests per 20,000 rows),
   unless we build and persist our own id-to-ordinal index. That index would have its own staleness
   problems: reverts, and cursors on vanished ids that silently return empty pages.
3. **A store fallback is mandatory** (`acp`, `--standalone`, plain `serve`, most of our e2e lane),
   so "switch with a fallback" doubles the read surface instead of removing coupling to
   `session_message`.
4. **The measured store costs come from specific queries, not direct access.** The cold pass
   (3.5 s at 18k raw rows) and steady pass (34 ms) are dominated by `messagePage`/`messageCount`
   OFFSET-based ordinal mapping. The same store paged by `seq` does the cold pass in 0.1–0.3 s and
   the steady pass in about 1 ms. Issue 493 (generation detection on converted stores) is handled
   by the current guard: a real 1.18.30 → 2.0.15 conversion opened cleanly in this investigation.

What the API is good for, and where it could be adopted without a switch (suggestions only, not
done here):

- hidden-child completion polling (`latestAssistant`/`latestIdle` in `hidden-completion.ts`). It is
  already async, and it only runs where a registration exists, because child deletion needs one
  anyway;
- `experimental.migration.v1` as a cheap "conversion finished" signal before the F1 rebase.

If the decision is ever to switch anyway, these call sites change. Each moves from a synchronous
`V2StoreReader` to an async, id-anchored API reader, plus an ordinal index:

- `packages/plugin/src/v2/store-reader.ts`: the reader itself (every method listed in section 1).
- `packages/plugin/src/v2/hooks/store.ts`:
  - `createV2RawMessageReader`: readPage, findById, findPartsById, hasById, ordinalOf,
    ordinalMapForRange, readOrdinalPage, getCount, getStoredCount, servedBoundaryIdOf;
  - `createV2RawMessageProvider`;
  - `servedBoundaryRow`;
  - `resolveV2BoundaryUserMessage`;
  - `readAllV2RawMessagesForConversion`.
- `packages/plugin/src/v2/hooks/context.ts`, `openStoreReader` / `new V2StoreReader(…)` at:
  - l.471: hidden-completion `openReader`;
  - l.553–557: `pagedRead`, `readAllForConversion`;
  - l.560: `readRowsFrom` (refusal recovery: `sequenceForId`, `range`, `latestSequence`);
  - l.590: usage recording (`latestAssistant`, `latestCompaction`);
  - l.772: compaction hook (`latestSequenceForIds`, `latestRunningCompaction`);
  - l.877: `rebaseSessionCoordinates({ readMessages: readAllForConversion })`;
  - l.947: `setBoundedRawMessageProvider(createV2RawMessageProvider(pagedRead, …))`;
  - l.1014: Rust compaction-marker boundary;
  - l.1051: `createHostSeams(…, readAllForConversion, pagedRead, …)`;
  - l.1058–1121: context-hook fold restore (`latestCompaction`, `sequenceForId`,
    `earliestSequence`, `servedBoundaryRow`, `restoredRows.rows`).
- `packages/plugin/src/v2/hooks/restore-rows.ts`: `RestoredRowCache` (`page`, `spanRowStamps`).
- `packages/plugin/src/v2/hidden-completion.ts`: `HiddenChildRows` (`latestSequence`,
  `latestAssistant`, `latestIdle`) at l.548, 824, 907, 946.
- Synchronous consumers of the bounded provider that would all have to become async:
  - `hooks/magic-context/read-session-chunk.ts` (`RawMessageProvider`,
    `BoundedRawMessageProvider`, every `readRawSession*` helper);
  - `read-session-raw.ts`;
  - `protected-tail-boundary.ts`;
  - `module-state-sync.ts`;
  - `module-wire.ts`;
  - `compartment-runner-incremental.ts`;
  - `compartment-runner-recomp.ts`;
  - `hook-handlers.ts`;
  - `features/magic-context/storage-db.ts` (message-index reconciliation `readPage`/`getCount`);
  - `features/magic-context/message-index-async.ts`;
  - `features/magic-context/store-generation-rebase.ts` (`readMessages`);
  - `features/magic-context/dreamer/primer-seed.ts`;
  - `tools/ctx-expand/render.ts`.
- `packages/plugin/src/shared/opencode-db-path.ts`: generation detection. It stays for the
  fallback.
- `packages/plugin/src/v2/host-service.ts`: discovery is reused as is. It would need a per-call
  timeout policy, because each call inside the hook adds to prompt latency.

## Reproducing

```sh
bun packages/e2e-tests/scripts/probes/oc2-api-vs-store.ts --messages 20000 --v1
# MC_PROBE_V1_MESSAGES=1000 sets the size of the 1.x-written session; MC_E2E_OPENCODE1_CLI picks the 1.x binary.
```

The probe prints and saves `result.json` under `$TMPDIR/magic-context/oc2-api-vs-store/main-*/`.
The figures above come from `main-k619K8` (20,000 rows plus the v1 conversion). The blocking-call
row in section 3 comes from `main-jDZtqs`, a 2,000-row rerun made after the blocking check was
added to the plugin. The undecodable-row and child-session checks were run by hand against copies
of the probe's store under `$TMPDIR/magic-context/oc2api/edge/`, using the same allowlisted
environment and `lsof` check.

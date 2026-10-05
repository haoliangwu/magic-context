# Issue 584: `/ctx-status` crash and the v85 → v91 migration under a live 0.42.6 server

Reporter: OpenCode 1.18.33 on Windows 11, plugin 0.44.4, upgraded from 0.42.6.
The TUI crashed with `undefined is not an object (evaluating 'view().headline')`
at `src/tui-compiled/dialogs/status-dialog.tsx:534`, and the reporter thought
their Magic Context data was gone.

## Summary

- **No data was lost.** Doctor shows 72 compartments and 188 memories in the
  native Windows `context.db`. The project identity audit found nothing that
  applies to this report, so it is not covered here.
- **Defect 1: the migration guard failed open on Windows.** A 0.44.4 process
  migrated the shared store from v85 to v91 while a 0.42.6 OpenCode server
  (PID 10376) was still running. The guard saw the live PID, could not check
  its identity, and continued. This branch makes Windows start times
  available (the likely root cause). What the guard does when a start time is
  still unavailable (a health probe or a name check) is pending the operator,
  and the guard's behavior is unchanged.
- **Defect 2: the status dialog crashed on any reply without a usable
  snapshot.** The reply most likely came from the 0.44.4 server's own
  home-directory instance, not from the stale 0.42.6 server (see "Where the
  crash payload came from"). The dialog now shows a "Status unavailable" view
  that names the reason. It also names an older server that is still running.

## The reporter's log (https://api.pastes.dev/EymM6ebDm4)

| Line | Time | Event |
| --- | --- | --- |
| 1–94 | until 10:15:53 | Session `ses_149d…` runs on 0.42.6 (store at migration lane 85). |
| 95 | 10:23:18 | New process PID 9352 (0.44.4) boots for `dir=~` (the home directory). |
| 99 | 10:23:20 | `storage warning: continuing migration …; OpenCode server PID 10376 was not confirmed because its liveness or identity check could not run.` |
| 101–108 | 10:23:20 | Migrations v86–v91 applied; lane now 91. |
| 110 | 10:23:20 | `not binding a project identity for this directory` (the home instance). |
| 112 | | `guard=487ms` |
| 114 | 10:23:21 | `another Magic Context RPC server is active for this project (pid 10376, port 52206)` |
| 121–122 | 10:23:37 | `home project memory disabled`, then the same PID boots for `~\Pictures\Camera Roll\VikStudio\TGroup`. |
| 127, 139 | | TGroup binds `dir:c37b5eb6bc68`; memories for it are embedded. The data is present. |
| 133 | | 0.42.6 PID 10376 also has an RPC server for TGroup (port 59480). |
| 135 | 10:23:56 | `command ctx-status: pushed show-status-dialog to TUI`, and the TUI crashes. |

## Defect 1: the migration guard continued under a live older server

### Which check

The boot opens the store through `openDatabaseAsync`
(`packages/plugin/src/features/magic-context/storage-db.ts`). Because the
store's version (85) was behind the build (91), it takes one process snapshot
with `inspectProcessesAsync()` (`shared/rpc-utils.ts`) and calls
`enforceMigrationOnOpenGuard` → `inspectRpcServerDiscovery`. For every RPC
discovery record (`<storage>/rpc/<project>/port-<pid>*.json`), that function
checks two things:

1. **Liveness**: `processes.liveness(pid)`. On Windows this comes from the
   snapshot: first a CIM query (`powershell Get-CimInstance Win32_Process`),
   then `tasklist /FO CSV /NH` as the fallback. PID 10376 was in the snapshot,
   so it was `"alive"`.
2. **Identity**: `isPidIdentityPlausible(record, evidence)`. It guards against
   a reused PID. Every real record carries `started_at` (checked against
   records written by a real 0.42.6 server). For such a record the check
   compared the process start time with `started_at`, and **returned
   `"inconclusive"` when no start time was available**.

tasklist reports image names only, never start times. When CIM does not
answer, every live holder is therefore `alive` and `inconclusive` at the same
time. The 573 change kept those records rather than deleting them, but
`enforceMigrationOnOpenGuard` treats `inconclusive` like `absent`/`stale`:
it logs line 99 and migrates. Two tests show this behavior: the existing unit
test `uses tasklist for the Windows command fallback and skips unavailable
start time` expected `"inconclusive"` for a tasklist-confirmed `OpenCode.exe`,
and the 573 regression used `started_at: 0`, which takes a different branch.

`kill(0)`/`ps` in the log message comes from the POSIX wording. On Windows the
guard calls neither of them.

### Why CIM gave no start time on the reporter's machine (not proven)

No Windows host was available, so this part is inference, not observation.
Any of the following leaves the guard with tasklist-only evidence, or with a
CIM row whose `CreationDate` does not parse:

- **PowerShell unavailable or blocked.** `powershell` is missing from the
  PATH OpenCode was started with, or AppLocker or antivirus kills it. A
  `guard=487ms` boot is fast for a cold PowerShell and CIM query, which
  usually takes more than a second. That points to a quick failure followed by
  the tasklist fallback.
- **`CreationDate` serialization.** The query piped a raw `DateTime` into
  `ConvertTo-Json`. PowerShell 7 emits a local-offset ISO string, and Windows
  PowerShell 5.1 emits `\/Date(ms)\/`. For a `DateTime` with extended
  properties, 5.1 emits an object:
  `{ "value": "\/Date(ms)\/", "DisplayHint": 2, "DateTime": "…" }`. The parser
  returned `null` for the object form, which made the identity check
  inconclusive even though CIM had worked.
- **Output size (synchronous callers only).** Bun's `execFileSync` throws
  `ENOBUFS` above its 1 MiB default output limit (verified locally). A full
  `Win32_Process` listing with command lines can exceed that on a busy
  desktop. The synchronous snapshot (`inspectWindowsProcessesSync`, used by
  the synchronous `openDatabase` path and doctor) then fell back to tasklist.
  The asynchronous boot path already allowed 8 MiB.

### Fix (in this change)

These changes make process start times available on Windows, which removes
the root cause on the reporter's machine:

- The CIM query formats `CreationDate` itself
  (`$_.CreationDate.ToUniversalTime().ToString('o')`), so the output no longer
  depends on the PowerShell edition. The parser also accepts the 5.1 wrapped
  object.
- Synchronous process-list commands get an 8 MiB output limit, matching the
  asynchronous path.

Pending the operator's decision: what the guard does when a record has a
start time but the process start still cannot be read (tasklist-only
evidence, or a denied probe). It currently returns "inconclusive" and
continues, as before. The options are the RPC `/health` probe or a
command-name check. A name-check fallthrough was drafted and has been removed
from this branch until that decision is made.

Tests. These are unit tests against the Windows code paths (`platform:
"win32"`, faked `powershell`/`tasklist` output). They are not a real Windows
host.

- `rpc-async-probes.test.ts` › `Windows PowerShell 5.1 wrapped creation dates
  still prove a holder's identity`.
- `rpc-utils.test.ts` › `the synchronous Windows process list allows more
  output than the 1 MiB default`. `uses tasklist for the Windows command
  fallback and skips unavailable start time` keeps master's expectation
  ("inconclusive" without a start time) and now also checks the ISO
  `CreationDate` query.

### Proposal (not implemented): when liveness truly cannot be determined

This covers the case where no process list is available at all: a sandbox
denies `kill(0)` and `ps`, or both CIM and tasklist fail. Today the guard logs
and continues.

| Option | Cost | Benefit |
| --- | --- | --- |
| A. Continue (today) | Reproduces this incident whenever the probe is blind and an older server is alive. | Sandboxed hosts (Flatpak, some CI, hardened Windows) are never blocked. |
| B. Refuse | Every sandboxed user is blocked on each upgrade until they delete RPC records by hand. The refusal cannot tell a dead record from a live server. | No store is ever migrated under a live older build. |
| C. **Ask the RPC server itself (recommended).** The record already holds `port` (and `token`). A `GET http://127.0.0.1:<port>/health` succeeds only if that server is alive, and its body carries `pid` (and `instance_id`), which must match the record. The TUI's RPC client already does this (`rpc-client.ts` `healthCheck`). Refused connection: dead, delete the record. Matching reply: live, refuse. Timeout: fall back to A or B. | Adds up to one short loopback request per blind record at boot. Needs an async guard, which the boot path already is. | Needs no process-inspection permission, so it works in the sandboxes that motivated option A. It confirms exactly the server that holds the store. |

Recommendation: C, with option A as the timeout fallback, keeping today's log
line. A blind probe then continues only when the recorded server also does not
answer on loopback, which is much weaker evidence of a live holder than a PID
nobody could check. Since this change, the dialog also reports a migration
that continued past an unchecked holder (below), so the remaining risk is
visible to the user.

## Defect 2: the dialog crash

### Where the crash payload came from

The brief assumed the TUI read the stale 0.42.6 server's reply. The evidence
points elsewhere:

- The TUI's RPC client prefers the RPC server in its own process
  (`shared/rpc-client.ts`, `readPortFiles` sorts `pid === process.pid`
  first). It binds to the directory the TUI started in
  (`tui/index.tsx`: `initRpcClient(api.state.path.directory)` at plugin
  start). PID 9352 booted for `~` first (log line 95), so a TUI started in the
  home directory talks to 9352's home instance.
- 9352's home instance answers `status-detail` for the home directory with
  `{ sessionId, disabled: true }`. That branch exists since 0.44.3; 0.42.6
  had none.
- Replayed on a real OpenCode 1.18.30 TUI (throwaway root, mock provider),
  that reply gives the crash with the same message and the same frame,
  `status-dialog.tsx:534:36` in the `_$effect` at `:531:5`.
- A real 0.42.6 server gives something else. Its complete reply renders fine
  in the 0.44.4 TUI. After a newer build migrates the store under it
  (reproduced by migrating the throwaway store to v91 while it ran), it
  answers `{"error":"unavailable"}`, and the 0.44.4 TUI showed the MC-S01
  toast. Neither crashes.

The directory the reporter's TUI started in is not in the log, so this is the
best-supported path, not a certainty. Either way the fix covers it.

### What each payload does (real OpenCode 1.18.30 TUI, before and after)

Every host run used a throwaway root under
`$TMPDIR/magic-context/issue-584/<case>` (`XDG_*`, `OPENCODE_DB`,
`MAGIC_CONTEXT_STORAGE_DIR`, `HOME` for the home case) and the mock provider.
For each run, `lsof -p <opencode pid>` showed every open `.db`/`-wal`/`-shm`
under that root.

| Payload | 0.44.4 before | After |
| --- | --- | --- |
| RPC error envelope (Rust mode without a module): `{ error }` | MC-S01 toast, no dialog | Dialog: "Status unavailable · server did not answer", with the server's error text |
| Transport failure or timeout | same toast branch (by code) | same unavailable view |
| Home directory: `{ sessionId, disabled: true }` | **crash, `view().headline`** | "Status unavailable · home directory", naming `allow_home_project` |
| Paused identity (`.git` pointing nowhere): `{ sessionId, disabled: true, paused: true }` | **crash, `view().headline`** | "Status unavailable · memory paused", pointing at `magic-context.log` |
| Empty or partial reply | crash (unit) | "incomplete status data", listing the missing fields |
| 0.42.6 server, v85 store | renders; no hint the server is older | renders, plus "An older Magic Context server (one too old to report its version) is still running … quit all OpenCode processes, then start OpenCode again" |
| 0.42.6 server after a v91 migration: `{ error: "unavailable" }` | MC-S01 toast | unavailable view: "server did not answer" |
| New session with little stored state | renders | renders |
| Session with no stored state at all (unknown ID, fresh store) | renders (unit, real `status-detail` handler) | renders |

The error the view memo threw first, for every crashing payload, was
`TypeError: undefined is not an object (evaluating
'source.usagePercentage.toFixed')` from `buildStatusView`. It shows in the
stack trace when the compiled dialog is rendered in Bun, where Solid runs the
memo eagerly. In OpenCode an error boundary catches each error; the crash
screen shows the last one, the effect reading `view().headline`.

### Fix

- `shared/status-view-check.ts` is the one place a status payload is checked.
  `checkStatusDetailPayload` classifies the RPC reply: error envelope,
  `disabled`/`paused` reply, non-object, or snapshot. It checks every field
  `buildStatusView` reads through `checkStatusViewSource`. A missing or
  mistyped required field is named. An optional field with the wrong shape is
  dropped and listed in a warning. An unknown failure code is dropped, because
  `renderUserFacingFailure` throws on one. `buildStatusView` accepts only the
  branded `CheckedStatusViewSource` that the check produces.
  `buildStatusViewFor` returns the full view or `buildUnavailableStatusView`,
  catches anything that still throws, and never throws itself.
- `loadStatusDetail` (the TUI data layer, shared by OpenCode 1 and 2) returns
  only checked results. Both dialogs and the OpenCode 2 text fallback
  (`statusTextFor`) draw every result, including RPC failures, instead of a
  toast.
- Version: `status-detail` now reports `pluginVersion` on every reply,
  including `disabled` and error replies (`shared/plugin-package-version.ts`,
  found by walking up to the package manifest). The dialog compares it with
  its own version:
  - older server: "An older Magic Context (0.42.6) server is still running,
    while this UI is 0.44.5: quit all OpenCode processes, then start OpenCode
    again";
  - no version (every server up to 0.44.4): "An older Magic Context server
    (one too old to report its version) is still running …";
  - newer server: "Magic Context server is X, this UI is Y: restart
    OpenCode".
- A migration that continued past an unchecked holder is recorded
  (`getUnconfirmedMigrationHolders`), sent as `unconfirmedMigrationHolders`,
  and shown as an error line in the dialog: "Magic Context upgraded its
  database from v85 to v91 while OpenCode PID 10376 could not be checked. If
  an older OpenCode is still open, quit all OpenCode processes and start
  again."
- Pi's `/ctx-status` overlay runs its in-process snapshot through the same
  check (`checkLocalStatusSource`).

Tests: `status-view-check.test.ts` covers every payload above, including a
reply captured from a real 0.42.6 server. `tui/dialogs/status-dialog-render.test.ts`
renders the shipped compiled dialog for each case in a child process
(`scripts/render-compiled-status-dialog.ts`), which supplies the host runtime
registry from this package's own dependencies. A Bun plugin cannot be
unregistered, so this keeps the registry out of the tests that check it is
absent. It also covers the real `status-detail`
handler (`rpc-handlers.test.ts`) and a malformed Pi snapshot
(`pi-plugin/src/dialogs/status-dialog.test.ts`). Disabling the required-field
check and the `disabled` branch makes 8 of them fail, including the three
compiled-dialog render cases for home, paused and empty.

## Defect 3: the TUI asked the startup directory's server about every session

The reporter restarted with every `opencode.exe` killed, and the sidebar still
showed 0 compartments and 0 memories. The cause: the TUI calls
`initRpcClient(api.state.path.directory)` once at plugin start, and every
session-scoped RPC (sidebar snapshot, status detail, embed detail, compartment
count, recomp) went through that one client. OpenCode starts one Magic Context
server instance per directory. Non-git directories share OpenCode's global
project, so a TUI started in `~` lists sessions from, for example,
`~\Pictures\Camera Roll\VikStudio\TGroup` and opens them. The server for
that session boots for its own directory (log line 122), but the TUI kept
asking the home instance. That instance keeps no project state: the sidebar
read 0/0, and `/ctx-status` got the `{ disabled: true }` home reply.

Fix: the TUI data layer (`tui/data/context-db.ts`) keeps the startup client
for the notification socket and the process-wide calls. Session-scoped calls
go to a client for the session's own directory. `tui/data/session-directory.ts`
picks that directory: `api.state.session.get(id).directory` on OpenCode 1,
`context.data.session.get(id).location.directory` on OpenCode 2. It falls back
to the startup directory while the host has not loaded the session. The
sidebar (both hosts, including the compiled sidebar OpenCode 2 mounts),
`/ctx-status`, `/ctx-embed` and the recomp dialog use it, and they resolve it
again on each refresh or command, so a session switch follows along.

Proof on a real OpenCode 1.18.30 TUI. The throwaway root was
`$TMPDIR/magic-context/issue-584/bind`, with `HOME` pointed into it, the mock
provider, and `lsof` showing every open `.db` under the root. A session was
created in the non-git project `HOME/Pictures/project`, then 2 compartments and
3 memories were seeded for it. The TUI was then started in `HOME` and opened
that session from `/sessions`. The server booted for `HOME`, then for the
project, in the same PID, which matches the reporter's log.

| Build | Sidebar | `/ctx-status` |
| --- | --- | --- |
| v0.44.4 (same store, same session) | Compartments 0, Memories 0 | crash `view().headline` |
| this branch | Compartments 2, Memories 3 | full status for the project, "Compartments (2)" (palette and slash command) |

Tests: `tui/data/context-db.test.ts` › `session calls go to the server of the
session's directory, not the startup one` runs two real RPC servers (home and
project). It goes red when session calls are forced back onto the startup
client. `v2/tui/session-directory.test.ts` covers OpenCode 2's session
directory lookup and its fallbacks.

Still on the startup client: `/ctx-dream`, `/ctx-flush` and `/ctx-wrapup`
send only a session ID, and on both hosts they reach the startup directory's
server.

### Directory spelling and the session-owner fallback

A per-session client only helps if it finds the session's discovery file.
The server filed its record under a hash of the directory as its host spelled
it, and the TUI looked it up with its own spelling. During the real-TUI proof
above, the seeding script and the server disagreed on `/var` versus
`/private/var`, which is the same class of miss. On Windows the spellings vary
further: drive-letter case, separators, a trailing separator, `\\?\`
prefixes, and 8.3 short names (the reporter's log has `AMMINI~1`).

Fix:

- `projectHash` (`shared/rpc-utils.ts`), used by the server's port-file write
  and the TUI's lookup alike, now hashes `canonicalProjectDirectory`
  (`shared/project-directory-key.ts`). That is `realpathSync.native` where the
  directory exists (it resolves symlinks, `/var` → `/private/var`, junctions,
  and 8.3 short names on Windows), followed by the Windows-aware
  `projectDirectoryKey` that project identity already uses. That function
  moved to `shared/` because the TUI ships without `features/`, and
  `project-identity-cache.ts` re-exports it.
- Lookups also read the pre-canonical hash directory, so a TUI still finds a
  server older than this change, and the dialog can say that server is older.
- If a session's directory still matches no discovery directory, the TUI asks
  every local server through a new `session-owner` RPC. Each server decides
  from the host's own session record (`client.session.get`, or its cached
  session directory). The TUI then uses the server that claims the session,
  instead of showing an empty sidebar. Session clients give up on their own
  directory after about 0.5 s, so this fallback does not wait out the 15 s
  default retry.

Tests. `shared/project-directory-key.test.ts` has one test per spelling pair:
drive-letter case, separators, trailing separator, `\\?\`, name case,
`\\?\UNC\`, 8.3 short name, macOS `/var` versus `/private/var`, a symlink
and its target, and a POSIX trailing slash. The 8.3 case replaces realpath
with a stand-in, because this host cannot create short names; expanding them
relies on `realpathSync.native` on Windows. `tui/data/context-db.test.ts`
starts a real server filed under a symlink spelling and looks it up with the
resolved spelling. It also covers the owner fallback: a server filed under a
spelling that nothing canonicalizes to is still found through `session-owner`.
`rpc-handlers.test.ts` covers the server side of `session-owner`. Hashing the
raw spelling again turns 11 tests red. Removing the fallback turns the owner
test red.

### OpenCode 2 (2.0.20)

Run on `@opencode/cli@2.0.20`, installed into
`$TMPDIR/magic-context/issue-584/oc2020`. The throwaway root was
`$TMPDIR/magic-context/issue-584/oc2`, with `XDG_*`, `HOME`, `OPENCODE_DB`
and `MAGIC_CONTEXT_STORAGE_DIR` under it and
`OPENCODE_DISABLE_DEFAULT_PLUGINS=true`. The plugin was built from this
branch, with the mock OpenAI-compatible provider. `lsof` showed the TUI
process with no database open and the background `serve --service` process
holding only the root's `opencode2.db` and `context.db`.

A session was created in `HOME/Pictures/project`, 2 compartments and 3
memories were seeded for its identity (`dir:49a8c5731f96`), and the TUI was
started in `HOME`. OpenCode 2 lists another directory's sessions only after
`ctrl+a` ("all projects") in `/sessions`. The service then ran one Magic
Context server for `HOME` and one for the project, each with its own discovery
directory.

- Sidebar: Compartments 2, Memories 3.
- `Magic Context: Status` from the command palette: the full project status,
  "Compartments (2)" and Memory Active 3.
- Queried directly, the `HOME` instance (the directory the TUI's setup bound
  to) answers `{ disabled: true }` for this session, and the project instance
  answers 2 / 3. The TUI showed the project instance's numbers.

Not verified on OpenCode 2: a v0.44.4 "before" run. Its `dist/` was not
built.

### The notification socket follows the session too

The typed `/ctx-status` slash command runs as the host's server-side command,
in the server instance that owns the session. It asks the TUI to open the
dialog through a push over the notification socket. That socket was still
bound to the startup directory's server, so on OpenCode 2.0.20 the push never
reached the TUI. The typed command opened nothing, while the palette entry,
which calls the TUI function directly, worked.

Fix: `startNotificationSocket` takes `getSessionDirectory`, and
`resolveNotificationTarget` (`tui/data/context-db.ts`) subscribes the socket
to the shown session's own server. It falls back first to the server that
claims the session through `session-owner`, then to the startup server, so
session-less notifications keep arriving. The session watcher moves the socket
when the shown session's directory changes, at most once every 10 s, so a
session whose server has not started yet does not cause a reconnect every
second. OpenCode 1 and OpenCode 2 both pass the session directory.

Tests: `notification-socket.test.ts` › `subscribes to the server of the
shown session's directory, not the startup one` and `moves the socket when the
shown session changes directory`, with two real servers. Both go red when the
session directory is ignored.

Real-host proof. Both runs used a TUI started in `HOME`, the project session
opened from `/sessions`, the typed `/ctx-status` command (the server command
entry), throwaway roots, the mock provider, and `lsof` showing only the
root's databases.

- OpenCode 2.0.20: the project's dialog opened, with "Compartments (2)" and
  Memory Active 3. Before this change the same step opened nothing.
- OpenCode 1.18.30: the project's dialog opened, with "Compartments (2)". The
  log shows `command ctx-status: pushed show-status-dialog to TUI` for the
  project session. On OpenCode 1 this path already worked after the client
  change, because both server instances run in one process and share its
  notification bus. It now also goes through the session's own server.

## Side findings (not changed)

- With no identity at boot (home directory, paused identity), the server hook
  is not created (`hook.ts`: `recordHookInitFailure({ type: "no_project" })`).
  `/ctx-status` typed in the prompt then reaches the model as the plain text
  `ctx-status` instead of opening the dialog, as seen on the real TUI. The
  palette entry "Magic Context: Status" still works.
- A 0.42.6 server whose store was migrated past its fence answers a bare
  `{"error":"unavailable"}`. The dialog then says "server did not answer",
  followed by the MC-S01 text "retry in a moment". Retrying does not help in
  that state. The server predates `pluginVersion`, so the dialog cannot name
  it.
- The status reply cannot say why an identity is paused. The reason is in a
  private map in `project-identity.ts` (`pausedIdentityReasons`); exporting a
  getter would let the dialog name `dubious_ownership` or `git_missing`
  directly.

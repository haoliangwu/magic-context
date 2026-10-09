# ck-mc silent stalls: live investigation (2026-10-07)

## Result

**Host-side follow-up:** the correlated all-session plugin-log gaps narrow the
remaining hypothesis to OpenCode's event loop/receipt side. The host-targeted
sampling addendum below records native stacks and machine memory pressure;
neither RSS nor a quiet log alone identifies a particular plugin or proves GC.
Its background observer completed two captures in 265.56 s. Both began at the
edge of recovery, so no causal MC fix is proved by those samples either.

**No production fix implemented: the specific 55 s root cause is not proved.**
The observer ran from 10:29:05 to 11:32:18 (63 min, with short observer-only
restart gaps), capturing four candidates: a genuine 15.7 s SQL/I/O pass, two
post-recovery candidates rejected after timestamp reconciliation, and a genuine
19.6 s transport delay with an already-finished handler. The last candidate
was sampled jointly with subc while the plugin still awaited completion.

The suspected Rust TRUNCATE checkpoints do not ship. The original 55 s delay
and the later 19.6 s delay are outside the measured transform handler; the
latter sample has **all ck-mc threads idle**. The paired subc sample does not
show a blocking router mutex or daemon-wide exhaustion. It is not defensible
to name an external SQLite lock owner, or declare subc guilty, from these
stacks. This report distinguishes the observed waits from unresolved causes
and proposes bounded follow-up changes rather than changing unrelated tests.

## Scope and evidence

This is a read-only investigation of the running module, not a store repair.
`ck-mc --version` reports `0.1.0 (5d7bce016dbd8942080c05e6485240ee84ff7bce)`;
PID **31541**, parent `ck-subc` PID **1266**. The request-path files cited below
are identical between that build commit and the investigation base
`1b47f42e3178ff8f5aa5f54815f9454d4ff648c3`. All timeline times are UTC;
macOS `sample` headers use local time, UTC+02:00.
The live daemon's version probe reports `ck-subc 0.20.58`; do not equate that
binary version with this workspace's pinned SDK or published daemon crate.

The plugin log path was confirmed, not inferred from a repository filename:

```text
/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/opencode/magic-context/magic-context.log
~/.local/share/cortexkit/magic-context/logs/magic-context.2026-10-07.log
~/.local/share/cortexkit/run/logs/subc.2026-10-07.log
~/.local/share/cortexkit/aft/logs/aft-24823.log
~/.local/share/cortexkit/broca/logs/broca.2026-10-07.log
```

No SQLite connection was opened against either live database. No store was
written, copied, checkpointed, or signalled, and neither live process was
signalled. Observations consist of log reads, `ps`, `lsof`, and `sample`.

## Important corrections to the initial hypotheses

1. **Both suspected Rust TRUNCATE checkpoints are test helpers.**
   `crates/mc-store/src/lib.rs:18033-18040` is `checkpoint_wal` inside its test
   module; `crates/mc-module/src/host_store.rs:3170` is in a seed helper in the
   `#[cfg(test)]` module starting at line 1980. Neither is on the production
   request path. Replacing them with PASSIVE would not fix a live stall.
2. **There is not a single synchronous request thread.**
   `main.rs:15` creates a single-thread Tokio control runtime, but
   `transport_handler.rs:75-110` puts data dispatch, JSON encoding, and ordinary
   transform followup on Tokio's blocking pool. The pinned SDK
   `subc-client-rs 0.26.1`, `src/lib.rs:86,1825-1883`, allows 64 concurrent data
   handlers. Health is a separate async task (`1887-1911`), not an OS thread.
   Background historian tasks **do** still run on the control runtime and call
   synchronous store functions there (`lib.rs:7463-7467`).
3. **A missing INFO timing record does not prove that a pass failed to complete.**
   `lib.rs:15953-15958` emits INFO only for
   `handler_total + response_encode >= 1000 ms`; faster passes emit DEBUG.
   The 10:11 pass's response has `handler_total=745.1 ms`. Its missing INFO
   `mc-pass-timing` is therefore expected if encoding was also fast.
4. **The plugin's `module` field includes handler followup.**
   `rust-mode-transform.ts:2795-2803` prefers `timings.handler_total`, falling
   back to `total` only if the former is absent. The 54 s wait in the original
   example is not hidden inside that pass's measured synchronous followup or
   store commit. Time before handler entry, after encoding, control-runtime
   starvation, daemon forwarding, and host decode/settle remain possible.
5. **Silence is not daemon-wide proof.** Broca and AFT activity also slowed in
   the original window, but subc kept accepting control routes. Queue timing
   and simultaneous stacks are needed to distinguish a shared routing problem
   from independently starved modules or machine I/O pressure.

## Original window, correlated across modules

| UTC | Observation |
| --- | --- |
| 10:11:20.226 | ALF plugin builds one tail-delta page. |
| 10:11:20.228 | ck-mc accepts ALF's 282,116-byte page. |
| 10:11:20.684 | ck-mc logs `pending drops held`, scheduler Defer. |
| 10:11:22.191, 10:11:34.019, 10:11:52.191, 10:11:56.807 | subc accepts routes to engram, prefrontal-core, engram, fusiform respectively. |
| 10:11:29.457, 10:11:31.133 | AFT idle-reap and retention work still logs. |
| 10:12:00.720 | AFT perf tick: oldest queued interactive work 37,470 ms, maintenance 34,065 ms. |
| 10:12:09.770 | subc receives degraded prefrontal-core health (`work.list_scoped` unreplied for 493,148 ms). |
| 10:12:10.511, 10:12:11.248 | subc accepts insula control routes. |
| 10:12:14.123 | ALF plugin logs waiting for identical final-page completion. |
| 10:12:14.748-14.750 | subc accepts a burst of prefrontal-host routes. |
| 10:12:15.383 | ck-mc accepts AFT's next transform page; preceding ck-mc log gap is **54.699 s**. |
| 10:12:15.384-15.385 | AFT completes queued tools: e.g. read total 52,134 ms, **queue 51,956 ms, execution 2 ms, egress 175 ms**; grep total 43,387 ms, queue 43,068 ms, execution 138 ms. |
| 10:12:15.385 | Broca `keep_warm stopped` logging resumes, after its last such record at 10:11:18.529 (56.856 s). |
| 10:12:16.273 | ALF plugin receives response: handler 745.1 ms, apply_once 649.9 ms, store_commit 63.3 ms, trigger 68.6 ms. |
| 10:12:16.345 | ALF plugin records elapsed 56,228.5 ms; response-wait/decode 54,173.9 ms; settle 1,870.1 ms; async LKG scheduling 3.7 ms. |
| 10:12:16.798 | ALF async LKG capture finishes (18.1 ms). |

These source records are plugin lines 49479-49481 and 49596-49619, ck-mc
lines 5099-5102, subc lines 8660-8697, AFT lines 18515-18533, and Broca lines
9335-9342. AFT here means both the session using ck-mc and, separately, the
tool module; a stalled context pass is not evidence that the AFT tool daemon
stopped handling every request.

The additional 120 s `subc transport: timed out after 120s` observation is
compatible with several layers. This investigation itself experienced that
tool error before the observer was launched. AFT also recorded this worker's
search at 10:24:48.484 with total 79,235 ms, **queue 78,414 ms**, execution
821 ms, egress 0 ms. A transport deadline alone does not identify subc as the
owner of the delay.

## Blocking-call inventory after `pending drops held`

Line numbers below refer to `crates/mc-module/src/transform.rs` (T),
`crates/mc-module/src/lib.rs` (M), `crates/mc-store/src/lib.rs` (S), and the
pinned published `cortexkit-store 0.2.1/src/lib.rs` (CS). The pinned dependency
sources were downloaded into the isolated worktree for inspection, without
changing Cargo dependencies.

**Common locking rules:** `store.db` is one SQLite connection protected by
`SqliteStore.conn: Mutex<Connection>` (CS:205-206). `with_conn` takes it at
CS:252; `with_conn_fenced` takes it at CS:282 and starts `BEGIN IMMEDIATE` at
CS:283-285, retaining the mutex through commit. The busy timeout is **5,000 ms**
(CS:394). That timeout bounds SQLite lock retries, **not** the Rust mutex wait,
statement execution, disk reads/writes, compression, or scheduler delay.
mc-store changes WAL connections to `synchronous=NORMAL` (S:7919 and
`single_store_domain.rs:74-86`). Default SQLite WAL autocheckpoint may run at
commit; it is not an explicit TRUNCATE checkpoint and does not wait out a
reader via the busy handler like TRUNCATE does. Checkpoint I/O can still cost
time.

`context.db` has separate process-local reader/writer mutexes
(`single_store_reads.rs:30-35`). Reads take the reader mutex, `BEGIN DEFERRED`,
execute the entire closure, and commit (`87-99`); the query-only reader's
busy timeout is **5,000 ms** (`69-73`). Writes take the writer mutex (`107-110`)
and call fenced `HostStore::with_domain_transaction` (`host_store.rs:997-1010`):
schema checks, privileged writer bracket, `BEGIN IMMEDIATE` at line 1063,
statements and commit. Its busy timeout is also **5,000 ms** (constant at
line 74, applied at 926-928). Both mutex waits are unbounded. SQLite lock waits
are per operation, not a whole-pass 5 s deadline. WAL readers normally coexist
with writers; `lsof` does not reveal a transaction's ownership of a WAL lock.

| Phase / synchronous call | Lock, blocking operation, limit | Executing thread |
| --- | --- | --- |
| T:4747 `pending drops held` and later tracing calls | Synchronous tracing subscriber/log file sink; file I/O or its internal lock can block independently of SQLite. | Data-handler blocking-pool worker. |
| T:4783-5080 selection, tag protection; T:5081 onward cloning/evolution; T:6431 onward build-output/fingerprints | CPU, allocation/deallocation, hashing and tokenization. Not a DB lock timeout. Serialized-output cache snapshot at T:6514-6518 takes its process-wide mutex; later replace at T:6965-6974 may evict/drop entries while locked. | Same data worker. |
| Bust-only composition / reconciliation: T:5446,5529-5555,5817,6004; `compose_additive_m0` T:2909-2955 | `load_compartments`, workspace/memory/profile reads use context reader transactions, plus cached host-boundary validation via store.db. Revert/truncate writes use both stores sequentially. Project-doc reads are synchronous filesystem I/O. Not entered solely because pending drops are held on a plain Defer. | Same data worker. |
| T:6920 `commit_transform` -> S:10725,10765 | Cache encoding/compression before locking; store mutex, fenced IMMEDIATE transaction, row/section CAS, identity/fingerprint diff, overlay/tag writes, scheduler/divergence/root-lineage trace writes, COMMIT and possible automatic checkpoint. No explicit checkpoint call. | Same data worker. |
| M:10710 `prepare_historian_fire` -> M:6258,6390,6424,6432 | `load_meta` (store mutex); `max_compartment_end_ordinal` (context reader, boundary-validation mutex/cache and store reads); pending drops/full cache-state reads (store mutex). Short live-historian, config and boundary-token cache mutexes; config and project resolution can read files. Boundary estimation/tokenization is synchronous. | Same data worker. |
| M:6539 / M:7068-7105 `record_no_fire`; M:6843 `record_fire_decision` | On changed diagnostics only: `commit_meta` (store mutex, IMMEDIATE CAS, COMMIT). CAS loser yields, but acquiring the mutex or SQLite lock still blocks. | Same data worker. |
| Historian fire-ready assembly M:6709; M:10728 `spawn_historian_firing` | Assembly reads persisted history/raw input and tokenizes synchronously; claiming the live session takes an in-memory mutex. Spawning does not wait for the model on ordinary Defer/Execute. Spawned task itself performs synchronous SQLite reads/writes between awaits. | Assembly on data worker; background drive on single-thread control runtime. |
| Emergency-only M:10625,10656,10686,10743 | Await existing historian / inline firing within remaining **20 s** followup budget (M:323,10562-10568). Host runner serves then folds instead of awaiting its model inline. Emergency may re-read meta and re-transform. Async timeout does not preempt synchronous SQLite or mutex work. | Data worker polls handler future; spawned drive on control runtime. Not the observed Defer branch. |
| M:10766 `store_projection_cache` -> M:5297-5340 | Synchronous retained-size walk, then `projections` mutex and replacement/eviction. No SQLite or checkpoint. Short guidance-date lock at M:10788-10792. | Data worker. |
| M:10798 native attachment / finalization | `native_attachments` cache mutex, native serialization, allocation, eviction. Legacy-only proof at M:10814 calls `reasoning_native_evidence.rs:25,75` (`load`, then `commit_meta`); immediate return when no legacy units (19-20). | Data worker. |
| M:10840 `trace_pass_completed` -> S:9089 | Store mutex, DEFERRED transaction, trace upsert/completion history, COMMIT. Error ignored **after** synchronous call returns; not fire-and-forget. | Data worker. |
| M:10847 retained-size accounting; M:10854-10863 `finish_ready` | CPU/deep charge; `transform_snapshots` mutex and ready-snapshot/lease-budget eviction. LKG-like request cache is RAM, not the host's durable LKG store. No SQLite. | Data worker. |
| M:10898 `respond_transform` -> M:15853,15868,15911-15924,15955/15957 | JSON metadata serialization, cached message-byte splice, allocation, tracing sink for `mc-pass-timing`. That record is emitted **before** transport receives bytes. | Data worker. |
| `transport_handler.rs:106-109` reply bound/page cache; SDK `send_handler_outcome` | `ReplyPages` process mutex; reply chunking/cache eviction, then async egress/channel credit and socket writer. Not included in `handler_total`. Socket progress needs the control runtime even when handler work already finished. | Reply bound on data worker; egress on control runtime. |
| Host LKG: `rust-mode-transform.ts:1679-1680,2384`; `lkg-persist.ts` | Scheduled with `setImmediate` for the observed async capture, then synchronous host context.db transaction/chunk diff. Shares the host SQLite admission/timeout policy, not ck-mc's store mutex. Happens **after** Rust transport returns. | OpenCode plugin JS event loop, another process. |

Additional serialization affecting earlier or other-session work: context
boundary validation holds `context_boundary_cache` while doing context reads
and subsequent store-body reads (`context_boundaries.rs:251-299`), tag baseline
and tag frontier caches have process-wide mutexes, and the tokenizer's history
count cache has a mutex. A full sync of another session can therefore compete
for store/context/cache resources; it does not execute through an explicit
TRUNCATE checkpoint in these production files.

Health at M:14219-14228 reads dispatch atomics and store-open status, plus the
runner-choice in-memory mutex (`5713-5719`). The comment saying no handler lock
is touched is broader than the implementation; the short runner-choice lock is
taken. Health does not checkpoint or query either live store. A healthy probe
does not guarantee data-handler or response-writer progress.

## Live capture 1: 15 s SQL/I/O pass, not the 55 s transport shape

Observer started at **10:29:05.942**, statting ck-mc's log and consuming complete
new plugin log lines every two seconds. A `stage=rust.wire_build` marks a
pending session until its transport completion/error or final `rust pass`.
After more than 10 s with no ck-mc log growth, it captures `lsof` for both DBs
and their WAL/SHM sidecars and runs `sample 31541 5`. It rearms on log growth,
stops at two captures or two hours, and restricts pending markers to the last
five minutes to avoid stale failed-pass markers. This detects candidates, not
only 55 s stalls.

Capture 1 triggered at **10:30:16.107**, observed silence 10.02 s; pending ALF
wire-build timestamp **10:30:04.480**. `lsof` and `sample` both exited 0. Sample
header: **12:30:16.219 local**, 2,333 samples per thread. The pass resumed
during sampling, so aggregate stacks include recovery work:

```text
main / Thread_22448039:
  2269 / 2333  tokio current_thread::Context::park -> mio::Poll -> kevent
  59           spawn_historian_firing -> run_historian_firing_on_host
               -> publish_pending_historian_run -> with_conn_fenced
               -> Transaction::commit -> pagerWalFrames -> pwrite

data worker / Thread_27924292:
  handle_transform_unpaged_value -> apply_once
    -> detect_boundary_divergence_candidate -> max_compartment_end_ordinal
    -> load_compartment_boundaries -> ModuleContextDomain::read
    -> rusqlite::MappedRows -> sqlite3_step
    -> vdbeColumnFromOverflow -> accessPayload -> readDbPage -> pread
  420 samples in load_compartment_boundaries; 630 pread leaf samples overall
  later: prepare_historian_fire -> assemble/read paths
  57 samples: trace_pass_completed -> SqliteStore::with_conn
    -> std Mutex::lock -> _pthread_mutex_firstfit_lock_wait -> __psynch_mutexwait
```

The structural SQL is **S:11612-11625**, called from
`max_compartment_end_ordinal` at **S:11662**. The leaf is a database page read,
**not** `sqliteDefaultBusyCallback`, a TRUNCATE checkpoint, or an external
writer lock. The brief mutex wait is precisely **CS:252**, reached by
**M:10840 / S:9089**. Concurrent main-thread stacks show the same process's
historian using the one store.db connection, a plausible internal mutex owner;
the sample does not expose mutex addresses to prove ownership of each sample.
No other process can own that Rust mutex.

Timeline:

```text
10:30:04.482  page accepted
10:30:16.107  observer trigger; sample starts 16.219
10:30:16.240  plugin: healthy probe, pass still pending, stall_ms=11760
10:30:19.320  pending drops held
10:30:20.039  historian firing queued
10:30:20.138  INFO mc-pass-timing: total=15062.0 handler_total=15650.9
10:30:20.198  plugin transport complete: 15717.5 ms
10:30:20.318  plugin final pass: elapsed=18382.1 module=15650.9 ms
```

This is an actual slow module pass, unlike the original sub-second handler /
54-second response wait. It is evidence for read-I/O/SQL cost in structural
boundary loading, not proof that those reads caused the original silence.

`lsof` users at capture time (FD suffix is access mode, not lock ownership):

| PID | Process | context.db | store.db |
| --- | --- | --- | --- |
| 11009 | `opencode serve --hostname 0.0.0.0 --port 9999` | open `u` handles, WAL/SHM | none |
| 31541 | ck-mc | two connections, WAL/SHM | sole listed user, WAL/SHM |
| 35046 | sqlite3 | `3r`, WAL `4r`, SHM `5u` | none |
| 74386, 79084 | Pi Node hosts | open `u` handles, WAL/SHM | none |
| 83195 | Magic Context Dashboard | read handles, WAL/SHM | none |

The already-running sqlite3 process was later identified by `ps` as
`sqlite3 file:.../context.db?mode=ro VACUUM INTO '<temp>/magic-context/pp-untimed/context/context.db'`
(13:15 elapsed at 10:31:52). **This investigation did not launch it.** It is a
potential competing I/O consumer / long reader, not an identified write-lock
holder. At capture the files were context.db 7,559,360,512 bytes, context WAL
161,429,872 bytes, store.db 1,207,152,640 bytes, store WAL 25,647,032 bytes.

Raw evidence is in the worktree's ignored
`node_modules/.cache/ckmc-stall-watch/`, not copied databases. SHA-256:

```text
stall-1.sample.txt d7a9778b85292b0bfae25092c19b1740ecc9e361be44d0f1cf62adbc23190d66
stall-1.lsof.txt   c001992b77ecbbcf973e4427c94499428964720a1de74c967ada237fa8f60e84
```

After the cross-module concern was raised, the observer was resumed at
10:33:22 with capture count one and the **original two-hour deadline**. The
subsequent captures sample **both ck-mc and ck-subc concurrently** and save bounded
tails plus size/mtime snapshots of other modules' daily logs. Only the observer
was stopped/restarted; no live module was signalled.

## Rejected candidates 2 and 3: do not mistake late log visibility for a live stall

Candidate 2 triggered at **10:35:01.629**, but the plugin ultimately recorded
completion at **10:35:00.199**, before detection. Its 12,379.9 ms transport
time comprised **2,687.5 ms response-wait/decode + 9,689.9 ms settle**, with
handler 2,622.3 ms. Candidate 3 triggered at **10:41:17.279** and was likewise
reconciled as completed before detection. The observer initially believed the
pass pending because the completion log records were not yet visible to its
incremental reader; their timestamps, not the trigger alone, determine this
classification. The watch was continued instead of counting these as the two
requested live captures.

Candidate 2's simultaneous samples started at **10:35:02.386** (ck-mc) and
**10:35:02.382** (subc), after response completion:

```text
ck-mc: 4419 / 4419 main-thread samples in kevent;
       all three blocking-pool workers in idle Condvar::wait_timeout
subc:  3879 samples per thread; most workers in park_condvar / kevent
       Thread_15797: 1961 samples in pump_stderr_to -> emit_line
         -> ChildOutputSink::write_line -> cortexkit_log::sink::Destination::write
         -> std::fs::File::write_all -> write
       Thread_15809: 1251 samples in the same file-write path
       total write leaf samples across all threads: 3301
```

That subc synchronous stderr-file writer is a real executor-blocking hazard,
**not evidence that the router was blocked for the pending transform**.
Many other daemon workers were parked, not waiting on that sink's mutex.
During the sample Broca had log events at 10:35:06.122 and a completed
`route.account_for` round trip at **10:35:06.298 (18,543 us)**; AFT handled a
grep at **10:35:07.448 (58 ms total, 2 ms queue, 54 ms execution, 0 ms egress)**;
subc accepted routes at 10:35:06.243 and 10:35:07.017. Broca's log grew by
598 bytes, AFT's stderr log by 3,408, subc's log by 259, while ck-mc's log
stayed at 1,891,427 bytes. Low-traffic modules with old unchanged logs are not
classified as stalled merely for being quiet.

```text
stall-2.sample.txt      380447a84fd97d876870b38c42c880dc0764b5ade274c4a8a5ab0cc3b8c98551
stall-2-subc.sample.txt 1d831a80effe91707f603e0c5887bd7f562782617badcbf675831eb87d643e53
stall-2.lsof.txt        c91fe39065adf1020550d6c0aa45c0b417177fd848a9f694e2d807e003f807fd
```

## Live capture 4: transport still pending, handler already finished

The continued observer triggered at **11:32:09.666**, with 16.02 s of observed
ck-mc silence and ALF pending since **11:31:51.916**. Both samples and `lsof`
exited 0. It stopped automatically at **11:32:18.892**, after this second live
pending-pass observation (63:12.94 elapsed from the original start).

```text
11:31:51.918  ck-mc page accepted (264,831 bytes)
11:31:52.231  pending drops held
11:31:53.089  INFO mc-pass-timing: handler_total=1170.1 ms; commit=183.7 ms
11:32:09.666  observer trigger
11:32:09.819  plugin: still pending after healthy probe; stall_ms=17902
11:32:10.518  subc sample starts
11:32:10.528  ck-mc sample starts
11:32:11.536  plugin transport completes: 19619.2 ms
11:32:11.555  plugin final pass: elapsed=20000.4 ms; module=1170.1 ms
               response-wait/decode=17427.3 ms; settle=2191.4 ms
```

The sample begins while the plugin still records the pass pending, but runs
past recovery. ck-mc has **4,442 / 4,442 main-thread samples in
`current_thread::Context::park -> mio::Poll -> kevent`** and both blocking-pool
workers have **4,442 / 4,442 samples in idle
`blocking::pool::Inner::run -> Condvar::wait_timeout -> __psynch_cvwait`**.
There are no SQL, handler-followup, checkpoint, health-work, projection-eviction,
or mutex-contention stacks in this capture. The parked condition variables
are worker-idle waits, **not** a store mutex held by another process. There is
no source line awaiting a live DB lock to name here: handler completion is
already logged at **M:15955**, before sampling. Native stack samples do not
show async tasks suspended on egress credits or a peer's reader.

The paired subc sample has 3,997 samples per thread, 19 total threads:

```text
main: CachedParkThread::block_on -> __psynch_cvwait
workers: predominantly multi_thread::Context::park_internal
         -> park_condvar -> __psynch_cvwait, or mio::Poll -> kevent
small active branches:
  connection_loop -> route_for_connection_started -> FrameSink::try_send
  connection_loop -> ForwardBackend::handle_bound -> FrameSink::send
  drain_writer -> TcpStream::poll_write -> __sendto
  pump_stderr_to -> emit_line -> ChildOutputSink::write_line
    -> cortexkit_log::sink::Destination::write -> File::write_all -> write
80 write leaf samples total; no __psynch_mutexwait leaf
```

Subc continued accepting routes at 11:32:09.831 and 11:32:10.288, with a
prefrontal-host burst at 11:32:10.842-10.853. AFT completed an edit at
11:32:10.383 (824 ms total, 3 ms queue, 817 ms execution, 2 ms egress), then
searches at 11:32:13.770 and 11:32:14.102. Broca logged activity at
11:32:09.237, 09.560, 09.615, 10.242, and 14.277. Thus other routes and
modules were not universally frozen during this captured delay. This does
**not** exclude a per-connection forwarding/credit fault in subc or a host
reader/decode delay; a globally wedged synchronous daemon lock is not shown.

`lsof` again listed only ck-mc on store.db. On context.db it listed OpenCode,
ck-mc, the two Pi hosts and Dashboard; the long-running sqlite3 reader from
capture 1 was no longer present. context WAL was 3,007,632 bytes, store WAL
25,647,032 bytes. An open file descriptor is not an identified busy-lock owner.

```text
stall-4.sample.txt      7b746a39d303d3eeed31f4486d1f890799c4409ffa093c5fa4a94fd7b37afeeb
stall-4-subc.sample.txt 57bf6182d8baea0335bad4a01360cb6babaf26e668743e4bbd33c4c668888934
stall-4.lsof.txt        68f8d6e8182bbad10143cea7a946a39b682785d2ff63bedb3916e50d6b08ac84
```

## Fix decision

No production change is justified as a fix for the specific 55 s stall. In particular:

- Changing the two test-only TRUNCATE statements would pass a contrived
  reader test while never reaching the live cause.
- A lower busy_timeout would not bound the captured `pread` or Rust mutex
  waits, and must not be advertised as a whole-pass deadline.
- Ordinary data dispatch is already off the control thread. Background
  historian synchronous database work remains a control-runtime starvation
  risk, but the first sample shows it for a small part of the observation,
  not for 55 seconds, and the captured transport delay has an idle control
  runtime.
- The paired daemon samples show synchronous stderr-file writing on Tokio
  workers, but not daemon-wide routing blockage. A SUBC root-cause declaration
  would require per-connection evidence, not the wording of a transport timeout.

**Smallest next diagnostic change:** correlate one request's attempt/corr with
(a) handler/encode completion, (b) SDK response enqueue/write completion,
(c) subc forwarding enqueue/write to that consumer, and (d) host receipt/decode
and settle completion. It must run even for sub-second handlers, or the
original missing-INFO ambiguity remains. If the next live watcher sees an idle
module with a pending host pass, include the **OpenCode host's stack** as well
as ck-mc/subc; the current captures cannot attribute the suspended async wait
to a specific owner. No such instrumentation was shipped in this investigation.

Small fix candidates, contingent on that evidence:

1. **If a background historian holds the store mutex on the single-thread
   control runtime:** move its synchronous store sections to `spawn_blocking`
   (preserving publication fences and await semantics). Red-first test: hold
   that background store operation at a barrier and prove a control health
   response and an unrelated completed handler's response still make progress.
   Merely moving ordinary transform followup is redundant with the existing
   adapter.
2. **If subc's `pump_stderr_to` file sink prevents a specific connection from
   making progress:** move/bound disk logging off daemon runtime workers.
   Red-first SUBC test: deliberately block the stderr sink and prove unrelated
   routing/response writes complete, with bounded queue/drop accounting. This
   belongs in SUBC, not a ck-mc checkpoint change; the paired samples establish
   the hazard but not that causal claim.
3. **If the structural SQL dominates a slow module pass:** use a covering
   structural-boundary query/index or reuse validated structural coordinates
   without rereading overflow pages. Preserve repaired-row validation and
   compare exact results under cold/warm reads and concurrent publications.
   This targets the first capture, not the proven post-handler delay.

A reader-held-snapshot regression is appropriate only after a runtime
checkpoint wait is demonstrated. Here it would exercise a test-only helper,
not the live path, so it cannot be a credible red-first proof of a stall fix.
No external lock holder, exact 55 s blocking line, or daemon-specific fix is
claimed. The requested report is the delivered change; Rust/TS behavior and
the live stores remain unchanged.

## Verification and remaining limits

- Git whitespace/diff review checks one changed Markdown report (Git
  `2.54.0 (Apple Git-157)`). No ARCHITECTURE.md or STRUCTURE.md edits.
- Four `sample 31541 5` captures, three simultaneous `sample 1266 5`
  captures, and four two-DB `lsof -nP` captures returned exit 0 with nonempty
  evidence. Sample tool headers identify macOS 27.0.1 (26A434), report version
  7, `/usr/bin/sample`; sample counts are recorded above.
- Python observer version 3.9.6; final watch record reports four candidates,
  two still-pending observations, 3,792.94 s elapsed, clean observer exit 0.
- Markdown has no configured LSP producer; scoped inspection reports PARTIAL,
  not a typecheck pass. Rust/TS typecheck, tests and builds were not rerun for
  this documentation-only change. The prepared worktree's install/build were
  reported successful before the investigation; neither was rerun or mutated.
- The 55 s window predates the watcher. The 19.6 s captured delay has the same
  small-handler / large-response-wait shape, but is not a reproduction of an
  exact 55 s timer. No SQLite transaction state or lock owner was observable
  from `lsof`, and no native sample identifies a suspended async per-route
  owner. These are limits of the conclusion, not evidence for a guessed fix.

## OpenCode-targeted follow-up

The follow-up targets `opencode serve` PID **11009**, version **1.18.30**,
executable `~/.opencode/bin/opencode`. The new observer started at
**11:43:14.395 UTC**, in the background with a 90-minute bound, and stopped
automatically at **11:47:39.960**, after the requested two captures. Sampling
was triggered after more than five seconds with no size/mtime change in either
`magic-context.log` or its rotated predecessor. Each capture concurrently
executed `sample 11009 5`, `vm_stat`, `sysctl vm.swapusage`, `ps`, and a
read-only `lsof -nP -p 11009 -Fn`. It never opens a database or triggers an
in-process heap snapshot/forced GC. Raw evidence has the prefix
`node_modules/.cache/ckmc-stall-watch/opencode-stall-*`.

### Why the host is the next suspect

The plugin log has no timestamped records for **any** session between
10:11:20.487 and 10:12:14.076, and the later response-wait example similarly
has an all-session gap around 11:31:52-11:32:09. That is stronger evidence for
lost JS-event-loop/host-receipt progress than a Rust-only log gap, especially
given the already-completed Rust handler in live capture 4. It still is not a
native stack showing the blocked frame.
An independent read of both current/rotated logs confirmed per-second counts:
**38 lines at 10:11:20, zero at 10:11:21 through 10:12:13, 21 at 10:12:14**;
**zero at 11:31:52 through 11:32:08, 18 at 11:32:09**.

There is a necessary logging caveat: `packages/plugin/src/shared/logger.ts`
buffers records and flushes on a 500 ms timer or at 50 lines (11-12,185-190,
207-214). Timestamped lines can reach disk after they were produced; silence
in file **growth** can exceed silence in actual JS log calls. The flush itself
is synchronous: `appendFileSync` at line 169 and bounded synchronous log
rotation at 107-145. A logger/file-I/O stall can also stop the JS thread.
Neither ordinary buffering nor rotation by itself explains a 54 s gap without
corroborating evidence. The new watcher therefore records both observed file
growth and the timestamps surrounding each sample.

### Host capture 1: mostly recovery, not a demonstrated long GC

```text
11:43:48.544  last file growth observed
11:43:49.443  final timestamped plugin line before the gap (visible later)
11:43:53.563  silence detector fires: 5.02 s of observed file silence
11:43:53.659  macOS sample starts (13:43:53.659 local)
11:43:53.697  timestamped message.updated records resume
11:44:02.508  observer capture finishes; all five commands exit 0
```

The sample has **2,406 samples per thread**, physical footprint **4.1 GB**,
peak **6.1 GB**; simultaneous ps reports RSS **3,876,560 KiB**. System swap is
**7,223.94 / 8,192 MiB used**. `vm_stat` reports 16,384-byte pages, 19,063 free
pages (~298 MiB), 3,521,425 compressor-resident pages (~53.73 GiB), and
5,094,116 pages stored in the compressor (~77.73 GiB uncompressed). The
compression, page-in and swap counters are **cumulative machine counters**,
not per-host faults or a measured fault rate during this sample.

Trimmed native stacks:

```text
main / Thread_24446801 (2406 samples):
  opencode +0x178840 -> +0x3397bc -> +0x33ca20 -> +0x33e410
    -> kevent64                                      836 samples
  other paths: anonymous executable/JIT frames; brief libsqlite3 calls:
    sqlite3_step -> sqlite3VdbeExec -> vdbeCommit -> pagerWalFrames
      -> unixWrite -> seekAndWrite -> guarded_pwrite_np
    sqlite3_step -> vdbeColumnFromOverflow -> accessPayload
      -> unixRead -> seekAndRead -> pread

Heap Helper Thread / Thread_30723483:
  2355 / 2406 samples: opencode +0x2f45fc -> +0x2f62ec -> +0x2f9018
    -> _pthread_cond_wait -> __psynch_cvwait
  51 samples outside that idle branch
Heap Helper Thread / Thread_30723484:
  2356 / 2406 samples in the same idle branch
JSCWarmUp: 2406 / 2406 in the condition-variable idle branch
```

SQLite leaves and heap-helper activity during recovery do not identify the
operation that caused the preceding silence. This first capture begins only
38 ms before timestamped JS activity resumes. Do not call its mostly idle heap
helpers a five-second stop-the-world collection.

### Host capture 2: synchronous SQLite on JS main during recovery; plugin unknown

```text
11:47:27.203  final timestamped plugin line before gap:
               sqlite writer BEGIN IMMEDIATE background hold_ms=253, committed
11:47:27.349  last file growth observed
11:47:32.378  detector fires: 5.03 s of observed file silence
11:47:32.518  sample starts
11:47:32.519  message.updated timestamps resume
11:47:32.757  AFT Rust pass transport returns: 5993.2 ms; handler=1383.5 ms
11:47:38.956  capture finishes; all five commands exit 0
11:47:39.960  background observer exits 0 (265.56 s, two captures)
```

The second sample has **1,506 samples per thread**, footprint **4.2 GB**, peak
**6.1 GB**; simultaneous RSS is **3,309,008 KiB** and `%CPU` **139.6** (ps's
measurement, not a five-second CPU average). Swap remains **7,223.94 / 8,192
MiB used**. Free pages fall to 5,185 (~81 MiB); compressor-resident pages are
4,202,621 (~64.13 GiB), representing 5,885,375 stored pages (~89.80 GiB).

```text
main / Thread_24446801:
  anonymous JIT caller -> opencode +0xafb5e4 [0x1054475e4]
    -> sqlite3_step -> sqlite3VdbeExec -> sqlite3VdbeHalt -> vdbeCommit
    -> sqlite3BtreeCommitPhaseOne -> sqlite3PagerCommitPhaseOne
    -> pagerWalFrames -> unixWrite -> seekAndWrite -> guarded_pwrite_np
      92 samples in this one branch
  sqlite3_step -> sqlite3BtreeNext -> moveToChild -> getPageNormal
    -> unixRead -> seekAndRead -> pread
  sqlite3_step -> vdbeColumnFromOverflow -> accessPayload -> pread

main-thread totals (inclusive SQLite frames; other counts are leaf samples):
  sqlite3_step 271 / 1506 (~18.0%); guarded_pwrite_np 124 / 1506;
  pread 67 / 1506; kevent64 140 / 1506

Heap Helper Thread / Thread_30723483 and Thread_30723484:
  each: 1464 / 1506 in opencode +0x2f45fc -> +0x2f62ec -> +0x2f9018
    -> _pthread_cond_wait -> __psynch_cvwait
```

Thus **synchronous SQLite reads and WAL writes on the JS main thread are
observed**, but they occupy a fraction of a recovery sample; the stack does
not show a busy-timeout sleep or a checkpoint waiting five seconds. Main also
runs numerous unidentified native/JIT paths. The Bun pool has substantial
filesystem activity (`lstat`, `__rename`), while the named heap helpers are
mostly idle. None of this proves that a specific SQLite query or GC caused
the preceding five-second gap: the first resumed JS timestamp is just **1 ms
after sample start**. The same 52 Prefrontal, two MC, and six OpenCode numeric
DB descriptors remain open.

The two VM samples, ~219 s apart, show machine-wide decompressions increasing
by 3,982,390 and swapins by 839; compressor occupancy increases by 681,196
pages (~10.39 GiB). This supports significant system memory/compression churn
between observations, **not** a per-process page-fault rate or proof of a
page-fault-heavy blocking read inside OpenCode. A low free-page count includes
reclaimable/compressed memory policy effects; it is not an OOM diagnosis.

### Native symbolication and attribution limits

The executable's runtime/JSC frames and JIT code have no usable function names
in `sample`. `nm -n` lists just one defined text symbol,
`__mh_execute_header`; `atos` on sampled addresses returns address/offset
labels, not named Bun/JSC functions. For example live address `0x10557fb98`
maps only to image address `0x100c33b98 + 92`. The sample retains exact
addresses for later symbolication with a matching dSYM; these addresses cannot
honestly be labelled JSON, regex, or a JSC collector from the current evidence.
Likewise the brief `sqlite3_step` frames do not include a JS filename or SQLite
handle, so attributing them to MC, AFT or Prefrontal would be a guess.

Numeric database descriptors in the capture (excluding `txt` mappings):

| Database | Host descriptors |
| --- | ---: |
| `~/.local/share/cortexkit/prefrontal-core/data.db` | **52** |
| `~/.local/share/cortexkit/magic-context/context.db` | **2** |
| `~/.local/share/opencode/opencode.db` | **6** |

The high Prefrontal connection count is a concrete resource/lifecycle lead,
not proof that a sampled SQLite step used that DB, a measured SQLite cache
size, or a JS retained-heap attribution. No other plugin's code was changed.

### MC heap drivers identifiable from source, not measured dominators

These are source-level candidates in the investigation checkout, not a census
of the live host's retained objects or proof of its installed MC bundle version.

- `MagicContextRustHeapHolder.wireCaches` is an ordinary session `Map`
  (`rust-mode-transform.ts:329-330,4513`). Each entry retains the raw content
  field snapshots and acknowledged native output (`310-327,4138`). It has no
  byte/session eviction bound in that adapter; deletion/invalidation clears
  individual entries (`1962-1972,4781-4804`). Session churn can retain native
  arrays and raw strings longer than the active pass. The separate `states`
  Map (`1668`) retains ordinal metadata and `lkgAcceptedCapture.inputs`
  (`434-438,2368`), likewise until lifecycle cleanup. These are candidates for
  retained memory, not evidence that they dominate the running 4 GB host.
- LKG slots already have a 64 MiB aggregate charged bound and 24 MiB
  single-slot bound (`lkg-slot.ts:31-32`); the digest memo is separately
  bounded at 16 MiB (`289-316`). The entry projector uses a 64 MiB bound and
  at most 16 prior sessions (`lkg-replay.ts:84,141-145`). Do not describe those
  caches as unbounded or sum their charged bytes as if they were actual RSS.
- Transient native/LKG JSON parse/stringify and field-array construction can
  raise allocation pressure (`rust-mode-transform.ts:1339,1382,2294,3433`).
  `getHeapStats` itself stringifies retained native arrays to estimate bytes
  (`346-373,4825-4841`), so it was not invoked inside an already pressured
  host. No heap dump or explicit collection was triggered.
- The existing [session storage inventory](session-snapshot-size-2026-10-07.md)
  quantifies durable row-value bytes, not heap. Its large histories cannot be
  converted into JS-retained bytes without proving which rows are loaded.

### Host conclusion and smallest supported fix proposal

The all-session gaps plus the already-completed Rust response make **host-side
event-loop/receipt starvation the better next target** than changing ck-mc's
checkpointing. The new samples establish system pressure and synchronous
SQLite work on that host's JS main thread, but **do not establish GC as the
blocking frame, identify a plugin's SQLite call site, or name a JSON/regex
frame**. The first sample is mostly recovery; the second begins exactly at
recovery. The stripped executable prevents useful native symbolication, and
JIT callers do not expose JS filenames. This is an attribution limit, not a
license to name MC or Prefrontal as the culprit.

**Smallest causal next step:** obtain matching OpenCode/Bun native symbols
and JS-profile/source attribution during a blackout. A diagnostic recording
must start earlier than the edge of a short five-second silence (for example
a low-cost pre-trigger ring), or it will repeat these recovery-only samples.
Distinguish absence of JS execution from missing input traffic and delayed log
flush. Do not change the live host's inspector configuration or generate a
multi-gigabyte heap snapshot merely to fill this report; neither was done here.

**Smallest fix candidates, only after attribution:**

- If MC's synchronous query/maintenance transaction owns the blackout, move
  that exact operation onto the existing worker/admission path, or bound its
  batch and yield between batches. An `async` wrapper or `setImmediate` alone
  still runs `bun:sqlite` on main and is not a fix. Red-first proof must hold a
  real temporary-DB lock or realistic large query while an event-loop
  heartbeat and unrelated Rust reply progress; preserve transaction/CAS and
  priced-LKG durability semantics. No such operation was identified, so no
  query or test was changed.
- If retained MC arrays cause long collection/memory stalls, the narrow source
  change to evaluate is an aggregate byte/session bound on **wireCaches**
  (and, separately, accepted-input/ordinal state lifecycle), not tightening the
  already-bounded LKG slot store. Evict only replayable wire state and request
  a full native reply/full wire on the next pass; never discard the durable
  priced prefix. Prove bounded retained state over session churn and exact
  replay after eviction before claiming a latency fix. Live dominator sizes
  were not measured, so this remains a proposal.
- Ask the Prefrontal owner to account for **52 simultaneously open data.db
  descriptors** and close/reuse handles if their lifecycle is leaking. This
  is a concrete independent resource lead, not attribution of the sampled
  SQLite step or an authorization to edit another plugin here.

No production MC change is made in this follow-up. A more specific fix would
require a frame/operation or heap-retainer attribution not present in these
captures.

### Host evidence fingerprints and verification

All raw artifacts remain in the ignored worktree evidence directory; no live
store copy or heap snapshot is included. SHA-256:

```text
opencode-stall-1.sample.txt 44d43a1936879f240ebc2b2006897bcd6004b0092ef4431fd9c97d22c8bbbe1b
opencode-stall-1.vm-stat.txt 80c7ef5e6c378a019cd3331dc16f4102d60f9fde31d4c616581038c613c7c4da
opencode-stall-1.swap.txt 034977d18cfaa3865e3df8c4ed737054e959c7eac937bd11d321bccd175ba4dc
opencode-stall-1.lsof.txt ff48887c9e901ddc8017a49e97070e9a33f338bf7c623151fac2e8ede02cef8f
opencode-stall-2.sample.txt 0267bdc116421e634071af5124109115ff03710e4d836b5fb9acae68f6e6c536
opencode-stall-2.vm-stat.txt 8864bbda4ab7399e17e2ced08fd23f263a11ceef247dd477076d8902d433fc95
opencode-stall-2.swap.txt 034977d18cfaa3865e3df8c4ed737054e959c7eac937bd11d321bccd175ba4dc
opencode-stall-2.lsof.txt 17e2d545b8a5c203dfd9077f3237d4121ed36593ccd410ec3b2e880c2c876b69
```

The observer is Python 3.9.6; both sets of five commands returned exit 0 with
nonempty evidence. Sample version/OS headers match the prior captures. Native
symbol probes (`opencode --version`, `nm`, `atos`) completed without modifying
the host; failed function-name resolution is reported as a limitation, not a
successful frame attribution. This remains a documentation-only delivery;
typecheck/build/test exemptions above are unchanged.

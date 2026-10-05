# Large Rust full-sync retries: request-frame admission

## Diagnosis

The refusal is on an **individual incoming frame**, not on the assembled request.
`McHandler::handle` enforces the 48 MiB limit before dispatch. The page coordinator
assembles admitted pages and calls `handle_transform_unpaged_value` directly;
it does not call the raw-body cap again. Its separate staging budget is 256 MiB.

The plugin sizes pages before `SubcModuleTransport` adds
`,"accept_reply_pages":true`: **26 UTF-8 bytes**. A greedy page with fewer than
26 spare bytes is therefore rejected, despite the builder reporting a legal size.
The 16 MiB SUBC headroom does not help: both the page builder and the module's
application cap stop at **50,331,648 bytes**, below the 64 MiB protocol ceiling.

In the read-only live plugin/module logs at 03:19Z, page **1/3** was admitted
(module log: **49,798,512 bytes**). The next upload failed before page-admission
telemetry: the refused frame is **2/3**. The non-final frame has `method: transform`
but no `kind`; the oversized-body probe recognizes `kind: transform`, not
`method: transform`, explaining the generic rather than transform-specific error.
Both caps are identical, so changing that probe would not fix admission.
The historical refused frame's exact length was not logged. The new rejection
log records received bytes, cap, session, method/kind and zero-based page index/total,
without logging message or tool payloads.

There is also an independent boundary error: `forcePageEnvelope` could add its
content-addressed envelope to an otherwise fitting body without checking the
resulting size. The builder now falls through to normal paging when that envelope
does not fit.

## Reproduction and fix

`rust-full-sync-frame-cap.test.ts` uses the production page builder and production
`SubcModuleTransport` against a real ck-mc and hermetic ck-subc. It first receives
NEED_FULL_SYNC for a missing delta base, then retries a synthetic **9,268-message**
full request, **116,421,925 bytes** before page envelopes. Native sidecar padding
keeps the admission experiment independent of large canonical-text tokenization;
no live database or configuration is read.

An earlier alternate fixture duplicated roughly 57 MiB of canonical text in both
CK and native input. On the baseline module, its legal frames were admitted but
the final execution lost the transport connection. That separate cold-execution
failure was not investigated or fixed here; the sidecar fixture isolates the
frame-admission defect rather than claiming to cover every large-session shape.

Neutralizing only the new 26-byte reservation reproduces the actual refusal:

```
frames=[50331664,50321191,15770192] cap=50331648
refused frame 1/3 bytes=50331664 cap=50331648:
request body exceeds the 48 MiB limit
```

The first frame is exactly **16 bytes over** the cap, and the new module diagnostic
identifies `kind=None`, `page_index=0`, `page_total=3`. Only the large-retry test
fails; the seeded replay control stays green. After restoration:

```
frames=[50307553,50320815,15794679] cap=50331648
2 pass, 0 fail
```

All pages are admitted, the transform returns `status=ok`, and a subsequent
oversized single `ctx_memory` tool frame is still refused. The cap and staging
budgets have not been increased or bypassed. `bytes` still describes the builder's
page JSON exactly; the reservation is for later transport expansion only.

## Projection-cache attribution

The historic `projection_cache_missing_or_reverted` reason combines absence and
persisted revert-epoch invalidation. Missing projection state asks for full sync
when no full-request fallback snapshot can rescue the prefix. The available old
logs do **not** establish which projection invalidator fired at 03:19Z. Native
cache evictions of ALF are logged earlier in the day, but they are not proof of
projection eviction: these are **separate 256 MiB caches**, not one shared pool.

Projection entries have a **192 MiB** admission ceiling. Successful admissions
evict least-recently-used other sessions until the shared **256 MiB** budget fits.
An oversized replacement keeps the prior entry, potentially causing a later
fingerprint mismatch. There is no TTL in this cache. Epoch changes, final-route
teardown and process restart can also remove the base. No clear, small accounting
or eviction-order defect was found; no cache policy or size estimate is changed.

Diagnostic-only logs now distinguish missing and revert-epoch misses, record
rejected admission charge/budgets and whether a previous entry was kept, and
record evicted/admitting sessions and charges. Correlating these events with the
unchanged NEED_FULL_SYNC reason will distinguish budget churn from epoch changes
without changing successful response bytes. Raising budgets without these charges
would hide an unmeasured working-set problem and weaken the memory bound.

## Ordinary-pass byte check and verification boundary

The equivalent before/after replay seeds **52 messages**, executes one full pass
and four distinct acknowledged tail-delta passes through the real module, and
compares complete serialized CK plus **reassembled native** output. Each request
has a distinct fingerprint, preventing completed-page-response replay from making
the check vacuous. All five baseline/candidate output hashes match:
`352ec3d5c89c0c35bfd41e44461bf36d2da5f81855aea4afbd9f1a31e20dfea3`.
This covers module/native output on ordinary unchanged defers; it is not a replay
of live ALF, provider system/tools, or the separate LKG cache-rebuild behavior.

Workspace all-target clippy and all mc-module library tests passed (1,549 passed,
20 ignored). Shared compile-slot waits were substantial. During those waits the
external sibling manifests advanced subc-protocol 0.29.0→0.29.1, subc-core
0.20.54→0.20.55 and subc-daemon 0.31.0→0.31.1, making the original `--locked`
invocation fail before compilation. Rust verification used a **temporary lockfile
alignment of only those three path-package versions**; the original lockfile and
manifests were restored and are not part of this change. E2E used binaries built
in this worktree, not a deployed module.

The broad E2E TypeScript project has unrelated baseline errors. A narrowed
TypeScript check of the new test and its imported harness passes, as does the
plugin's full typecheck. No migrations, budget changes, live-store writes or
configuration reads under `~/.config` were performed.

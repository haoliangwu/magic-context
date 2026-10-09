# engram SESSION_WRITER_CONTRACT (snapshot at ee1d519)

# Session Writer Contract

This file is the review gate for the Cloud Plane v2 session writer. The Rust enum, HTTP decoder, and Broca harness scenario matrix must change together.

## Closed `UploadError` set

`engram-module/src/session/writer.rs` defines exactly these variants:

```rust
pub enum UploadError {
    BatchFloor { retry_after_do_ms: u64 },
    DeletePendingReuse,
    RetiredId,
    ObjectIdBoundDifferently,
    ClaimSeqConflict { watermark: u64 },
    CloudPlaneVersionMismatch,
    Rejected(String),
}
```

`Rejected(String)` survives for failures that are not members of the terminal set, including transport failures, malformed error responses, and unknown server codes. It is not a terminal refusal and never consumes a pending tail claim. The terminal set remains enforceable because every known terminal wire code has an explicit enum variant, the decoder matches those codes before the catch-all, and `session_upload_refusals_keep_the_closed_typed_contract` checks that each known terminal wire code decodes to its own variant. The scenario table below describes how the writer schedules retries and handles each upload refusal.

`cloud_plane_version_mismatch` is a member of this closed typed set. The module-side version preflight produces it; its wire and writer contract is fixed here.

## Status and body mapping

An error body is JSON with a required string field named `code`. The writer decodes status and body together; status alone is never enough to identify a typed refusal.

| HTTP status | body fields | `UploadError` |
|---|---|---|
| `429` | `{"code":"batch_floor","retryAfterDoMs":N}` | `BatchFloor { retry_after_do_ms: N }` |
| `409` | `{"code":"delete_pending_reuse"}` | `DeletePendingReuse` |
| `409` | `{"code":"retired_id"}` | `RetiredId` |
| `409` | `{"code":"object_id_bound_differently"}` | `ObjectIdBoundDifferently` |
| `409` | `{"code":"claim_seq_conflict","watermark":N}` | `ClaimSeqConflict { watermark: N }` |
| `426` | `{"code":"cloud_plane_version_mismatch"}` | `CloudPlaneVersionMismatch` |
| any other status/body pair, including a known code under the wrong status | arbitrary | `Rejected(String)` |

A `429` `batch_floor` body without a positive integer `retryAfterDoMs` is malformed and maps to `Rejected(String)`; there is no guessed retry delay. Each typed refusal test observes both the wire status/body and the resulting enum variant.

A `claim_seq_conflict` without an unsigned integer `watermark` is malformed.
The writer persists `max(local, watermark)` and rebuilds with fresh immutable
object ids, retrying the session operation once. A second conflict is an error,
not a loop. This lets a newly enrolled device continue a session without a
cross-object watermark read on every lease observation.

The four v2 terminal claim variants (`DeletePendingReuse`, `RetiredId`, `ObjectIdBoundDifferently`, and `ClaimSeqConflict`) consume `PendingTailClaim` and advance `claim_seq`, forcing the next attempt to derive a fresh object id. `CloudPlaneVersionMismatch` also stops the current attempt but does not advance `claim_seq`: the client must upgrade before retrying. `BatchFloor` and `Rejected` preserve the pending attempt for retry.

## Settlement refusals

After a token CAS, the session object's alarm delivers the CAS to the account object, which settles the session's claimed tails (`Claimed` to `Live`). No writer request returns the outcome, so these codes are NOT members of the `UploadError` set above. The session object records them on the refused outbox entry, and every `lease_read` returns them under `outboxRefused` (`[{seq, refusals: [{objectId, code}]}]`, oldest first). A refused entry is never delivered again. This set is closed:

| code | meaning | row effect |
|---|---|---|
| `claim_expired` | the claim's expiry passed before settlement, or the row already left `Claimed` (`DeletePending`/`Deleted`) | a still-`Claimed` row moves to `DeletePending`; no refund, and delete-confirm charges its bytes off once |
| `claim_generation_superseded` | the claim was admitted under an earlier account generation; a reseed revoked it | as `claim_expired` |
| `upload_unverified` | R2 holds no object with the claim's exact size and `b3` | none at once; the row is never made `Live` and stays `Claimed` until its expiry, when the account alarm's sweep moves it to `DeletePending` as for `claim_expired` |
| `session_claim_missing` | the token protects an id with no account row | none |
| `outbox_payload_malformed` | the stored CAS body does not decode (`objectId` is null) | none |
| `outbox_session_mismatch` | the stored CAS names another session (`objectId` is null) | none |

A claim that no delivery ever settles (for example, the writer stopped before its token CAS) is retired the same way when its claim expiry passes.

`SessionRootsAttest` refuses the whole attestation with `409 {"code":"session_root_bytes_unverified","object_id":<hex>}` when R2 does not hold the named root with its claimed size and `b3`. Nothing is recorded: the root stays `Claimed`, gains no protection, and the device's previous root set stays in force.

The shipped writer does not read `outboxRefused` yet. What it should do about a refused tail is not yet part of this contract.

## Durable pending claim

Before the first `SessionClaimBatch`, the writer durably installs one immutable value:

```rust
pub struct PendingTailClaim {
    pub session_ref: [u8; 16],
    pub claim_seq: u64,
    pub first_seq: u64,
    pub last_seq: u64,
    pub object_id: [u8; 16],
    pub wire_len: u64,
    pub wire_b3: [u8; 32],
    pub account_generation: u64,
    pub key_epoch: u64,
}
```

The historical pending-row names `wire_len` and `wire_b3` hold the immutable
WAL plaintext length and digest. `TailUploader::wire_metadata` derives the exact
sealed-wire length and digest under the persisted generation and key epoch;
those sealed values go into the account claim and the token's `ObjRef`.

Ambiguous PUT and finalize retries reuse all nine fields byte-for-byte. Frames made durable after installation wait for the next claim. A key rotation invalidates the attempt through `ObjectIdBoundDifferently`; it never reseals new bytes under the old object id.

## Broca scenario matrix

The scenario is the owner of the named variant and must assert the status, `code` field, decoded variant, and scheduling effect. No variant may lack a scenario and no scenario may name an unlisted variant.

| variant | `broca_harness` scenario | required schedule/assertion |
|---|---|---|
| `BatchFloor` | S1 | `429` plus retry delay preserves the pending claim and schedules retry after the server delay, capped at 30 seconds before re-observation. |
| `Rejected` | S2 | an unknown refusal remains retryable and preserves the immutable pending claim across restart. |
| `ClaimSeqConflict` | S3 | abort followed by retry consumes the stale pending claim, advances `claim_seq`, and reaches `Live` within the second sequence. |
| `ObjectIdBoundDifferently` | S4 | rotation between claim and retry consumes the pending claim and derives a fresh object id before resealing. |
| `DeletePendingReuse` | S5 | a token-bearing delete-pending id is terminal, advances `claim_seq`, and is not reused by the fold retry. |
| `RetiredId` | S6 | a delete-confirmed id is terminal, advances `claim_seq`, and restart derives a fresh id. |
| `CloudPlaneVersionMismatch` | S7 | `426` plus the typed code stops handoff without advancing `claim_seq` and requires an upgrade. |

The deterministic schedule test additionally pins abort/retry (S3), key rotation/retry (S4), and delete-claim/delete-confirm/retry (S5/S6). The writer reaches `Live` within two `claim_seq` values whenever it is not aborted again before the refreshed expiry.

## CI gate

The contract and scenario matrix stay green under:

```text
cargo gate -p engram-module --bin ck-engram session
```

The real-Worker lifecycle test admits records on two streams, `host` (the host
harness's transcript) and `mc` (Magic Context's session state), and checks that
both replay byte for byte without engram interpreting either payload:

```text
ENGRAM_REQUIRE_WORKER_RUNTIME=1 cargo gate -p engram-module --test it session_two_streams_fold_past_256_turns_handoff_and_replay_from_real_worker
```

## Opaque producer records and cloud replay

`session.admit` retains `walBytes` (hexadecimal bytes) and accepts an optional
`stream` label (1–64 UTF-8 bytes, default `host`). One admission is one record.
Engram length-frames the label, stream byte offset, and payload; neither packing
nor folding relies on a producer's bytes being self-delimiting. `durableOffset`
is the stream's locally durable byte end. An optional `fromOffset` must equal
that end; `offset_mismatch` returns `expectedOffset` and `stream` without appending.
A record is oversized when, with engram's framing, it exceeds the 3 MiB slab
plaintext ceiling (which leaves room under the 4 MiB sealed-wire cap); it is
refused before claim allocation or network I/O.

`session.read` reads the authenticated cloud copy, not local admission state.
It returns ordered `{stream, offset, walBytes}` records and `durableOffsets`,
optionally filtered by `stream`. Takeover verifies the token, signed folds, and
every referenced object before importing the records to the new device's WAL.
Local records that disagree with the cloud prefix refuse takeover.

Cloud durability is a separate position from the locally fsynced watermark.
The checkpoint's `last_seq` advances only through uploaded records, including
when batch-floor backpressure interrupts a backlog. An admission containing a
new record cannot report that record already covered by the preceding token.
Unknown cloud observations never prove durability.

## Checkpoints, folds, and bounded roots

The writer uploads the token object before replacing its cloud head. Tail
references retain both plaintext digest/length and sealed-wire digest/length.
Claim sequences are consumed durably before clearing successful or terminal
upload intent, independently of token replacement. A lost replacement response
is reconciled from the cloud head before local WAL replay.

A fold is a signed commit whose items are opaque `WalSegment` data references.
It is stored in a **Slab envelope**, not a generation Manifest, and referenced
by `TokenBody::folded_commit`. The module repacks records into new data slabs,
clears the token's individual tails, and protects the complete fold closure.
This does not interpret transcript kinds or snapshot contents. The signed
ancestry-header archive remains a separate `TokenHeaderArchive` object.

The Worker stores live signed headers and archived signed headers as per-fact
rows, bounded by the core model's interval and cumulative archive limits.
`lease_read` returns `headerInterval`, `cumulativeArchiveIndex`, and
`lastCasWasFold`; a fold archives only prior headers and starts the live interval
with its own header. Archives omitted by a new cumulative index are removed
from both the model and SQL persistence. After every confirmed token replacement,
the writer re-attests the current full protected set, replacing obsolete roots.

The v2 HTTP path authenticates devices at the edge and does not mint the core
model's account authorization handles. The legacy acknowledgement cursor and
handle helpers are compatibility/model infrastructure, not a live HTTP
acknowledgement protocol.

Lease renewal runs independently of the capture/publication guard and the
session upload lock. It mints credentials once with a five-second deadline and
uses server time for lease expiry; it does not replay the control chain or
re-attest roots on each tick. Slow uploads run in a separate job. Released leases
retain their fencing term, and the next acquire advances it.

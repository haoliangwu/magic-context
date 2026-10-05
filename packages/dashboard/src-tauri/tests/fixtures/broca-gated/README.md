# Broca encoder golden frames

`frames.wal` was produced by `broca-wal`'s actual `encode` and
`encode_with_requires` functions at Broca revision
`b421d13142ed3206f6d7d9ac9d1708c4f70a7e4d` (0.3.170).
It contains two synthetic `TurnFinished` records, sequence 1 then 2, fence 7.
The first uses framing v1 and the second v3 with the complete `KNOWN_FEATURES`
table. It contains no session, prompt, tool, or provider content.

To regenerate, create a temporary Cargo binary with `encoder.rs` as its
`src/main.rs`, `serde_json = "1"`, and `broca-wal` from the pinned revision
above. Run it with the output filename as its sole argument. Do not replace
this fixture with bytes from the dashboard's own test encoder: the independent
producer is what checks wire compatibility.

The dashboard deliberately mirrors the small framing layer instead of taking
a runtime Cargo dependency: Broca's crate is in a separate repository, requires
Rust 1.96 versus the dashboard's declared 1.77, and pulls in broca-protocol.
A sibling path dependency cannot work on release runners that check out only
this repository; a pinned git dependency adds cross-repository availability,
compiler, and update coupling to every platform build. Both projects are MIT
licensed, so licensing does not preclude sharing later. When updating the
mirror, inspect Broca's feature table and regenerate this independent fixture.

Unlike Broca's execution reader, the dashboard is a read-only projection:
it keeps verified records before a newer-writer gate, shows a compatibility
note, and never skips the gate or interprets records after it. Corruption
still makes the entire WAL unavailable.

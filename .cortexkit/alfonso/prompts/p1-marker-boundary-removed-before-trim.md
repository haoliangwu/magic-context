# P1: marker drain commits after tool replay removes the trim boundary

## Executed reproduction

Run:

```
MC_PROBE_LANE=marker-dropped-boundary bun packages/e2e-tests/scripts/ckios-reasoning-only-probe.ts /tmp/marker-boundary-repro
bun test --todo packages/e2e-tests/scripts/ckios-reasoning-only-probe.test.ts -t 'dropped marker boundary'
```

The second command intentionally enables a known-red todo test. The standard
suite leaves it pending, not passing. The mock provider only runs `printf`.
Reference captures: `/tmp/ckios-probe-pool951-dropped-boundary/`.

The real OpenCode 1.18.30 host receives an existing m0 baseline, a newer
compartment ending at a completed tool assistant, 25 completed tool turns,
a reasoning-only assistant and a synthetic user notice. The oldest tool tag
is durably `dropped/full`; the new compartment end is that same tool owner.
The pending marker moves to ordinal 6. A executes at 73% and refreshes m1
without a hard m0 refold; B defers after the host applies its marker window.

A serves 55 provider messages; its message[2] includes `[dropped §3§]`.
B serves 53 (including new messages), lacks that old user shell, and merges
the summary assistant with the next tool-use assistant. m0/m1 are unchanged.
The hook input/output probes and complete bodies are recorded by the script.

## Mechanism

1. The new compartment end is a fully-dropped tool assistant.
2. Tag replay removes that boundary row from the live array **before**
   `injectM0M1` delivers its prepared prefix.
3. `trimToPreparedPrefix` in `inject-compartments.ts` looks up the boundary by
   exact ID. `findIndex(boundary)` returns -1 and skips the trim.
4. The deferred marker drain still commits against the intact host DB row.
5. A serves the untrimmed prefix, B's host-trimmed input does not contain it.

This is **not** placeholder neutralization being undone. In the September 20
own-session specimen, the 17 dropped user owners at wire message[2] map from
tags 179586..179688 to messages at/before new boundary
`msg_0bed0280f001XUSxFbhKbRU9Uo`; tag 179688 is the boundary itself. Sampled
owners are not in `stripped_placeholder_ids`. The marker's target end is
`msg_0bed050b6001CoTwLvLeL1cl1Z`, not the boundary user ID.

The related CKIOS reasoning-only defect is now separately fixed by scoping
tool-batch pruning to affected messages, adopted only on a priced pass.
Its A/B asymmetry was `transform.ts`'s `messagesForTagging` choice: marker-seam
passes tag a separate `messagesBeforeInitialPrepare` array; ordinary defers
use the live served array. Both defects occur around this representation seam,
but scoping the sweep does not fix deletion of its own affected boundary.

## Fix choices

1. **Recommended:** capture immutable ID-order boundary evidence before any
   tag replay or tool pruning. Resolve the new boundary's position against
   that snapshot, then trim surviving live rows through the proven position.
   Never reconstruct or resurrect message parts from an old copy. Include
   synthetic head handling, missing source-boundary refusal, and ordering
   proof that matches the host's canonical order.
2. Refuse to commit the drain whenever the in-pass trim cannot be proven
   applied. Drain and trim must be one atomic decision: no trim means no
   boundary advance. A boundary already absent because the host trimmed it
   must be distinguished from one deleted by this pass.

The diagnostic shipped with this task logs a self-describing `prefix trim:`
line with boundary ID, priced/defer pass and `no in-pass trim applied` whenever
that non-null boundary lookup misses. This is visibility only, not a fix.

## Proof bar

Unskip the named real-host todo regression and make it green. A must not emit
rows at/before the newly applied boundary, and B must preserve the previous
served prefix SHA256 (ignoring only moving provider cache-control metadata).
Mutate the new boundary-position/atomic-drain check back to exact-ID silent
skip and show only the named regression red. Add real-transform unit cases
for deleted boundary, already host-trimmed boundary, assistant-ended seam,
concurrent publication/marker winner, and persistence failure. Preserve the
existing pure-replay differential (master vs branch IDENTICAL), plugin suite,
and plugin typecheck. Do not change provider filtering or add placeholder
bytes to conceal an unpriced structural change.

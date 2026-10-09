# Rust OpenCode marker permission

`prefix_bust_permitted` is additive response metadata, never prompt content. New
ck-mc builds serialize both boolean values. The normal transform sets it from the
final `is_provider_prefix_mutation_pass`, after classification and lineage
demotion. Publication follow-up replaces the entire result; permission, native
messages and coverage therefore remain from the same attempt. Additive-only
transforms use their final HARD/MIGRATE_HARD/SOFT plan; passthrough and full-sync
constructors emit false. Older Rust responses deserialize conservatively.

The OpenCode adapter accepts only actual boolean true as host authority. Labels,
scheduler decisions, metadata commits and local frozen-release pricing cannot
grant it. A true SOFT+ response is a protocol error. False and unsupported
responses hold marker targets and retry counters. Unsupported responses log an
upgrade diagnostic and conservatively persist the installed LKG synchronously,
without enabling host first applications. An armed admission fence requires a
supported rebuilding response after the real recovery flush; an old producer
must be upgraded, not repaired by deleting the fence.

Error envelopes and unsuccessful native statuses are rejected before host
processing. An uncertain retryable host write (including a failed context mirror
after the OpenCode transaction committed) refuses the turn and retains the fence;
only typed definitely-no-cut outcomes can preserve the safely available old slot.

The immutable producer permission governs target extraction (independently of
scheduler execute), marker admission/drain, marker reconciliation, reasoning
bust strips, note-nudge eligibility and synthetic
todo-anchor adoption. Frozen-release pricing remains separate and never grants
marker authority. This boundary also supplies `moduleDecisionBusts` for subsequent
frozen-replay adoption-policy work.

The newest-assistant trailing-blank capture is a first-serve decision, not a
prefix first-mutation. Supported true **and false** responses preserve this
existing ingress-race capture; unsupported responses hold it. Absorbing strip
does not rewrite already-served bytes, and host replay never manufactures keep
bytes. The real-host paired trailing-blank control establishes why delaying this
capture until a prefix bust would change historical replay.

Coverage and permission are independent. Fresh targets still require a commit
and valid response coordinates. Retained retries require the actual served
coverage, including on noncommitting rebuilds. If a newer pending publication
outruns that coverage, the host skips the cut entirely and preserves the newer
blob and all retry health. It does not overwrite newer work with the older
response target, flush to catch up, or query a later status for permission.

Pi does not consume this field or acquire OpenCode marker/fence semantics.
The Claude Code gateway receives additive metadata only; it acquires no marker
cut. Gateway parser compatibility is external to this repository and is not
certified here; the field requiring the external compatibility check is
`prefix_bust_permitted`.

The execute-only extractor assertion was intentionally changed to accept a
committed rebuilding response regardless of scheduler. Both SOFT+ negative
assertions and monotonic/cooldown note-nudge controls remain. Lock fixtures now
expect a newer, unconsumed target not to be attempted; fake served responses
explicitly identify their supported permission instead of relying on a production
label fallback. Frozen-release policy itself is not changed in this patch.

## Verification boundaries

The mixed fixture uses generated user/assistant history, completed tool parts with
large JSON outputs, tied timestamps in the covered head, seven sparse gaps and an
assistant end whose preceding user remains the host boundary. It records actual
transform payload bytes separately from the raw-history API bytes, sampled peak
RSS summed across host/daemon/module, successful output fit, host writer acquire
and hold times, the first smaller full send and subsequent append delta. Provider
equality compares distinct intercepted HTTP system/messages objects, not hashes
of a single object.

Fault coverage includes scheduler-defer after-marker, capture, late bookkeeping,
context-mirror and final-fit failures, a held real SQLite host writer with typed
definitely-no-cut rollback, and SIGKILL of an adapter process immediately after
its real host-store commit and before admission. The SIGKILL fixture is a Bun
adapter/SQLite process, not an OpenCode server OS-kill or provider-ack test. The
real OpenCode recovery control separately exercises actual session.flush transport.
The paused publication control uses two real context connections and commits
legacy pending work between response recording and the drain's reread; it does
not claim an in-flight Rust historian publication writes legacy pending blobs.

Throwaway-HOME full package suites expose unrelated existing HOME/homedir
assumptions in the plugin config-variable and Pi dreamer-home tests. Those files
and claims are not changed. The e2e TypeScript project also has existing errors
outside the marker fixture; package source/scripts typechecks pass and the edited
marker fixture has no TypeScript diagnostics.

## CI host-ordering follow-up

The merged train at `647dbab69e` reproduced CI run `37567736485` on its
OpenCode **1.18.32** pin: both mixed catch-up controls received SOFT+ instead
of HARD. The same merged producer and plugin passed on **1.18.30**. The
original delivery at `b173dfc875`, with its original native producer, also
failed on 1.18.32. The protected-tools merge therefore did not cause this
epoch suppression.

The old fixture discovered new `AGENTS.md` instructions after restarting the
host. On 1.18.32 the intercepted provider system changed and contained those
instructions, but that turn's Rust transform still saw the previous system
hash: generated context.db advanced from `67a2f683e94c065cd82cd798806ef6b0`
to `3475ae3780857634ff4db5f64c8f95a8`, while store.db's
`last_system_prompt_hash` remained the former value. The messages hook ran
before the system hook. Its below-threshold SOFT+ and false permission were
correct for the request it actually received; a later system observation must
not authorize a cut on an earlier response.

The fixture now changes a configured MC `ctx_search` tool description.
That changes the provider tool schema **and** the request's render-config identity,
independently of host hook ordering. The controls still require HARD with
`reason=epoch_change`, scheduler defer, true permission, changed intercepted
tool-description content, literal marker advancement to 16940, a full smaller-input send,
byte-identical subsequent replay and an append delta. No product gate or rebuild
assertion is relaxed, and the byte-preserving HARD control keeps its unchanged
configuration and false permission.

After merging the frozen-replay policy from master (`d0cd505c`), the shared
adoption seam remains `shouldAdoptModuleAfterFreeze(moduleDecisionBusts,
frozenReplayReleased)`. Its first argument is the immutable
`response.prefix_bust_permitted === true`, not a decision-label guess. Its
second argument is a local safety release and grants no marker authority.
Synchronous LKG replacement uses that adoption result or unsupported-capability
conservatism; marker admission and postprocess still receive only producer
permission. The former eight-pass marker fixture now asserts continued freezing
and retained pending work, matching the intentionally changed master policy.

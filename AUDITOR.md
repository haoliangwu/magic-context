# Auditor Guide

Start here before auditing this codebase (Oracle, Athena council, blind review,
or human). This repo runs **frequent, deliberately blind** audits, so the same
findings tend to resurface. This guide points you at the documents that record
what has already been investigated and decided, so your audit spends its budget
on *new* signal instead of re-deriving settled conclusions.

## Read these first

| Document | What it records | When it matters to you |
|---|---|---|
| [`packages/pi-plugin/PARITY.md`](packages/pi-plugin/PARITY.md) | Intentional **Pi ↔ OpenCode mechanism divergences** ("same effective behavior, different mechanism") with rationale. | Before reporting any Pi-vs-OpenCode difference. Many "Pi is missing X" findings are documented-intentional. |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | The m[0]/m[1] cache-stability model, the SOFT/SOFT+/HARD materialization taxonomy, decay rendering, historian/dreamer flows, schema migrations. | Before reasoning about cache busts, materialization, or "history loss" — the invariants are subtle and documented. |
| [`STRUCTURE.md`](STRUCTURE.md) | File/module layout and where to add new code. | When locating the owner of a behavior. |

## How these documents are meant to be used

- **They are not a shield against real bugs.** Every entry records a *decision*,
  not a taboo. If you believe an accepted item is genuinely wrong, argue against
  the **recorded reasoning** with source evidence — don't just re-flag "X looks
  suspicious." A counter-argument that engages the documented rationale is
  exactly the signal these audits exist to surface.
- **A documented item is not "new information."** Re-reporting an `A#` / `G#` /
  PARITY entry verbatim adds no value and crowds out genuine findings. Note it as
  "confirmed-as-documented" at most.
- **Severity still applies.** If a documented tradeoff has become wrong because
  the surrounding code changed (the reasoning no longer holds), that *is* a
  finding — say so explicitly and cite what changed.

## What makes a high-value finding here

1. A **cache-stability** violation: something that mutates the m[0] prefix (or
   m[1] on a defer pass) when the taxonomy says it must not — with a source trace
   of the byte-changing path.
2. A **fail-closed** violation: a path where oversized raw history could reach
   the provider, or durable state is trusted when it should fail closed.
3. A **trust-boundary** break: repo-supplied (project config / project files /
   repo content) data escalating privilege or exfiltrating secrets.
4. A **cross-harness divergence** that is NOT in PARITY.md and changes effective
   behavior (not just mechanism).
5. A **regression** in code changed since the last audit — prior rounds'
   fixes are the most fertile ground for newly-introduced bugs.

## Conventions

- Internal audit findings belong in the operator-local `.cortexkit/internal-docs/audits/` (or
  `PARITY.md` for Pi divergences) with their reasoning, so the *next* audit
  doesn't re-derive them. Code comments explain the **why** (invariant / failure
  mode / constraint) and never reference ephemeral audit artifacts (council
  numbers, round numbers, Oracle names) — those mean nothing a week later.
- When in doubt about whether something is intended, check the relevant `A#`
  entry first, then the inline comment at the call site, then ask.

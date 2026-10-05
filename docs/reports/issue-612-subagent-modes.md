# Issue 612: OpenCode 2 child-session modes

## Creation-time decision

The row-creation fallback reads `session_v2.parent_id` through the existing
read-only, generation-checked OpenCode 2 store reader. This is preferable to
setting the flag later in the context hook: `recordUsage` already creates the
meta row before the system-prompt and message transforms, and other consumers
of `getOrCreateSessionMeta` receive the same creation-time decision. The flag is
included in the OC2 INSERT, not written as a correction after a primary-mode row
has become visible. OpenCode 1's event handler and v1 fallback are unchanged.

**Upgrade behavior:** an existing `session_meta` row is never reclassified.
An OC2 task child already seen by the old plugin with `is_subagent = 0` keeps
primary mode, including historian eligibility, for that session's lifetime.
A host session without a meta row yet is classified when its row is first
created, even if the host session itself predates the upgrade. New children get
reduced mode immediately. Missing/unreadable parent information retains the
existing best-effort primary default, also without a later mode flip. No schema
migration or backfill is introduced.

## Hidden runs

On OC1, parented `magic-context-` children are marked internal by the event
handler and exempted from transforms; system-prompt signature detection is a
timing-independent second guard. On OC2, registered hidden runs are shaped by
`HiddenChildHook.apply` and return before usage/meta creation or either shared
transform. Historian, dreamer, compressor and other internal completions keep
their calibrated prompts and bypass paths. None of those guards was changed.

## ctx_reduce permissions

The reported failure is real, but replacing the v1 SQL alone would not fix it:
the OC2 context hook explicitly froze availability from message roles alone
before the system handler could query anything. The adapted messages have no
v1 spawn tools map, and the OC2 lane has no v1 SDK client to prime permissions.
Every such session therefore froze callable, even when the host removed the
tool for its agent or session permissions.

Availability now freezes from the OC2 context draft's already permission-filtered
tool set before either shared handler runs. Its first user-bearing pass decides;
later draft tool changes cannot flip guidance or prefixes in that process. Empty
drafts still leave the verdict provisional. This retains the shared resolver's
existing process-scoped lifetime (a restart resolves anew from the host's first
draft), without adding persistent permission state or changing OC1's resolver.

## Native regression proof

`tests/opencode2/subagent-mode.test.ts` runs the real 2.0.22 host with a local
Anthropic mock. A primary invokes the host's native task tool, named `subagent`
on this version. Both allowed and denied children have `is_subagent = 1` when
the provider receives their very first request. An allowed child has prefixes
and reduced guidance; a denied child has neither. The parent retains its
primary row, prefixes and full guidance. These are the OC1 parity semantics:
prefixes depend on ctx_reduce availability, not on primary versus reduced mode.

The two child tool-loop requests have identical whole-system bytes and identical
existing message content bytes; only the new read arc is appended. Anthropic's
host serializer moves `cache_control` to the latest result, so that annotation
alone is omitted from message-prefix comparisons, not from system comparisons.
Real history plus an observed 60,000-token execute pass produces no child
historian runs or compartments. The same stack publishes primary historian
output as a positive control, with no ordinary guidance on its internal carrier.
A denied primary also gets no prefixes or reduce guidance from pass one.

The regressions failed on the old shipped plugin: both native children had
mode 0 at requests one and two, and the denied primary still carried prefixes.
Unit regressions independently failed on first-row classification and the
denied-tool availability verdict. Each native run inventories host descriptors
with `lsof -p` and permits database paths only under its throwaway root.

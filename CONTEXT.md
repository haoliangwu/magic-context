# Magic Context

A context-management and memory plugin for coding-agent harnesses (OpenCode, Pi, OMP, dsh), sharing one durable SQLite state across harnesses and projects.

## Language

### dsh integration

**Host-plane row**:
An entry in the dsh package's `cordis.patch.yml` mounted process-globally by the profile bundle; its listeners are untagged, so they observe every agent regardless of preset.
_Avoid_: global plugin, agent-preset row

**Shipped preset patch**:
The in-place edit of dsh's shipped `agent.cordis.yml` files that swaps the `compaction-basic` row's name to the Magic compaction entry (tmp+rename, boot self-healed).
_Avoid_: preset override, magic preset

**Standing mount**:
dsh-agent-presets' single composition instance per preset that every agent naming that preset joins by scope parenting.

**Thin preset** (deprecated):
The former generated `magic-standard` preset that included the stock `standard` preset with Magic row patches. Removed; do not reintroduce.
_Avoid_: magic-standard

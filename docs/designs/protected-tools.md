# protected_tools

Users can name tools whose newest results Magic Context's automatic drops must leave in the prompt (issue 621).

## Shape

```jsonc
"protected_tools": {
  "ask_user": 3,        // keep the newest 3 results of ask_user
  "subagent_create": 1  // keep the newest result of subagent_create
}
```

- A map from tool name to a whole number N ≥ 0. N is how many of that tool's newest results stay protected.
- Shipped defaults: `{ "todowrite": 1, "ctx_reduce": 3 }`. These replace two rules that are hardcoded today: the newest `todowrite` kept by age reclaim and `smart_drops`, and the newest three `ctx_reduce` results kept by every lane. The user's map merges over the defaults, so a user can raise or lower them, and 0 turns a default off.
- Tool names match the way the emergency tier lists do: case-insensitive, with a leading `mcp_` ignored.
- Allowed in user and project config. Protection widens no authority.

## What "the newest N" means

The newest N results of that tool that are still active in the prompt, ordered by tag number. Results that were dropped, or that the historian has summarised, don't count, so the protected window moves with the conversation. Ordering by tag number makes the selection deterministic.

## Which lanes honour it

Every automatic lane that removes or shrinks a tool result:

- emergency drops;
- age reclaim;
- `smart_drops` supersession, including the edit-marker compression;
- duplicate removal.

All four already pass candidates through one eligibility check (`canDrop` in TypeScript and Pi, the automatic-reduction filter in Rust), next to the user-answer rule from issue 581. Protection is added there, once.

Agent-directed and non-tool policies:

- Queued drops of a protected result, from the agent or from historian publication, are held; the historian's summary is unaffected, and the raw result leaves at the next fold.
- Agent drops apply on a later cache-rebuilding pass once newer calls displace the result from its tool's protected count; already-dropped results are never restored. Compacted results are no longer active and stop counting toward N.
- First detection of stale `ctx_reduce` stripping honours the effective protected tool set, just like other automatic result removal. Frozen strip replay is immutable: changing the map never resurrects an already-stripped result. Image and placeholder-only strips keep their separate structural policies.

## At 95% and above

Today the protected tail and the tier reserve stop protecting at 95%. Protected tools keep holding, like user answers and the newest `ctx_reduce` results do now: the user asked for them explicitly, and N bounds how much they can pin. The cost is that protecting a tool with large outputs can bring a session to the 95% refusal sooner. The setting's description says so. There is no byte cap.

The new pre-send refusal applies only when refusal-grade evidence proves that the calibrated protected results alone exceed the model's window after reclaim. If that subset is absent or fits, every existing fold, send and provider-overflow refusal decision stays unchanged. An over-limit full-request estimate or usage from an accepted reply must not prevent the provider from receiving a turn, reporting overflow and letting Magic Context learn the limit and fold. Default configuration must preserve the existing wire bytes and decisions except where its protected counts deliberately change result eligibility.

## Cache safety

- Protection only changes which candidates a lane may select, and lanes select only on passes that already rebuild the cache. No pass busts because of it.
- When a newer call arrives, the oldest protected one becomes eligible again. It is dropped on a later pass that rebuilds the cache anyway, never on its own.
- Changing the map takes effect on the next pass that rebuilds the cache. Results already dropped stay dropped; nothing is restored.

## Parity

TypeScript (OpenCode 1 and 2), Pi and the Rust module apply the same rule, through the same shared golden fixture as the other selection rules. ck-mc reads the map from the project's effective config, like its other settings.

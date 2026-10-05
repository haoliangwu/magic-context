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

Not affected:

- `ctx_reduce`: an explicit drop by the agent still works.
- The historian: summarised results leave the prompt as usual.
- The frozen strips (old images, stale `ctx_reduce` calls, placeholder-only messages), which don't select tool results by name.

## At 95% and above

Today the protected tail and the tier reserve stop protecting at 95%. Protected tools keep holding, like user answers and the newest `ctx_reduce` results do now: the user asked for them explicitly, and N bounds how much they can pin. The cost is that protecting a tool with large outputs can bring a session to the 95% refusal sooner. The setting's description says so. There is no byte cap.

## Cache safety

- Protection only changes which candidates a lane may select, and lanes select only on passes that already rebuild the cache. No pass busts because of it.
- When a newer call arrives, the oldest protected one becomes eligible again. It is dropped on a later pass that rebuilds the cache anyway, never on its own.
- Changing the map takes effect on the next pass that rebuilds the cache. Results already dropped stay dropped; nothing is restored.

## Parity

TypeScript (OpenCode 1 and 2), Pi and the Rust module apply the same rule, through the same shared golden fixture as the other selection rules. ck-mc reads the map from the project's effective config, like its other settings.

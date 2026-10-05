# Issue 563 priming trial: does Qwen 27B learn to copy `[dropped §N§]`?

## Answer

**No imitation in this setting.** Arm A ran master's guidance with today's `[dropped §N§]` placeholder for 150 scripted coding turns: 450 main-session model calls, 302 tool calls, tags up to §616§. The model never wrote a drop placeholder, a `[dropped]` ritual, a marker-only text part or a placeholder in tool arguments. The dropped-input guard never fired.

Drops were served the whole time, starting at turn 12. Fifty-seven distinct tags went through `[dropped §N§]`, with up to 12 drop placeholders in a single request. The model itself issued `ctx_reduce` 129 times. The leading `§N§` tag was present and correct on 145 of 150 replies.

Arm A showed no imitation, so arm B (the neutral wording) was not run, as the plan required. The neutral-wording switch is built and unit-tested, and is ready if this question comes back with a setting that does reproduce the ritual.

What this does **not** show: that the reporter's ritual can't happen. Four differences from the reporter's setup stand out, listed under [Limits](#limits). The largest is thinking: arm A ran with thinking off, because with thinking on one turn took several minutes. The reporter runs reasoning effort xhigh. An 11-turn thinking-on sample was clean too, but it is short.

## Method

| | |
|---|---|
| Host | OpenCode 1.18.30 (`opencode serve`), real host, throwaway root |
| Magic Context | master at `0a0f2f417a`, built `dist/index.js`, loaded unchanged through a thin wrapper plugin; `transform_mode: "ts"`; default prompt preset (full), which includes the 0.45 self-tag guidance |
| Model | `unsloth/Qwen3.8-27B-GGUF` (server reports quant `UD-Q4_K_M`) on Ufuk's local Unsloth Studio, one request at a time |
| Generation | thinking off (`chat_template_kwargs.enable_thinking=false`) for arm A; reply cap 4096 tokens (8192 for the historian) |
| Historian | on, using the same local model (needed because most queued drops only land on a history publication or a force pass) |
| Dreamer, embeddings | off (`dreamer.disable`, `embedding.provider: "off"`); nothing downloads a model or calls another provider |
| Workload | throwaway clone of the TOON repository at `a52f2d28`. Its source never uses Magic Context's notation, so any placeholder in the model's output comes from the served context. Arm A ran 150 of the 300 scripted turns (25 episodes × 12 turns of read / search / git log / explain / `wc` / read tests / edit / diff / grep / bug hunt / spec check / revert) |
| Tools | OpenCode's build agent with `read`, `grep`, `glob`, `bash`, `edit`, `write`, `todowrite` and the Magic Context tools. `task`, `question`, `skill` and web tools are off. Package managers and remote git are denied in bash, after the smoke run caught the model trying `pnpm install` |

The relay sits between OpenCode and the model server. For every call it:

- records the request, the streamed reply text, reasoning and tool calls, usage, llama.cpp `timings` and per-call latency;
- injects the server key itself, so the key never reaches a file;
- forwards only to the loopback upstream.

The placeholder variant is a trial-only switch (`PRIMING_PLACEHOLDER=neutral`) applied to the finished provider request. It is described under [Neutral wording](#neutral-wording-built-not-run). Master's code is untouched.

### Isolation

Every store lives under `$TMPDIR/magic-context/issue-563-priming/<run>/`:

- XDG data, config, state and runtime directories;
- `OPENCODE_DB`;
- `MAGIC_CONTEXT_STORAGE_DIR`;
- `HOME`.

`lsof` on the host PID and its children ran at turn 0 and every 25 turns, 7 checks in arm A. None found a file under `~/.local/share/opencode`, `~/.local/share/cortexkit/magic-context`, `~/.config/opencode` or `~/.config/cortexkit`. The only databases open were the run's own `data/opencode/opencode.db` and `data/cortexkit/magic-context/context.db`, with their WAL and SHM files. The run aborts if a forbidden path ever shows up.

### Measures

Every measure comes from the model's own output, as seen in the provider stream, compared against the request it answered (`scripts/priming-trial/analyze.ts`):

- **Leading tag.** Correct when the reply opens with `§N§` and N is one more than the highest leading tag in the request. Wrong for any other N. Missing when there is no leading tag.
- **Placeholder shapes in text.** `[dropped…]`, `[cleared]`, `[truncated…]`, `(removed…)` and `removed: tag N`, counted in reply text and, separately, in reasoning.
- **Tag-only text part.** Only `§N§` tokens and whitespace, for example `§40§\n\n`. Counted on its own and also when it sits alongside tool calls.
- **Marker-only text part.** Only tags, placeholder shapes and punctuation.
- **Tool calls with placeholder shapes or tags in their arguments.** Also counted: dropped-input guard refusals, recorded by the wrapper plugin when Magic Context's `tool.execute.before` throws.
- **Drops in context.** Placeholder-only tool results, dropped-input markers and placeholder-only text parts in each request, recomputed from the stored request bodies.
- **Cache bust.** A main call with at least 4,000 prompt tokens where fewer than half of the previous main call's prompt tokens were served from cache.

## Smoke phase and plan change

| Setting | Turns | Mean s/turn | Projected 300-turn arm |
|---|---|---|---|
| Thinking on | 8 | 282 (median 257) | ~23 h |
| Thinking off | 10 | 88 | ~9–10 h with historian runs and cache refills |

Prompt processing ran at about 200–340 tokens/s and generation at 8–20 tokens/s. Generation slows as context grows. Both settings were over the 6-hour cap. The plan was cut to:

- thinking off;
- 150 turns per arm;
- arm A first;
- arm B only if arm A showed placeholder imitation;
- a 20-turn thinking-on comparison, which was stopped at 11 turns (see below).

Arm A took 3.46 h of turn time.

The smoke also found two harness problems, both fixed before arm A:

- **Upstream timeout.** Bun's `fetch` gives up after five minutes by default. That killed a slow historian call in the relay; the relay now passes `timeout: false`.
- **Call numbering on resume.** A resumed run restarted call numbering and overwrote stored request bodies. The thinking-on smoke was resumed once, so its per-call data is unreliable, and only its progress log is used here. Its trajectory is not committed.

## Arm A results (thinking off, `[dropped §N§]`)

Per 25-turn bucket. Replies are main-session calls with non-empty text. With thinking off, the model wrote text only on its final answer of each turn, so replies equal turns.

| Turns | Replies | Tag correct | Tag wrong | Tag missing | Tag-only parts | Placeholder in text | Marker-only parts | Tool calls | Placeholder in args | Guard refusals | Max drops in a request | Drops at bucket end | Main calls | Historian calls | Cache busts | Cached share | Median s/turn | Mean s/turn |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1–25 | 25 | 22 | 0 | 3 | 0 | 0 | 0 | 69 | 0 | 0 | 10 | 10 | 92 | 2 | 2 | 96.5% | 83 | 97 |
| 26–50 | 25 | 24 | 1 | 0 | 0 | 0 | 0 | 52 | 0 | 0 | 10 | 3 | 77 | 3 | 2 | 97.8% | 56 | 89 |
| 51–75 | 25 | 25 | 0 | 0 | 0 | 0 | 0 | 48 | 0 | 0 | 12 | 5 | 73 | 4 | 3 | 96.4% | 53 | 107 |
| 76–100 | 25 | 25 | 0 | 0 | 0 | 0 | 0 | 40 | 0 | 0 | 7 | 3 | 65 | 4 | 3 | 96.0% | 59 | 80 |
| 101–125 | 25 | 25 | 0 | 0 | 0 | 0 | 0 | 47 | 0 | 0 | 3 | 1 | 72 | 2 | 2 | 98.0% | 29 | 48 |
| 126–150 | 25 | 24 | 1 | 0 | 0 | 0 | 0 | 46 | 0 | 0 | 11 | 7 | 71 | 5 | 4 | 95.7% | 59 | 78 |
| **All** | **150** | **145** | **2** | **3** | **0** | **0** | **0** | **302** | **0** | **0** | **12** | **7** | **450** | **20** | **16** | **96.7%** | **56** | **83** |

Placeholder shapes also never appeared in reasoning. Thinking was off, so there was almost none. No tool argument carried a `§N§` tag either.

First appearances:

| Behaviour | First turn |
|---|---|
| Leading `§N§` tag | 3 (turns 1, 2 and 7 opened without one; every other reply had one) |
| Drop placeholder served in context | 12 |
| Cache bust | 12 (the first historian publication and the drops that landed with it) |
| Wrong leading tag | 47 |
| Tag-only text, placeholder in text, marker-only text, placeholder in tool args, guard refusal | never |

Both wrong tags reused the newest visible tag instead of adding one. At turn 47 the model wrote `§207§` when the highest tag was §207§, and at turn 150 it wrote `§616§` against §616§.

**Exposure.** Fifty-seven distinct tags were served as `[dropped §N§]` over the run. All of them were tool results whose whole content was the placeholder. The model reduced nearly every tool output it had used: 129 `ctx_reduce` calls, typically dropping the output it had just read. The historian folded older history into compartments, so a request carried between 1 and 12 placeholders at a time rather than accumulating hundreds. The whole-message `[dropped]` sentinel was never served, because no assistant message was ever made up only of markers.

A typical request in the 51–75 bucket ended its history with consecutive tool results like these:

```text
tool  "[dropped §205§]"
tool  "[dropped §210§]"
tool  "[dropped §214§]"
tool  "[dropped §215§]"
tool  "[dropped §216§]"
```

A reply written with 12 drops in context (turn 61, verbatim start):

```text
§272§ 140 lines, three regions, 9 exports:

**Normalization (the core):**
- **`normalizeValue(value: unknown): JsonValue`** — The single entry point. …
```

**Historian on this model.** 20 runs were started:

| Outcome | Runs |
|---|---|
| Published | 18 |
| Rejected as invalid | 1: "output left uncovered messages 458-458 without `<unprocessed_from>`" |
| Failed with `TimeoutError: The operation timed out.` | 1 |

The historian calls took 42–326 s each, 59 min in total. Most of them reused a 14.5K-token cached prefix, so a historian run did not by itself evict the main session's cache. Every one of the 16 cache busts came after a historian run, and 12 of them within 16 s of it finishing. These are the expected refills when history is rewritten and queued drops land with it.

## Thinking on: 11 turns

The plan asked for 20 thinking-on turns on the same script, to compare the early tag-only rate. The run was stopped after 11 turns because every historian attempt was failing and turns had stretched to 19–25 minutes.

| Turns | Replies | Tag correct | Tag wrong | Tag missing | Tag-only parts | Placeholder in text | Marker-only parts | Tool calls | Placeholder in args | Max drops in a request | Mean s/turn |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1–11 | 53 | 47 | 3 | 3 | 0 | 0 | 0 | 60 | 0 | 24 | 476 |

With thinking on, the model writes a sentence next to almost every tool call, so text replies are five times as frequent as in arm A. Those sentences are tagged:

```text
§65§ Searching for `throw` in `packages/toon/src`.
```

The wrong tags reused the latest tool result's tag. At turn 9 the model wrote `§66§ Now reading the throw sites…` when §66§ was the grep result it had just received.

**Tag-only parts.** Tag-only text parts were seen exactly twice across all runs, both early and both next to a tool call. Neither was followed by placeholder copying.

- Thinking-on smoke, turn 5: `§40§\n\n`, then a `bash` call.
- A one-turn thinking-off probe of the harness, turn 1: `§2§\n\n`, then a `read` call.

There were none in arm A's 150 turns and none in the 11-turn thinking-on run. On this model that is 2 in about 235 text-bearing calls. It is a real shape the 0.45 guidance can produce on tool turns. If it appears, the marker-only neutralization has to clean it up.

**Historian with thinking on fails every time on this server.** All 8 attempts failed with `TimeoutError: The operation timed out.`. Each attempt generated 4,000–8,000 tokens, 15–33K characters of reasoning, and the relay saw the calls run 400–1,460 s. In arm A, the one timed-out historian call had run 326 s, and the smoke's failure came after about 5.6 minutes. So something on the historian path gives up at about five minutes, although `historian_timeout_ms` defaults to 600000. This is a likely Bun `fetch` default timeout somewhere on the historian prompt path; it was not traced.

On a slow local model with thinking on, the historian therefore never publishes. The session then depends on force-band drops alone, and each abandoned historian prompt still occupies the single-slot server. The relay used in this run kept reading an abandoned reply after OpenCode gave up, which lengthened these turns further. It now aborts the upstream request when its caller disconnects. That fix is covered by a test, but did not run in a live arm.

## Neutral wording (built, not run)

Chosen wording: **`(removed: tag N)`** for a dropped item and **`(removed)`** for a message Magic Context emptied entirely (master: `[dropped]`).

- **No bracket and no `§`.** The reporter's model copies two bracket shapes: `[dropped §N§]`, and the bare `[dropped]` whole-message sentinel, which their `§N§ [dropped]` ritual matches exactly. Parentheses and lowercase prose remove both the bracket shape and the tag notation the guidance tells the model to write at the start of its replies.
- **Still names the tag.** "tag N" is the same phrasing the guidance asks the model to use when it refers to an item in prose. `ctx_expand` already accepts `tag 12`.
- **A pure function of N.** The bytes are stable across passes, so the prompt cache is unaffected. The unit test pins identical output on repeated passes.

The switch rewrites the finished provider request:

- Tool results, user text and assistant text are rewritten only when they consist of nothing but markers, so a file that merely mentions a placeholder reaches the model unchanged.
- The dropped-input marker `{"dropped":"[dropped §N§]"}` becomes `{"removed":"(removed: tag N)"}`.
- The system prompt and tool descriptions that document `[dropped §N§]` say `(removed: tag N)` instead.

The wrapper plugin maps a copied `(removed: tag N)` in tool arguments back to the bracket form before master's dropped-input guard runs, so the guard refuses it exactly as it would refuse the bracket form, and rewords the refusal. That mapping has no live run behind it.

Not covered by the switch:

- master's marker-only neutralization would not recognise an echoed `(removed: tag N)`;
- a guard refusal that quotes the placeholder is not rewritten.

## Limits

- **Thinking off.** The reporter runs reasoning effort xhigh. Thinking on was infeasible for a long run on this server: about 23 h per 300 turns, and the historian could not finish at all. The thinking-on sample is 11 turns.
- **Quant and engine.** The reporter's model is `qwen3.8-27b-nvfp4` on their own engine. This run used a GGUF `UD-Q4_K_M` build of the same base model under llama.cpp.
- **Session length.** The reporter saw the ritual after a few hundred messages, at tags in the 600s, over about 2 hours. Arm A reached §616§ over 3.5 hours of turns, which is comparable, but it is one session.
- **Exposure.** The historian worked here and kept the served placeholders to at most 12 per request. The reporter's session had 356 dropped rows, so their in-context exposure was probably far higher. That is plausible if their historian rarely published. The whole-message `[dropped]` sentinel, which their ritual matches exactly, never appeared in arm A's context, because the model never produced a marker-only message for Magic Context to neutralize.
- **Host.** This used OpenCode 1. The reporter uses OpenCode 2. There, a model-echoed `§N§` is persisted verbatim, and the V1 storage strip does not apply (`packages/plugin/PARITY.md`), so echoes are served back more readily.

## Recommendation

- **Keep `[dropped §N§]` for now.** In 150 turns on a weak local model it produced no imitation, no guard refusals and no marker-only replies, with drops served throughout and the 0.45 guidance on.
- **Watch the whole-message `[dropped]` sentinel, not the tagged placeholder.** The reporter's ritual (`§N§ [dropped]`) copies the sentinel, which only enters context after the model has already produced a marker-only message. That is a feedback loop: a marker-only reply is neutralized to `[dropped]`, the model sees `[dropped]` as an assistant turn, and it copies it. The trial could not trigger that loop. To test it directly, seed a session with a few neutralized marker-only turns and measure. A cheap change is to neutralize to an empty or a neutral sentinel such as `(removed)` for providers that accept it. That needs no change to the tagged placeholder, so `ctx_expand` and cache behaviour are unaffected.
- **No guidance change for weak models on this evidence.** Leading tags were 97% correct. Tag-only parts were rare (2 in about 235 text-bearing calls) and isolated. The marker-only neutralization already covers them.
- **Separate finding, worth its own issue:** historian prompts on slow local models fail at about five minutes with `TimeoutError` despite `historian_timeout_ms: 600000`, and with thinking on they never publish.

## Reproduce

```sh
cd packages/plugin && bun run build
UNSLOTH_API_KEY=… bun scripts/priming-trial/run.ts --arm bracket --label armA --turns 150 --thinking off
UNSLOTH_API_KEY=… bun scripts/priming-trial/run.ts --arm neutral --label armB --turns 150 --thinking off
bun scripts/priming-trial/analyze.ts --out <dir> armA=<run root> armB=<run root>
```

A run resumes from its last completed turn with `--root <run root>`. Detach long runs from the shell (`nohup … &`), because a tool-managed shell may kill them on timeout. That is how the smoke was first interrupted.

## Files

- `packages/plugin/scripts/priming-trial/`: the wrapper plugin, relay, runner, workload script, analysis, and unit tests for the placeholder rewrite and the relay.
- `docs/reports/issue-563-priming-trajectories/`:
  - `arm-a-bracket-thinking-off.md`: all 150 turns;
  - `thinking-on-11-turns.md`;
  - `smoke-thinking-off.md`;
  - `summary.json`: per-bucket measures, first appearances, excerpts and historian outcomes.

  Local paths are replaced with `<run>`, `<tmp>` and `<home>`. No key appears in any of them.

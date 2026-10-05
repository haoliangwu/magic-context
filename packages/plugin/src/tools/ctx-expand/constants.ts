export const CTX_EXPAND_DESCRIPTION = `Recover original content that is no longer on your desk. It takes two kinds of number, and they are never interchangeable:
- \`tag=N\`: the number from a §N§ tag or a \`[dropped §N§]\` placeholder. Returns that one item whole: a text, or a tool call with its full input and output.
- \`message=N\`, \`start\`/\`end\`: message ordinals, the positions shown in \`<session-history>\` headings (\`## start-end\`) and in \`ctx_search\` hits. An ordinal counts whole messages; a tag counts each text and tool result separately, so the same number points at different things.

Earlier turns are summarized in <session-history> under \`## start-end · date · title\` headings; each heading stands for the raw messages in that ordinal range. When the summary isn't enough — exact wording, a value, an error message, the reasoning behind a decision — expand the range: ctx_expand(start=120, end=245). Also works around a ctx_search message hit: start=N-10, end=N+5. Ranges after the last compartment are your live tail — already visible, not expandable.

Returns the raw transcript as [N] U:/A: lines, capped at ~15K tokens; an oversized range returns the head and says where to continue.

Finer recovery:
- verbose=true lists each message separately with its ordinal and a per-part preview (tool calls with output sizes) so you can pick one.
- message=N returns that one message in full — every text part and every tool call's complete input and output — from stored history. This is the way back to a tool output you released with ctx_reduce; if the message was deleted from history it says so.`;

export const CTX_EXPAND_TOKEN_BUDGET = 15_000;

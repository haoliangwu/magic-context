export const CTX_REDUCE_DESCRIPTION = `Mark spent tagged content as discardable to reclaim context space. This is NOT an immediate delete. Use \u00a7N\u00a7 identifiers visible in the conversation. The \`drop\` param accepts ranges: "3-5", "1,2,9", "1-5,8".

How it works:
- Marking QUEUES content for release. It stays fully visible to you until it is actually released, which may be the next turn or many turns later. Mark spent outputs as soon as you finish with them; don't hoard the call for the end of the turn.
- The newest tags are protected: marking one just queues it until it ages out of the recent window, so marking recent output is harmless.
- When content is finally released it becomes a short placeholder, and re-running the tool is the only way to get it back. So mark only what you are genuinely DONE with \u2014 the test is "have I extracted what I need from this?", not "is it safe / do I have time before it drops?".

Mark discardable once processed: large outputs you've summarized, repeated or redundant dumps, data written to disk, status/log output that only confirmed an expected state.
Keep: user messages, unresolved errors, raw evidence you haven't extracted yet, and outputs whose exact wording may matter later.
Never blanket-mark large ranges (e.g. "1-50") \u2014 review what each tag holds first.`;

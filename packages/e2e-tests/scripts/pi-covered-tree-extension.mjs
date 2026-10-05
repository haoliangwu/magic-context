// The RPC protocol exposes fork but not the interactive /tree navigation command.
// Drive the same AgentSession.navigateTree path through an isolated extension command.
export default function registerCoveredTreeProbe(pi) {
  pi.registerCommand("e2e-covered-tree", {
    description: "Navigate to a selected Pi session-tree entry without summarizing its branch",
    async handler(entryId, ctx) {
      const result = await ctx.navigateTree(entryId.trim(), { summarize: false });
      if (result.cancelled) throw new Error(`Tree navigation cancelled for ${entryId}`);
    },
  });
}

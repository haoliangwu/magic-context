export function classifyContentionTurn(
	log: string,
	providerRequests: number,
	idleOutcome?: string,
) {
	return {
		refused:
			/refusing this turn before the model call|v2 refusal: interrupting the turn before the provider request|storage-busy refusal/.test(
				log,
			),
		replay: log.includes("lkg_replay_served"),
		result:
			idleOutcome === "succeeded" && providerRequests > 0
				? "provider-succeeded"
				: `idle:${idleOutcome ?? "missing"}`,
	};
}

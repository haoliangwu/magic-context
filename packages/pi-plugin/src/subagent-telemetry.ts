import { createHash } from "node:crypto";
import { buildHiddenAgentRegistrations } from "@magic-context/core/agents/hidden-agent-registrations";

// Read the registrations themselves so Pi and OpenCode cannot drift on task budgets.
const stepCaps = new Map(
	buildHiddenAgentRegistrations({
		dreamerPrompt: undefined,
		historianPrompt: undefined,
		historianEditorPrompt: undefined,
		historianDisallowed: [],
	}).map(({ id, maxSteps }) => [id, maxSteps]),
);

export function subagentStepCap(agent: string): number | undefined {
	return stepCaps.get(agent.replace(/^magic-context-/, ""));
}

export function promptFingerprint(prompt: string) {
	return {
		bytes: Buffer.byteLength(prompt, "utf8"),
		sha256: createHash("sha256").update(prompt).digest("hex"),
	};
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

/** Content-free, scalar telemetry for one child process (not the whole retry chain). */
export class SubagentTelemetry {
	steps = 0;
	readonly intended;
	effective: { bytes: number; sha256: string } | null = null;
	readonly tools: Record<string, { calls: number; outputBytes: number }> =
		Object.create(null);
	readonly promptTokens: {
		first: number | null;
		last: number | null;
		max: number | null;
	} = {
		first: null,
		last: null,
		max: null,
	};
	private warned = false;
	private streamedSteps = 0;
	private terminalSeen = false;
	private readonly results = new Set<string>();

	constructor(
		prompt: string,
		private readonly log: (line: string) => void,
	) {
		this.intended = promptFingerprint(prompt);
	}

	observe(value: unknown): void {
		const event = record(value);
		if (
			event.type === "mc_system_prompt" &&
			typeof event.bytes === "number" &&
			typeof event.sha256 === "string" &&
			/^[a-f0-9]{64}$/.test(event.sha256)
		) {
			this.effective = { bytes: event.bytes, sha256: event.sha256 };
			if (!this.warned && event.sha256 !== this.intended.sha256) {
				this.warned = true;
				this.log(
					`subagent_system_prompt_${event.containsIntended === true ? "extended" : "replaced"} ${JSON.stringify({ intended: this.intended, effective: this.effective, extension: null })}`,
				);
			}
		}
		if (event.type === "message_end") {
			if (record(event.message).role === "assistant") {
				this.streamedSteps++;
				this.assistant(event.message);
			}
		}
		// Pi emits assistant message_end events and repeats them in agent_end.messages.
		// Use the terminal array only for steps missing from the individual events.
		if (
			event.type === "agent_end" &&
			Array.isArray(event.messages) &&
			!this.terminalSeen
		) {
			this.terminalSeen = true;
			const assistants = event.messages.filter(
				(message) => record(message).role === "assistant",
			);
			for (const message of assistants.slice(this.streamedSteps))
				this.assistant(message);
		}
		if (
			event.type === "tool_execution_end" &&
			typeof event.toolCallId === "string" &&
			typeof event.toolName === "string" &&
			!this.results.has(event.toolCallId)
		) {
			this.results.add(event.toolCallId);
			const tool = this.tool(event.toolName);
			const content = record(event.result).content;
			if (Array.isArray(content))
				for (const part of content) {
					const block = record(part);
					// Text is measured in UTF-8 bytes; image payloads in encoded bytes.
					const text =
						typeof block.text === "string"
							? block.text
							: typeof block.data === "string"
								? block.data
								: "";
					tool.outputBytes += Buffer.byteLength(text, "utf8");
				}
		}
	}

	private tool(name: string) {
		this.tools[name] ??= { calls: 0, outputBytes: 0 };
		return this.tools[name];
	}

	private assistant(value: unknown) {
		const message = record(value);
		this.steps++;
		const usage = record(message.usage);
		const fields = [usage.input, usage.cacheRead, usage.cacheWrite];
		const known = fields.some(
			(value) => typeof value === "number" && Number.isFinite(value),
		);
		const tokens = known
			? fields.reduce<number>(
					(sum, value) =>
						sum +
						(typeof value === "number" && Number.isFinite(value) ? value : 0),
					0,
				)
			: null;
		if (this.steps === 1) this.promptTokens.first = tokens;
		this.promptTokens.last = tokens;
		if (tokens !== null)
			this.promptTokens.max = Math.max(this.promptTokens.max ?? 0, tokens);
		if (Array.isArray(message.content))
			for (const part of message.content) {
				const call = record(part);
				if (call.type === "toolCall" && typeof call.name === "string")
					this.tool(call.name).calls++;
			}
	}

	finish(agent: string, outcome: string, cap: number | undefined): void {
		this.log(
			`subagent_telemetry ${JSON.stringify({ agent, outcome, cap, steps: this.steps, tools: this.tools, promptTokens: this.promptTokens, intended: this.intended, effective: this.effective, provenanceSource: this.effective ? "pi_context_system_prompt" : "unavailable" })}`,
		);
	}
}

/** Keep transcript mentions literal instead of letting OMP attach files or resolve internal URLs. */
export function neutralizeOmpMentions(text: string): string {
	// OMP accepts these characters before a mention. WORD JOINER is not
	// whitespace, so placing it before @ defeats the boundary check without
	// changing the path after @ (including quoted paths).
	return text.replace(/(^|[\s([{<"'`])@/g, "$1\u2060@");
}

/** Turn WORD JOINER plus @ back into @ in decoded child output, without changing keys or other characters. */
export function restoreOmpMentions<T>(value: T): T {
	if (typeof value === "string") return value.replaceAll("\u2060@", "@") as T;
	if (Array.isArray(value)) return value.map(restoreOmpMentions) as T;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				restoreOmpMentions(entry),
			]),
		) as T;
	}
	return value;
}

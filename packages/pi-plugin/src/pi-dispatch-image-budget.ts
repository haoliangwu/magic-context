import type { PiChatHistoryModel } from "./pi-dispatch-chat-history";

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Scalar image references retain immutable strings, not message/block objects or copied bytes. */
export interface PiInputImage {
	kind: "data" | "url" | "file" | "bytes";
	value: string;
	mime?: string;
}

export interface PiImageRun {
	first: number;
	images: readonly PiInputImage[];
	hoisted?: boolean;
	synthesized?: boolean;
}

export interface PiImageBudgetPlan<Row> {
	count: number;
	api?: string;
	rows: Map<Row, PiImageRun>;
	hoistToolImages: boolean;
	hoistErrorImages: boolean;
}

export function piImageBudgetPlan<Row>(
	model: PiChatHistoryModel | undefined,
): PiImageBudgetPlan<Row> | undefined {
	if (
		!model?.input?.includes("image") ||
		object(model.compat)?.stripImageInput === true
	)
		return undefined;
	return {
		count: 0,
		api: model.api,
		rows: new Map(),
		hoistToolImages:
			(model.api?.startsWith("google-") === true &&
				object(model.compat)?.multimodalFunctionResponse !== true) ||
			(model.api === "bedrock-converse-stream" &&
				model.requiresToolResultImageHoisting === true),
		hoistErrorImages:
			model.api === "anthropic-messages" ||
			model.api === "bedrock-converse-stream",
	};
}

function inputImage(
	block: Record<string, unknown>,
	api?: string,
): PiInputImage {
	const file = object(block.providerFile);
	if (api === "ollama-chat")
		return { kind: "bytes", value: String(block.data ?? "") };
	if (
		((api?.endsWith("responses") && file?.provider === "openai") ||
			(api === "anthropic-messages" && file?.provider === "anthropic")) &&
		typeof file?.id === "string"
	)
		return { kind: "file", value: file.id };
	if (
		api?.startsWith("google-") &&
		file?.provider === "google" &&
		typeof file.uri === "string"
	)
		return { kind: "url", value: file.uri };
	if (api !== "bedrock-converse-stream" && typeof block.url === "string")
		return { kind: "url", value: block.url };
	return {
		kind: "data",
		value: typeof block.data === "string" ? block.data : "",
		mime: typeof block.mimeType === "string" ? block.mimeType : "",
	};
}

/** Record only eligible image identities and their order while prepared rows are already being built. */
export function piRecordImages<Row>(
	plan: PiImageBudgetPlan<Row> | undefined,
	row: Row,
	source: Record<string, unknown> | undefined,
): void {
	if (
		!plan ||
		!source ||
		!["user", "developer", "toolResult"].includes(String(source.role)) ||
		!Array.isArray(source.content)
	)
		return;
	const images: PiInputImage[] = [];
	for (const value of source.content) {
		const block = object(value);
		if (block?.type === "image") images.push(inputImage(block, plan.api));
	}
	if (!images.length) return;
	plan.rows.set(row, {
		first: plan.count,
		images,
		hoisted:
			source.role === "toolResult" &&
			(plan.hoistToolImages ||
				(source.isError === true && plan.hoistErrorImages)),
	});
	plan.count += images.length;
}

export function piRemainingImages(
	run: PiImageRun,
	drops: number,
): readonly PiInputImage[] {
	return run.images.slice(
		Math.max(0, Math.min(run.images.length, drops - run.first)),
	);
}

/** Inspect native image blocks only. Provider text rewrites are deliberately outside this comparison. */
export function piWireImages(
	content: unknown,
	ollamaImages?: unknown,
): PiInputImage[] {
	if (Array.isArray(ollamaImages))
		return ollamaImages.map((value) => ({
			kind: "bytes",
			value: String(value),
		}));
	if (!Array.isArray(content)) return [];
	const images: PiInputImage[] = [];
	for (const value of content) {
		const block = object(value);
		if (!block) continue;
		const source = object(block.source);
		const inline = object(block.inlineData);
		const file = object(block.fileData);
		const bedrock = object(block.image);
		if (block.type === "image_url" || block.type === "input_image") {
			if (typeof block.file_id === "string")
				images.push({ kind: "file", value: block.file_id });
			else
				images.push({
					kind: "url",
					value: String(
						typeof block.image_url === "string"
							? block.image_url
							: object(block.image_url)?.url,
					),
				});
		} else if (block.type === "image") {
			if (source?.type === "file")
				images.push({ kind: "file", value: String(source.file_id) });
			else if (source?.type === "url")
				images.push({ kind: "url", value: String(source.url) });
			else
				images.push({
					kind: "data",
					value: String(source?.data),
					mime: String(source?.media_type),
				});
		} else if (inline)
			images.push({
				kind: "data",
				value: String(inline.data),
				mime: String(inline.mimeType),
			});
		else if (file) images.push({ kind: "url", value: String(file.fileUri) });
		else if (bedrock)
			images.push({
				kind: "data",
				value: String(object(bedrock.source)?.bytes),
				mime: `image/${bedrock.format}`,
			});
	}
	return images;
}

export function piMatchesImages(
	actual: readonly PiInputImage[],
	expected: readonly PiInputImage[],
): boolean {
	if (actual.length !== expected.length) return false;
	for (let index = 0; index < expected.length; index++) {
		const a = actual[index];
		const e = expected[index];
		if (e.kind === "data" && a.kind === "url") {
			const prefix = `data:${e.mime};base64,`;
			if (
				a.value.length !== prefix.length + e.value.length ||
				!a.value.startsWith(prefix) ||
				!a.value.endsWith(e.value)
			)
				return false;
		} else if (
			a.kind !== e.kind ||
			a.value !== e.value ||
			a.mime?.replace("image/jpg", "image/jpeg") !==
				e.mime?.replace("image/jpg", "image/jpeg")
		)
			return false;
	}
	return true;
}

/** Count native input images, including images nested inside tool outputs. */
export function piWireImageCount(payload: unknown): number {
	const body = object(payload);
	const visit = (value: unknown): number => {
		if (Array.isArray(value))
			return value.reduce((n, item) => n + visit(item), 0);
		const block = object(value);
		if (!block) return 0;
		if (
			["image", "image_url", "input_image"].includes(String(block.type)) ||
			block.inlineData ||
			block.fileData ||
			block.image
		)
			return 1;
		return [
			block.content,
			block.output,
			block.parts,
			block.toolResult,
			block.functionResponse,
			block.response,
		].reduce<number>(
			(n, item) => n + visit(item),
			Array.isArray(block.images) ? block.images.length : 0,
		);
	};
	return visit(
		body?.messages ??
			body?.input ??
			body?.contents ??
			object(body?.request)?.contents,
	);
}

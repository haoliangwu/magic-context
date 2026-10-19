import {
	exactReusablePrefix,
	type LkgContentField,
	lkgContentFields,
} from "@magic-context/core/hooks/magic-context/lkg-slot";

interface IdentityInput {
	id: string;
	fields: readonly LkgContentField[];
	header: string | null;
	fingerprint: string | null;
	owners: Map<string, Set<string>>;
}

/** Uses LKG's exact detached-field validation; only the changed suffix is indexed. */
export function createPiFallbackIndex() {
	const prior: IdentityInput[] = [];
	let priorHadDuplicateIds = false;
	const byHeader = new Map<string, Set<IdentityInput>>();
	const positions = new Map<string, number>();
	const owners = new Map<string, Set<string>>();
	let rebuilt = 0;
	return {
		get rebuiltMessages() {
			return rebuilt;
		},
		update<T>(args: {
			messages: readonly T[];
			resolveId: (message: T, index: number) => string | undefined;
			fields?: WeakMap<object, readonly LkgContentField[]>;
			header: (message: T) => string | null;
			fingerprint: (message: T) => string | null;
			toolOwners: (message: T, id: string) => Map<string, Set<string>>;
			reusable?: ReadonlySet<string>;
		}) {
			const selected = new Map<string, string>();
			const guardIndexes: number[] = [];
			const inputs: { id: string; fields: readonly LkgContentField[] }[] = [];
			const seen = new Set<string>();
			let duplicate = false;
			for (let index = 0; index < args.messages.length; index++) {
				const message = args.messages[index] as T;
				const id = args.resolveId(message, index) ?? `unmapped:${index}`;
				if (seen.has(id)) duplicate = true;
				seen.add(id);
				const fields =
					(message && typeof message === "object"
						? args.fields?.get(message)
						: undefined) ??
					lkgContentFields(
						message && typeof message === "object"
							? {
									role: (message as Record<string, unknown>).role,
									timestamp: (message as Record<string, unknown>).timestamp,
									responseId: (message as Record<string, unknown>).responseId,
									toolCallId: (message as Record<string, unknown>).toolCallId,
									content: (message as Record<string, unknown>).content,
								}
							: message,
					);
				// Unflattenable inputs must never reuse a prior fingerprint.
				inputs.push({ id, fields: fields ?? [Symbol()] });
			}
			let prefix = priorHadDuplicateIds
				? 0
				: exactReusablePrefix(inputs, prior);
			if (duplicate) {
				prefix = 0;
				selected.clear();
			}
			// A deleted duplicate may share memberships with a retained prefix row.
			// Rebuild when leaving that state instead of deleting the survivor's aliases.
			priorHadDuplicateIds = duplicate;
			for (let index = 0; index < prefix; index++) {
				const old = prior[index];
				if (old && !args.reusable?.has(old.id)) {
					guardIndexes.push(index);
					if (old.fingerprint) selected.set(old.id, old.fingerprint);
				}
			}
			// Removal, reorder, context_edit and extension rewrites all discard the
			// suffix at the first exact id/field mismatch, including its owner aliases.
			for (const old of prior.slice(prefix)) {
				positions.delete(old.id);
				if (old.header) {
					const bucket = byHeader.get(old.header);
					bucket?.delete(old);
					if (!bucket?.size) byHeader.delete(old.header);
				}
				for (const [key, ids] of old.owners) {
					const bucket = owners.get(key);
					for (const id of ids) bucket?.delete(id);
					if (!bucket?.size) owners.delete(key);
				}
			}
			prior.length = prefix;
			for (let index = prefix; index < args.messages.length; index++) {
				guardIndexes.push(index);
				const message = args.messages[index] as T;
				const input = inputs[index];
				if (!input) continue;
				const record: IdentityInput = {
					...input,
					header: args.header(message),
					fingerprint: input.id.startsWith("unmapped:")
						? null
						: args.fingerprint(message),
					owners: input.id.startsWith("unmapped:")
						? new Map()
						: args.toolOwners(message, input.id),
				};
				rebuilt++;
				prior.push(record);
				if (!positions.has(record.id)) positions.set(record.id, index);
				if (record.header) {
					const bucket = byHeader.get(record.header) ?? new Set();
					bucket.add(record);
					byHeader.set(record.header, bucket);
				}
				for (const [key, ids] of record.owners) {
					const bucket = owners.get(key) ?? new Set();
					for (const id of ids) bucket.add(id);
					owners.set(key, bucket);
				}
				if (!args.reusable?.has(record.id) && record.fingerprint)
					selected.set(record.id, record.fingerprint);
			}
			return {
				positions,
				owners,
				changedFrom: prefix,
				guardIndexes,
				fingerprints(headers?: ReadonlySet<string> | null) {
					const result = new Map(selected);
					const records = headers
						? [...headers].flatMap((header) => [
								...(byHeader.get(header) ?? []),
							])
						: headers === null
							? prior
							: [];
					for (const record of records)
						if (record.fingerprint) result.set(record.id, record.fingerprint);
					return result;
				},
			};
		},
	};
}

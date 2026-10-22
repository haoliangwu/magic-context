import type { PiHydrationOperation } from "./tag-snapshot-worker-client-pi";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Decode one row/field at a time without a per-row binary deserializer. The
 * binary codec accumulated disposable row/decoder allocations on Node until
 * major collection; JSON reduces that pressure without a full-snapshot parse.
 * SQL values are scalars; the reserved wrapper cannot collide with row keys.
 */
export function encodePiHydrationOperation(operation: PiHydrationOperation) {
	return encoder.encode(
		JSON.stringify(operation, (_key, value) => {
			if (value instanceof Uint8Array)
				return { $piScalar: "bytes", value: Array.from(value) };
			if (
				typeof value === "number" &&
				(!Number.isFinite(value) || Object.is(value, -0))
			)
				return {
					$piScalar: "number",
					value: Object.is(value, -0) ? "-0" : String(value),
				};
			if (value === undefined) return { $piScalar: "undefined" };
			return value;
		}),
	);
}

export function decodePiHydrationOperation(
	bytes: Uint8Array,
): PiHydrationOperation {
	const operation = JSON.parse(decoder.decode(bytes));
	// JSON revivers delete undefined properties. Restore scalars explicitly so
	// identity comparison sees the same own fields as the synchronous mapper.
	const restore = (value: Record<string, unknown>) => {
		for (const key of Object.keys(value)) {
			const scalar = value[key] as {
				$piScalar?: string;
				value?: unknown;
			} | null;
			if (!scalar || typeof scalar !== "object") continue;
			if (scalar.$piScalar === "bytes")
				value[key] = Uint8Array.from(scalar.value as number[]);
			else if (scalar.$piScalar === "undefined") value[key] = undefined;
			else if (scalar.$piScalar === "number")
				value[key] = scalar.value === "-0" ? -0 : Number(scalar.value);
		}
	};
	if (operation.type === "row") restore(operation.value);
	else if (operation.type === "field") restore(operation);
	return operation;
}

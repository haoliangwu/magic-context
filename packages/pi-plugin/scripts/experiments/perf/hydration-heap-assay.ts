import { readFileSync } from "node:fs";

interface HeapSnapshot {
	snapshot: {
		meta: {
			node_fields: string[];
			node_types: [string[], ...unknown[]];
			edge_fields: string[];
			edge_types: [string[], ...unknown[]];
		};
	};
	nodes: number[];
	edges: number[];
	strings: string[];
}

/** Count actual normalized row objects by three string-valued properties.
 * Integer fields such as tagNumber have no heap edge when stored as small
 * immediate integers (SMIs);
 * counting those edges would incorrectly report zero even for retained rows.
 */
export function countHydratedRows(path: string): number {
	const heap = JSON.parse(readFileSync(path, "utf8")) as HeapSnapshot;
	const meta = heap.snapshot.meta;
	const field = (fields: string[], name: string) => {
		const index = fields.indexOf(name);
		if (index < 0) throw new Error(`Heap snapshot lacks ${name}`);
		return index;
	};
	const nodeSize = meta.node_fields.length;
	const edgeSize = meta.edge_fields.length;
	const nodeType = field(meta.node_fields, "type");
	const nodeName = field(meta.node_fields, "name");
	const edgeCount = field(meta.node_fields, "edge_count");
	const edgeType = field(meta.edge_fields, "type");
	const edgeName = field(meta.edge_fields, "name_or_index");
	const target = field(meta.edge_fields, "to_node");
	if (heap.nodes.length % nodeSize || heap.edges.length % edgeSize)
		throw new Error("Malformed heap snapshot strides");
	let edgeOffset = 0;
	let rows = 0;
	for (let offset = 0; offset < heap.nodes.length; offset += nodeSize) {
		const end = edgeOffset + heap.nodes[offset + edgeCount] * edgeSize;
		let fields = 0;
		if (meta.node_types[0][heap.nodes[offset + nodeType]] === "object") {
			for (let e = edgeOffset; e < end; e += edgeSize) {
				if (meta.edge_types[0][heap.edges[e + edgeType]] !== "property")
					continue;
				const to = heap.edges[e + target];
				const kind = meta.node_types[0][heap.nodes[to + nodeType]];
				if (!kind.includes("string")) continue;
				const key = heap.strings[heap.edges[e + edgeName]];
				const value = heap.strings[heap.nodes[to + nodeName]];
				if (key === "messageId") fields |= 1;
				if (key === "type" && ["message", "tool", "file"].includes(value))
					fields |= 2;
				if (
					key === "status" &&
					["active", "dropped", "compacted"].includes(value)
				)
					fields |= 4;
			}
		}
		if (fields === 7) rows++;
		edgeOffset = end;
	}
	if (edgeOffset !== heap.edges.length)
		throw new Error("Heap edge counts do not cover the graph");
	return rows;
}

const [retainedPath, releasedPath, minimum = "200000"] = process.argv.slice(2);
if (!retainedPath || !releasedPath)
	throw new Error(
		"Usage: hydration-heap-assay retained.heapsnapshot released.heapsnapshot [minimumRows]",
	);
const min = Number(minimum);
if (!Number.isInteger(min) || min <= 0)
	throw new Error("minimumRows must be a positive integer");
const retained = countHydratedRows(retainedPath);
const released = countHydratedRows(releasedPath);
console.log(
	JSON.stringify({
		assay: "normalized tag-row heap retention",
		retainedPositiveControl: retained,
		released,
		minimumRows: min,
		pass: retained >= min && released === 0,
	}),
);
if (retained < min || released !== 0) process.exitCode = 1;

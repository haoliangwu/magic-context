/// <reference types="bun" />

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getNativeToolInputs } from "@magic-context/core/features/magic-context/storage-native-replay";
import { fixture } from "./overwall-upgrade-replay.fixture";
import { createTestDb } from "./test-utils.test";

const mode = process.env.MC_OVERWALL_RESTART_MODE;
const root = process.env.MC_OVERWALL_RESTART_DIR;
if (!root || (mode !== "mint" && mode !== "replay"))
	throw new Error("missing restart phase or isolated directory");
const f = fixture(
	process.env.MC_OVERWALL_RESTART_NATIVE === "true",
	10,
	createTestDb(join(root, "context.db")),
	"process-restart",
);
try {
	console.log(`READY ${mode}`);
	if ((await Bun.stdin.text()) !== "GO\n")
		throw new Error("missing parent start signal");
	if (mode === "mint") await f.seed();
	const messages = await f.pass(mode === "mint" ? 90 : 0);
	const markers = [...getNativeToolInputs(f.db, f.session)];
	writeFileSync(
		join(root, `${mode}.json`),
		JSON.stringify({ messages, markers }),
	);
} finally {
	f.close();
}
console.log(`DONE ${mode}`);
process.exit(0);

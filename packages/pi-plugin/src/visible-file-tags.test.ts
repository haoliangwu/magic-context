import { expect, test } from "bun:test";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { assistantMessage, createTestDb, textOf } from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

test("Pi: text plus image leaves the next visible number consecutive", () => {
	const db = createTestDb();
	try {
		const source = [
			{
				role: "user",
				content: [
					{ type: "text", text: "inspect this image" },
					{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
				],
				timestamp: 1,
			},
			assistantMessage("§2§ I can see it", 2),
		];
		const beforeImage = JSON.stringify(source[0].content[1]);
		const transcript = createPiTranscript(source, "visible-file-tags", [
			"user",
			"reply",
		]);
		tagTranscript("visible-file-tags", transcript, createTagger(), db);
		transcript.commit();
		expect(textOf(source[0] as never)).toBe("§1§ inspect this image");
		expect(textOf(source[1] as never)).toBe("§2§ I can see it");
		expect(JSON.stringify(source[0].content[1])).toBe(beforeImage);
		expect(
			getTagsBySession(db, "visible-file-tags").map((tag) => tag.type),
		).toEqual(["message", "message"]);
	} finally {
		db.close();
	}
});

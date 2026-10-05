import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { UserMemory } from "../../features/magic-context/user-memory/storage-user-memory";
import { renderM0 } from "./inject-compartments";
import { renderUserProfileContent } from "./user-profile-render";

interface UserProfileRenderFixture {
    cases: Array<{ input: string; expected: string }>;
}

const fixture = JSON.parse(
    readFileSync(
        resolve(import.meta.dir, "../../../../../tests/fixtures/user-profile-render.json"),
        "utf8",
    ),
) as UserProfileRenderFixture;

describe("user-profile content rendering", () => {
    it("matches the shared Rust/TypeScript fixture", () => {
        for (const { input, expected } of fixture.cases) {
            expect(renderUserProfileContent(input)).toBe(expected);
        }

        const profile: UserMemory[] = fixture.cases.map(({ input }, index) => ({
            id: index + 1,
            content: input,
            status: "active",
            promotedAt: 0,
            sourceCandidateIds: [],
            sourceProvenance: null,
            createdAt: 0,
            updatedAt: 0,
        }));
        const rendered = renderM0({
            projectDocs: "",
            userProfileBaseline: profile,
            compartments: [],
            memories: [],
            facts: [],
            userProfileBudgetTokens: 10_000,
        });
        const expectedBlock = [
            "<user-profile>",
            ...fixture.cases.map(({ expected }) => `- ${expected}`),
            "</user-profile>",
        ].join("\n");
        expect(rendered).toContain(expectedBlock);
    });
});

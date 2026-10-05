import { expect, test } from "bun:test";
import { cacheV2SessionDirectory } from "./context";

function hostSession(answers: Array<unknown>) {
    const calls: string[] = [];
    return {
        calls,
        session: {
            get: async ({ sessionID }: { sessionID: string }) => {
                calls.push(sessionID);
                const answer = answers.shift();
                if (answer instanceof Error) throw answer;
                return answer as { location?: { directory?: string } };
            },
        },
    };
}

test("caches the host-bound session directory and asks the host only once", async () => {
    const host = hostSession([{ location: { directory: "/work/project" } }]);
    const directories = new Map<string, string>();
    await cacheV2SessionDirectory(host.session, "ses_1", directories);
    await cacheV2SessionDirectory(host.session, "ses_1", directories);
    expect(directories.get("ses_1")).toBe("/work/project");
    expect(host.calls).toEqual(["ses_1"]);
});

test("leaves the session unresolved when the host has no directory, then retries", async () => {
    const host = hostSession([
        {},
        { location: { directory: "" } },
        new Error("host unavailable"),
        { location: { directory: "/work/project" } },
    ]);
    const directories = new Map<string, string>();
    for (let pass = 0; pass < 3; pass++) {
        await cacheV2SessionDirectory(host.session, "ses_1", directories);
        expect(directories.has("ses_1")).toBe(false);
    }
    await cacheV2SessionDirectory(host.session, "ses_1", directories);
    expect(directories.get("ses_1")).toBe("/work/project");
    expect(host.calls).toHaveLength(4);
});

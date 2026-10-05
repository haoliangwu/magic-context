import { afterEach, describe, expect, test } from "bun:test";

const originalHfEndpoint = process.env.HF_ENDPOINT;

async function importFreshWebEntry() {
    return import(`./transformers-web-entry.ts?hf-endpoint-test=${crypto.randomUUID()}`);
}

afterEach(() => {
    if (originalHfEndpoint === undefined) delete process.env.HF_ENDPOINT;
    else process.env.HF_ENDPOINT = originalHfEndpoint;
});

describe("Transformers.js web entry remote host", () => {
    test("uses HF_ENDPOINT with one trailing slash", async () => {
        process.env.HF_ENDPOINT = "https://mirror.example///";

        const { env } = await importFreshWebEntry();

        expect(env.remoteHost).toBe("https://mirror.example/");
    });

    test("uses the Transformers.js default without HF_ENDPOINT", async () => {
        delete process.env.HF_ENDPOINT;

        const { env } = await importFreshWebEntry();

        expect(env.remoteHost).toBe("https://huggingface.co/");
    });
});

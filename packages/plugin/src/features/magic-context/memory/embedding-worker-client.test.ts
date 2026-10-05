import { afterEach, describe, expect, test } from "bun:test";
import { getHarness } from "../../../shared/harness";
import {
    __resetStoragePrivatePermissionEnforcementForTests,
    setStoragePrivatePermissionEnforcement,
} from "../../../shared/storage-permissions";
import {
    __resetLocalEmbeddingForTests,
    __setLocalEmbeddingTestHooks,
    LocalEmbeddingProvider,
    resolveLocalEmbeddingWorkerRuntime,
} from "./embedding-local";
import { EmbeddingWorkerClient } from "./embedding-worker-client";

afterEach(() => {
    __resetLocalEmbeddingForTests();
    __resetStoragePrivatePermissionEnforcementForTests();
});

const entry = new URL("./embedding-worker.fixture.ts", import.meta.url);

describe("embedding worker transport", () => {
    test("worker inherits the resolved model cache, harness and trusted-group permission policy", async () => {
        let captured: Record<string, unknown> | undefined;
        setStoragePrivatePermissionEnforcement(false);
        __setLocalEmbeddingTestHooks({
            modelCacheDir: () => "/throwaway/custom-model-cache",
            workerFactory: (data) => {
                captured = data;
                return new EmbeddingWorkerClient(data, entry);
            },
        });
        const provider = new LocalEmbeddingProvider();
        expect(captured?.modelCacheDir).toBe("/throwaway/custom-model-cache");
        expect(captured?.harness).toBe(getHarness());
        expect(captured?.enforcePrivateStoragePermissions).toBe(false);
        await provider.dispose();
    });
    test("provider reports worker crashes and recovers lazily without changing its interface", async () => {
        __setLocalEmbeddingTestHooks({
            workerFactory: (data) => new EmbeddingWorkerClient(data, entry),
            log: () => {},
        });
        const provider = new LocalEmbeddingProvider();
        try {
            expect(await provider.embed("crash")).toBeNull();
            expect(provider.getLastFailureReason()?.reason).toContain("exited (7)");
            expect(provider.isLoaded()).toBe(false);
            expect(Array.from((await provider.embed("recovered"))!)).toEqual([9, 0.125, -0.25]);
            expect(provider.isLoaded()).toBe(true);
            expect(provider.getLastFailureReason()).toBeNull();
        } finally {
            await provider.dispose();
        }
    });

    test("old Bun worker teardown protection also overrides explicit native", () => {
        expect(
            resolveLocalEmbeddingWorkerRuntime("native", {
                isBun: true,
                isElectron: false,
                bunVersion: "1.3.14",
            }),
        ).toBe("wasm");
        expect(
            resolveLocalEmbeddingWorkerRuntime("native", {
                isBun: true,
                isElectron: false,
                bunVersion: "1.4.0",
            }),
        ).toBe("native");
        expect(
            resolveLocalEmbeddingWorkerRuntime("native", { isBun: false, isElectron: false }),
        ).toBe("native");
    });
    test("host timers remain responsive during a synchronous large batch", async () => {
        const client = new EmbeddingWorkerClient({}, entry);
        const lags: number[] = [];
        let last = performance.now();
        const timer = setInterval(() => {
            const now = performance.now();
            lags.push(Math.max(0, now - last - 50));
            last = now;
        }, 50);
        try {
            const result = await client.request(
                Array.from({ length: 128 }, () => "embedding input"),
            );
            expect(result.vectors).toHaveLength(128);
            expect(lags.length).toBeGreaterThanOrEqual(4);
            const sorted = lags.sort((a, b) => a - b);
            expect(sorted[Math.ceil(sorted.length * 0.99) - 1]).toBeLessThan(100);
        } finally {
            clearInterval(timer);
            await client.dispose();
        }
    });

    test("transferred vectors preserve float32 bits", async () => {
        const client = new EmbeddingWorkerClient({}, entry);
        try {
            const result = await client.request(["hello", "world!"]);
            expect(result.vectors?.map((vector) => Array.from(vector ?? []))).toEqual([
                [5, 0.125, -0.25],
                [6, 0.125, -0.25],
            ]);
            expect(result.vectors?.[0]).toBeInstanceOf(Float32Array);
        } finally {
            await client.dispose();
        }
    });

    test("worker crash rejects outstanding requests and a later request recovers", async () => {
        const client = new EmbeddingWorkerClient({}, entry);
        try {
            await expect(client.request(["crash"])).rejects.toThrow("embedding worker exited (7)");
            expect((await client.request(["recovered"])).vectors?.[0]?.[0]).toBe(9);
        } finally {
            await client.dispose();
        }
    });

    test("unresponsive worker times out all pending callers and restarts on the next request", async () => {
        const client = new EmbeddingWorkerClient({}, entry, 1000);
        try {
            await client.request();
            await Promise.all([
                expect(client.request(["hang-a"])).rejects.toThrow("timed out"),
                expect(client.request(["hang-b"])).rejects.toThrow("timed out"),
            ]);
            expect((await client.request(["recovered"])).vectors?.[0]?.[0]).toBe(9);
        } finally {
            await client.dispose();
        }
    });

    test("aborted caller settles without waiting for inference", async () => {
        const client = new EmbeddingWorkerClient({}, entry);
        const controller = new AbortController();
        try {
            const request = client.request(["slow"], controller.signal);
            controller.abort();
            await expect(request).rejects.toThrow("aborted");
        } finally {
            await client.dispose();
        }
    });

    test("idle worker does not prevent clean process exit", async () => {
        const script = `import { EmbeddingWorkerClient } from ${JSON.stringify(new URL("./embedding-worker-client.ts", import.meta.url).pathname)};
            const client = new EmbeddingWorkerClient({}, new URL(${JSON.stringify(entry.href)}));
            await client.request(["exit"]);`;
        const child = Bun.spawn([process.execPath, "-e", script], {
            stdout: "pipe",
            stderr: "pipe",
            windowsHide: true,
        });
        const timeout = setTimeout(() => child.kill(), 5000);
        try {
            expect(await child.exited).toBe(0);
        } finally {
            clearTimeout(timeout);
        }
    });
});

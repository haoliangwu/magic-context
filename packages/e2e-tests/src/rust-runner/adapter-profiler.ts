import { createConnection, createServer } from "node:net";
import type { SubcModuleTransport } from "../../../plugin/src/hooks/magic-context/module-transport";

type Frame = object;
type ProfiledClient = {
    dispatch(frame: Frame): void;
    decodeReply(frame: Frame): unknown;
    request(route: unknown, body: Uint8Array): Promise<unknown>;
};

/**
 * Test-only probes for the plugin's pinned subc-client 0.11.1 receive boundary.
 * Dispatch means a complete frame reached JavaScript, not kernel socket arrival.
 * Keeping these private-SDK probes out of production avoids coupling transport
 * correctness to undocumented SDK methods; fail loudly if the SDK changes them.
 */
export function profileAdapterReceive(transport: SubcModuleTransport) {
    const client = (transport as unknown as { client: ProfiledClient }).client;
    if (
        !client ||
        typeof client.dispatch !== "function" ||
        typeof client.decodeReply !== "function"
    ) {
        throw new Error("subc-client receive profiling requires dispatch and decodeReply");
    }
    const dispatch = client.dispatch;
    const decode = client.decodeReply;
    const received = new WeakMap<Frame, number>();
    let decodeMs = 0;
    let dispatchToDecodeMs = 0;
    let decodedAt = 0;
    let frames = 0;
    let replyPages = 1;
    let lastTick = performance.now();
    let maxTimerLagMs = 0;
    const sampleTimer = () => {
        const now = performance.now();
        maxTimerLagMs = Math.max(maxTimerLagMs, now - lastTick - 1);
        lastTick = now;
    };
    const timer = setInterval(sampleTimer, 1);
    client.dispatch = function (frame) {
        received.set(frame, performance.now());
        return dispatch.call(this, frame);
    };
    client.decodeReply = function (frame) {
        const start = performance.now();
        const arrivedAt = received.get(frame);
        if (arrivedAt === undefined) throw new Error("reply decoded without a dispatch timestamp");
        dispatchToDecodeMs += start - arrivedAt;
        try {
            const reply = decode.call(this, frame);
            if (reply && typeof reply === "object" && "reply_page" in reply) {
                const page = (reply as { reply_page: { index: number; total: number } }).reply_page;
                if (page.index === 0) replyPages = page.total;
            }
            return reply;
        } finally {
            decodedAt = performance.now();
            decodeMs += decodedAt - start;
            frames++;
        }
    };
    return {
        async bareRequest(body: Uint8Array) {
            const routes = (transport as unknown as { routes: Map<string, { route: unknown }> })
                .routes;
            const route = routes.values().next().value?.route;
            if (!route) throw new Error("SDK comparison requires an already-open route");
            return client.request(route, body);
        },
        reset() {
            decodeMs = dispatchToDecodeMs = decodedAt = frames = maxTimerLagMs = 0;
            replyPages = 1;
            lastTick = performance.now();
        },
        sample() {
            const resumedAt = performance.now();
            sampleTimer();
            return {
                decodeMs,
                dispatchToDecodeMs,
                decodeToResumeMs: decodedAt ? resumedAt - decodedAt : 0,
                maxTimerLagMs,
                frames,
                replyPages,
            };
        },
        dispose() {
            clearInterval(timer);
            client.dispatch = dispatch;
            client.decodeReply = decode;
        },
    };
}

export function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Bare TCP echo includes the same request bytes and an equally sized reply. */
export async function measureLoopback(body: Uint8Array): Promise<number> {
    const server = createServer((socket) => socket.on("data", (data) => socket.write(data)));
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing TCP address");
    const socket = createConnection(address.port, "127.0.0.1");
    try {
        await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
        });
        const samples: number[] = [];
        for (let i = 0; i < 21; i++) {
            const startedAt = performance.now();
            await new Promise<void>((resolve, reject) => {
                let bytes = 0;
                const onError = (error: Error) => {
                    socket.off("data", onData);
                    reject(error);
                };
                const onData = (data: Buffer) => {
                    bytes += data.length;
                    if (bytes >= body.length) {
                        socket.off("data", onData);
                        socket.off("error", onError);
                        resolve();
                    }
                };
                socket.on("data", onData);
                socket.once("error", onError);
                socket.write(body);
            });
            if (i > 0) samples.push(performance.now() - startedAt);
        }
        return median(samples);
    } finally {
        socket.destroy();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
        );
    }
}

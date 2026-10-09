import { describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as https from "node:https";

import {
    createPinnedLookup,
    createSmartNoteRequestAgent,
    guardedSmartNoteHttpGet,
    requestValidatedAddress,
    type SmartNoteResolver,
    validateSmartNoteHttpUrl,
} from "./ssrf-guard";
import { SmartNoteNetworkError } from "./types";

const signal = new AbortController().signal;

function resolver(rows: Array<{ address: string; family: 4 | 6 }>): SmartNoteResolver {
    return { lookup: async () => rows };
}

describe("smart-note SSRF guard", () => {
    test("requires https", async () => {
        await expect(validateSmartNoteHttpUrl("http://example.com", { signal })).rejects.toThrow(
            /https/i,
        );
        await expect(validateSmartNoteHttpUrl("file:///etc/passwd", { signal })).rejects.toThrow();
    });

    test("blocks alternate IPv4 loopback encodings canonicalized by URL", async () => {
        for (const host of ["127.1", "0177.0.0.1", "0x7f.0.0.1", "2130706433"]) {
            await expect(validateSmartNoteHttpUrl(`https://${host}/`, { signal })).rejects.toThrow(
                /non-global|internal/i,
            );
        }
    });

    test("blocks private, link-local, metadata, CGNAT, multicast, and documentation IPv4", async () => {
        for (const address of [
            "10.0.0.1",
            "172.16.0.1",
            "192.168.0.1",
            "169.254.169.254",
            "169.254.1.10",
            "100.64.0.1",
            "224.0.0.1",
            "192.0.2.10",
            "198.51.100.10",
            "203.0.113.10",
        ]) {
            await expect(
                validateSmartNoteHttpUrl(`https://${address}/`, { signal }),
            ).rejects.toThrow(/non-global|internal/i);
        }
    });

    test("rejects every IPv6 DNS answer before address classification", async () => {
        for (const address of [
            "2606:2800:220:1:248:1893:25c8:1946",
            "64:ff9b::a00:5",
            "2001:4860:abcd::a00:5",
            "3fff::1",
            "::ffff:127.0.0.1",
            "fe80::1",
            "fc00::1",
            "fd00:ec2::254",
            "ff02::1",
            "2001:db8::1",
        ]) {
            await expect(
                validateSmartNoteHttpUrl("https://ipv6-only.example.test/", {
                    signal,
                    resolver: resolver([{ address, family: 6 }]),
                }),
            ).rejects.toBeInstanceOf(SmartNoteNetworkError);
        }
    });

    test("allows a dual-stack host and pins only its public IPv4 answer", async () => {
        const validated = await validateSmartNoteHttpUrl("https://dual-stack.example.test/", {
            signal,
            resolver: resolver([
                { address: "93.184.216.34", family: 4 },
                { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
            ]),
        });

        expect(validated.addresses).toEqual([
            { address: "93.184.216.34", family: 4, classification: "global" },
        ]);
    });

    test("rejects DNS answers with any private IPv4 address", async () => {
        await expect(
            validateSmartNoteHttpUrl("https://example.test/", {
                signal,
                resolver: resolver([
                    { address: "93.184.216.34", family: 4 },
                    { address: "10.0.0.2", family: 4 },
                ]),
            }),
        ).rejects.toThrow(/non-global|internal/i);
    });

    test("allows public IPv4 DNS answers and preserves all validated candidates", async () => {
        const validated = await validateSmartNoteHttpUrl("https://example.test/path", {
            signal,
            resolver: resolver([
                { address: "93.184.216.34", family: 4 },
                { address: "1.1.1.1", family: 4 },
            ]),
        });
        expect(validated.addresses.map((a) => a.address)).toEqual(["93.184.216.34", "1.1.1.1"]);
    });

    test("stops after a terminal per-target failure", async () => {
        const contacted: string[] = [];
        const requestAddress = mock(async (_validation, candidate) => {
            contacted.push(candidate.address);
            throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: response body too large", {
                terminal: true,
            });
        });

        const error = await guardedSmartNoteHttpGet("https://example.test/", {
            signal,
            resolver: resolver([
                { address: "93.184.216.34", family: 4 },
                { address: "1.1.1.1", family: 4 },
            ]),
            requestAddress,
        }).catch((error) => error);

        expect(error).toBeInstanceOf(SmartNoteNetworkError);
        expect((error as SmartNoteNetworkError).terminal).toBe(true);
        expect(contacted).toEqual(["93.184.216.34"]);
        expect(requestAddress.mock.calls).toHaveLength(1);
    });

    test("advances to the next address after a connection-level failure", async () => {
        const contacted: string[] = [];
        const requestAddress = mock(async (_validation, candidate) => {
            contacted.push(candidate.address);
            if (candidate.address === "93.184.216.34") {
                throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: connect ECONNREFUSED");
            }
            return { status: 200, body: "ok" };
        });

        const response = await guardedSmartNoteHttpGet("https://example.test/", {
            signal,
            resolver: resolver([
                { address: "93.184.216.34", family: 4 },
                { address: "1.1.1.1", family: 4 },
            ]),
            requestAddress,
        });

        expect(response).toEqual({ status: 200, body: "ok" });
        expect(contacted).toEqual(["93.184.216.34", "1.1.1.1"]);
        expect(requestAddress.mock.calls).toHaveLength(2);
    });

    test("caps the validated address fanout", async () => {
        const addresses = [
            "93.184.216.34",
            "1.1.1.1",
            "8.8.8.8",
            "151.101.1.69",
            "13.107.42.14",
            "208.67.222.222",
        ].map((address) => ({ address, family: 4 as const }));
        const contacted: string[] = [];
        const requestAddress = mock(async (_validation, candidate) => {
            contacted.push(candidate.address);
            throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: connect ECONNREFUSED");
        });

        const error = await guardedSmartNoteHttpGet("https://example.test/", {
            signal,
            resolver: resolver(addresses),
            requestAddress,
        }).catch((error) => error);

        expect(error).toBeInstanceOf(SmartNoteNetworkError);
        expect(contacted).toEqual(addresses.slice(0, 4).map((candidate) => candidate.address));
        expect(requestAddress.mock.calls).toHaveLength(4);
    });
});

describe("smart-note redirects", () => {
    const publicResolver = resolver([{ address: "93.184.216.34", family: 4 }]);

    test("follows all supported redirects to a freshly resolved public address", async () => {
        for (const status of [301, 302, 303, 307, 308]) {
            const lookup = mock(async (hostname: string) => [
                {
                    address: hostname === "cdn.test" ? "1.1.1.1" : "93.184.216.34",
                    family: 4 as const,
                },
            ]);
            const contacted: string[] = [];
            const result = await guardedSmartNoteHttpGet("https://registry.test/pkg", {
                signal,
                resolver: { lookup },
                requestAddress: async (validation, candidate) => {
                    contacted.push(`${validation.url.href} @ ${candidate.address}`);
                    return validation.hostname === "registry.test"
                        ? { status, body: "", location: "https://cdn.test/pkg.tgz" }
                        : { status: 200, body: "tarball" };
                },
            });
            expect(result).toEqual({ status: 200, body: "tarball" });
            expect(contacted).toEqual([
                "https://registry.test/pkg @ 93.184.216.34",
                "https://cdn.test/pkg.tgz @ 1.1.1.1",
            ]);
            expect(lookup.mock.calls.map(([host]) => host)).toEqual(["registry.test", "cdn.test"]);
        }
    });

    test("refuses redirect destinations with loopback, private, or link-local addresses", async () => {
        for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254"]) {
            for (const destination of [address, "internal.test"]) {
                const requestAddress = mock(async () => ({
                    status: 302,
                    body: "",
                    location: `https://${destination}/secret`,
                }));
                await expect(
                    guardedSmartNoteHttpGet("https://public.test/", {
                        signal,
                        resolver: {
                            lookup: async (host) => [
                                {
                                    address: host === "internal.test" ? address : "93.184.216.34",
                                    family: 4,
                                },
                            ],
                        },
                        requestAddress,
                    }),
                ).rejects.toThrow(/SMART_NOTE_SECURITY.*non-global|non-global\/internal/);
                expect(requestAddress).toHaveBeenCalledTimes(1);
            }
        }
    });

    test("keeps HTTPS and credential restrictions on redirects", async () => {
        for (const location of ["http://public.test/", "https://user:pass@public.test/"]) {
            const requestAddress = mock(async () => ({ status: 301, body: "", location }));
            await expect(
                guardedSmartNoteHttpGet("https://public.test/", {
                    signal,
                    resolver: publicResolver,
                    requestAddress,
                }),
            ).rejects.toThrow(/https|credentials/);
            expect(requestAddress).toHaveBeenCalledTimes(1);
        }
    });

    test("resolves relative Location against the current URL", async () => {
        const urls: string[] = [];
        const result = await guardedSmartNoteHttpGet("https://public.test/a/start", {
            signal,
            resolver: publicResolver,
            requestAddress: async (validation) => {
                urls.push(validation.url.href);
                return urls.length === 1
                    ? { status: 302, body: "", location: "../b/next?version=1" }
                    : urls.length === 2
                      ? { status: 307, body: "", location: "final" }
                      : { status: 200, body: "ok" };
            },
        });
        expect(result.body).toBe("ok");
        expect(urls).toEqual([
            "https://public.test/a/start",
            "https://public.test/b/next?version=1",
            "https://public.test/b/final",
        ]);
    });

    test("allows five redirect hops but rejects six with SMART_NOTE_NETWORK", async () => {
        for (const hops of [5, 6]) {
            let calls = 0;
            const result = await guardedSmartNoteHttpGet("https://public.test/", {
                signal,
                resolver: publicResolver,
                requestAddress: async () =>
                    ++calls <= hops
                        ? { status: 308, body: "", location: `/hop-${calls}` }
                        : { status: 200, body: "ok" },
            }).catch((error) => error);
            expect(calls).toBe(6);
            if (hops === 5) expect(result).toEqual({ status: 200, body: "ok" });
            else {
                expect(result).toBeInstanceOf(SmartNoteNetworkError);
                expect(result.message).toBe("SMART_NOTE_NETWORK: too many redirects");
            }
        }
    });

    test("names missing and invalid redirect Location errors", async () => {
        for (const location of [undefined, "", "   ", "https://["]) {
            await expect(
                guardedSmartNoteHttpGet("https://public.test/", {
                    signal,
                    resolver: publicResolver,
                    requestAddress: async () => ({ status: 302, body: "", location }),
                }),
            ).rejects.toThrow(/SMART_NOTE_NETWORK: (missing|invalid) redirect Location/);
        }
    });

    test("shares the raw body byte ceiling across redirect responses", async () => {
        const limits: number[] = [];
        const error = await guardedSmartNoteHttpGet("https://public.test/", {
            signal,
            resolver: publicResolver,
            bodyLimitBytes: 5,
            requestAddress: async (_validation, _candidate, options) => {
                limits.push(options.bodyLimitBytes);
                return limits.length === 1
                    ? { status: 302, body: "�", bytesRead: 2, location: "/final" }
                    : { status: 200, body: "four" };
            },
        }).catch((error) => error);
        expect(limits).toEqual([5, 3]);
        expect(error).toBeInstanceOf(SmartNoteNetworkError);
        expect(error.message).toMatch(/SMART_NOTE_NETWORK: response body too large/);
    });

    // These tests hang the slow step until the deadline aborts it, rather than
    // racing fixed sleeps against a tight budget: on a loaded CI runner the
    // sleeps alone overran a 40 ms budget before the redirect was requested.
    test("the wall-clock deadline also covers DNS on a redirect hop", async () => {
        let calls = 0;
        let lookups = 0;
        const error = await guardedSmartNoteHttpGet("https://public.test/", {
            signal,
            timeoutMs: 50,
            resolver: {
                lookup: async () => {
                    lookups++;
                    // The redirect target's DNS never answers.
                    if (lookups > 1) await new Promise(() => {});
                    return [{ address: "93.184.216.34", family: 4 }];
                },
            },
            requestAddress: async () => {
                calls++;
                return { status: 302, body: "", location: "/final" };
            },
        }).catch((error) => error);
        expect(calls).toBe(1);
        expect(lookups).toBe(2);
        expect(error).toBeInstanceOf(SmartNoteNetworkError);
        expect(error.message).toBe("SMART_NOTE_NETWORK: request timed out");
    });

    test("one wall-clock budget spans DNS and every redirect request", async () => {
        const budgets: number[] = [];
        let chainSignal: AbortSignal | undefined;
        const error = await guardedSmartNoteHttpGet("https://public.test/", {
            signal,
            timeoutMs: 500,
            resolver: {
                lookup: async () => {
                    await Bun.sleep(20);
                    return [{ address: "93.184.216.34", family: 4 }];
                },
            },
            requestAddress: async (_validation, _candidate, options) => {
                budgets.push(options.timeoutMs);
                chainSignal = options.signal;
                if (budgets.length === 1) return { status: 302, body: "", location: "/final" };
                // The redirected request hangs until the shared deadline aborts it.
                await new Promise((resolve) =>
                    options.signal.addEventListener("abort", resolve, { once: true }),
                );
                return { status: 200, body: "late" };
            },
        }).catch((error) => error);
        expect(budgets).toHaveLength(2);
        // Two 20 ms lookups have already been spent, so the redirect gets what is
        // left of the original budget, never a fresh one.
        expect(budgets[1]).toBeLessThanOrEqual(500 - 40 + 1);
        expect(budgets[1]).toBeLessThan(budgets[0] ?? 0);
        expect(error).toBeInstanceOf(SmartNoteNetworkError);
        expect(error.message).toBe("SMART_NOTE_NETWORK: request timed out");
        expect(chainSignal?.aborted).toBe(true);
    });
});

describe("createPinnedLookup", () => {
    // Regression: Node 20+ https.request defaults to autoSelectFamily
    // (Happy-Eyeballs), which calls the lookup hook with { all: true } and
    // expects the ARRAY callback form. The original hook only ever used the
    // 3-arg form, so Node's lookupAndConnectMultiple ran results.sort() on
    // undefined → "results.sort is not a function" broke every network check.
    test("returns the ARRAY form when Node asks for all candidates", () => {
        const hook = createPinnedLookup({ address: "93.184.216.34", family: 4 });
        let received: unknown;
        hook("example.test", { all: true }, (err, addresses) => {
            expect(err).toBeNull();
            received = addresses;
        });
        expect(received).toEqual([{ address: "93.184.216.34", family: 4 }]);
    });

    test("returns the legacy 3-arg form when all is not requested", () => {
        const hook = createPinnedLookup({ address: "1.1.1.1", family: 4 });
        let addr: unknown;
        let fam: unknown;
        hook("example.test", {}, (err, address, family) => {
            expect(err).toBeNull();
            addr = address;
            fam = family;
        });
        expect(addr).toBe("1.1.1.1");
        expect(fam).toBe(4);
    });

    test("pins to the validated IP without re-querying DNS", () => {
        const hook = createPinnedLookup({ address: "203.0.113.7", family: 4 });
        // Even though the hostname differs, the hook must return the pinned IP.
        let received: unknown;
        hook("attacker-rebind.test", { all: true }, (_err, addresses) => {
            received = addresses;
        });
        expect(received).toEqual([{ address: "203.0.113.7", family: 4 }]);
    });
});

describe("guarded HTTPS request agent", () => {
    test("passes redirect Location and raw bytes from the pinned transport", async () => {
        const response = Object.assign(new EventEmitter(), {
            statusCode: 302,
            headers: { location: "/cdn" },
            destroy: () => {},
        });
        const request = Object.assign(new EventEmitter(), {
            destroy: () => {},
            end: () =>
                queueMicrotask(() => {
                    response.emit("data", Buffer.from([0xff]));
                    response.emit("end");
                }),
        });
        const spy = spyOn(https, "request").mockImplementation(((
            options: https.RequestOptions,
            callback: (response: typeof response) => void,
        ) => {
            expect(options.method).toBe("GET");
            let pinned: unknown;
            options.lookup!("public.test", {}, (_error, address) => {
                pinned = address;
            });
            expect(pinned).toBe("1.1.1.1");
            callback(response);
            return request;
        }) as typeof https.request);
        try {
            expect(
                await requestValidatedAddress(
                    {
                        url: new URL("https://public.test/"),
                        hostname: "public.test",
                        addresses: [],
                    },
                    { address: "1.1.1.1", family: 4, classification: "global" },
                    {
                        signal,
                        timeoutMs: 100,
                        bodyLimitBytes: 10,
                    },
                ),
            ).toEqual({
                status: 302,
                body: "�",
                headers: { location: "/cdn" },
                location: "/cdn",
                bytesRead: 1,
            });
        } finally {
            spy.mockRestore();
        }
    });
    test("reports the URL and observed bytes at the hard body ceiling", async () => {
        const response = new EventEmitter() as EventEmitter & {
            statusCode: number;
            destroy: () => void;
        };
        response.statusCode = 200;
        response.destroy = () => {};
        const request = new EventEmitter() as EventEmitter & {
            end: () => void;
            destroy: () => void;
        };
        request.destroy = () => {};
        request.end = () => {
            queueMicrotask(() => response.emit("data", Buffer.alloc(65_537)));
        };
        const spy = spyOn(https, "request").mockImplementation(((
            _options: unknown,
            callback: (response: typeof response) => void,
        ) => {
            callback(response);
            return request;
        }) as typeof https.request);
        try {
            const error = await requestValidatedAddress(
                {
                    url: new URL("https://example.test/CHANGELOG.md"),
                    hostname: "example.test",
                    addresses: [],
                },
                { address: "93.184.216.34", family: 4, classification: "global" },
                { signal, timeoutMs: 100, bodyLimitBytes: 65_536 },
            ).catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(SmartNoteNetworkError);
            expect(error.message).toMatch(
                /example\.test\/CHANGELOG\.md \(received at least 65537 bytes; limit 65536\)/,
            );
            expect(error.persistent).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });
    test("does not use a pre-seeded keep-alive global agent", async () => {
        // Intercept at addRequest: every request routed through an Agent must
        // enter addRequest, and it exists on every supported runtime — bun's
        // stable node:https shim leaves globalAgent.createConnection undefined,
        // so spying on createConnection only works on canary builds.
        const originalAddRequest = https.globalAgent.addRequest;
        const globalAddRequest = mock(originalAddRequest.bind(https.globalAgent));
        https.globalAgent.addRequest = globalAddRequest;
        try {
            const dedicated = createSmartNoteRequestAgent();
            expect(dedicated).not.toBe(https.globalAgent);
            expect(dedicated.keepAlive).toBe(false);
            expect(dedicated.maxSockets).toBe(1);
            dedicated.destroy();

            await expect(
                requestValidatedAddress(
                    {
                        url: new URL("https://example.test:1/"),
                        hostname: "example.test",
                        addresses: [],
                    },
                    { address: "127.0.0.1", family: 4, classification: "global" },
                    { signal, timeoutMs: 100, bodyLimitBytes: 1024 },
                ),
            ).rejects.toBeInstanceOf(SmartNoteNetworkError);
            expect(globalAddRequest).not.toHaveBeenCalled();
        } finally {
            https.globalAgent.addRequest = originalAddRequest;
        }
    });
});

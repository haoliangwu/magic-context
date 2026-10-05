import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingHttpHeaders } from "node:http";
import * as https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { domainToASCII } from "node:url";

import {
    isTerminalSmartNoteNetworkError,
    SmartNoteNetworkError,
    SmartNoteSecurityError,
} from "./types";

export interface ResolvedSmartNoteAddress {
    address: string;
    family: 4 | 6;
    classification: "global";
}

export interface SmartNoteUrlValidation {
    url: URL;
    hostname: string;
    addresses: ResolvedSmartNoteAddress[];
}

export interface SmartNoteResolver {
    lookup(
        hostname: string,
        signal: AbortSignal,
    ): Promise<Array<{ address: string; family: 4 | 6 }>>;
}

interface SmartNoteAddressResponse {
    status: number;
    body: string;
    location?: string;
    bytesRead?: number;
}

type SmartNoteAddressRequest = (
    validation: SmartNoteUrlValidation,
    candidate: ResolvedSmartNoteAddress,
    options: { signal: AbortSignal; timeoutMs: number; bodyLimitBytes: number },
) => Promise<SmartNoteAddressResponse>;

export interface GuardedSmartNoteHttpGetOptions {
    signal: AbortSignal;
    resolver?: SmartNoteResolver;
    timeoutMs?: number;
    bodyLimitBytes?: number;
    requestAddress?: SmartNoteAddressRequest;
}

const DNS_TIMEOUT_MS = 3_000;
const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
// Bound streamed network input independently of compiler/model output limits.
const DEFAULT_HTTP_BODY_LIMIT_BYTES = 1024 * 1024;
const MAX_HTTP_ADDRESS_CANDIDATES = 4;
const MAX_HTTP_REDIRECTS = 5;
const HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const defaultResolver: SmartNoteResolver = {
    async lookup(hostname, signal) {
        return await withAbortAndTimeout(
            dnsLookup(hostname, { all: true, verbatim: true }) as Promise<
                Array<{ address: string; family: number }>
            >,
            signal,
            DNS_TIMEOUT_MS,
            "DNS lookup timed out",
        ).then((rows) =>
            rows
                .filter(
                    (row): row is { address: string; family: 4 | 6 } =>
                        row.family === 4 || row.family === 6,
                )
                .map((row) => ({ address: row.address, family: row.family })),
        );
    },
};

/** Refuse endpoints that cannot work under the smart-note no-credentials policy. */
export function assertSmartNotePublicEndpoint(url: URL): void {
    if (url.hostname === "api.github.com" && /^\/search\/code\/?$/.test(url.pathname)) {
        throw new SmartNoteNetworkError(
            `SMART_NOTE_NETWORK: GitHub code search requires authentication at ${url.href}; use a public repository contents or commits check instead`,
            { terminal: true, persistent: true, uncheckable: true },
        );
    }
}

export async function validateSmartNoteHttpUrl(
    input: string,
    options: { signal?: AbortSignal; resolver?: SmartNoteResolver } = {},
): Promise<SmartNoteUrlValidation> {
    const signal = options.signal ?? new AbortController().signal;
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        throw new SmartNoteSecurityError("invalid URL");
    }
    if (url.protocol !== "https:") {
        throw new SmartNoteSecurityError("smart-note httpGet only permits https URLs");
    }
    if (url.username || url.password) {
        throw new SmartNoteSecurityError("credentials in URLs are not allowed");
    }
    assertSmartNotePublicEndpoint(url);
    if (url.hash) {
        // Fragment never reaches the server. Drop it so Host/path auditing is
        // canonical and deterministic.
        url.hash = "";
    }

    const hostname = stripIpv6Brackets(url.hostname);
    if (!hostname) {
        throw new SmartNoteSecurityError("URL host is required");
    }
    const addresses = await resolveHostToValidatedGlobalAddresses(
        hostname,
        signal,
        options.resolver,
    );
    return { url, hostname, addresses };
}

export async function guardedSmartNoteHttpGet(
    input: string,
    options: GuardedSmartNoteHttpGetOptions,
): Promise<{ status: number; body: string }> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_HTTP_BODY_LIMIT_BYTES;
    const requestAddress = options.requestAddress ?? requestValidatedAddress;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) controller.abort();
    const deadline = performance.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;

    let remainingBytes = bodyLimitBytes;
    const follow = async (target: string): Promise<{ status: number; body: string }> => {
        let currentUrl = target;
        for (let redirects = 0; ; redirects++) {
            throwIfAborted(controller.signal);
            const validation = await validateSmartNoteHttpUrl(currentUrl, {
                signal: controller.signal,
                resolver: options.resolver,
            });
            // Each redirect is a new destination, with fresh DNS validation and
            // pinning. Address retries and redirects share the original budgets.
            const candidates = validation.addresses.slice(0, MAX_HTTP_ADDRESS_CANDIDATES);
            let lastError: unknown;
            let response: SmartNoteAddressResponse | undefined;
            for (const candidate of candidates) {
                try {
                    throwIfAborted(controller.signal);
                    response = await requestAddress(validation, candidate, {
                        signal: controller.signal,
                        timeoutMs: Math.max(1, deadline - performance.now()),
                        bodyLimitBytes: remainingBytes,
                    });
                    break;
                } catch (error) {
                    lastError = error;
                    if (
                        error instanceof SmartNoteSecurityError ||
                        controller.signal.aborted ||
                        isTerminalSmartNoteNetworkError(error)
                    ) {
                        throw error;
                    }
                }
            }
            if (!response) throw toNetworkError(lastError, "all validated addresses failed");
            remainingBytes -= response.bytesRead ?? Buffer.byteLength(response.body);
            if (remainingBytes < 0) {
                throw new SmartNoteNetworkError(
                    `SMART_NOTE_NETWORK: response body too large at ${validation.url.href} (received at least ${bodyLimitBytes - remainingBytes} bytes; limit ${bodyLimitBytes})`,
                    {
                        terminal: true,
                        persistent: true,
                    },
                );
            }
            if (!HTTP_REDIRECT_STATUSES.has(response.status)) {
                return { status: response.status, body: response.body };
            }
            if (redirects >= MAX_HTTP_REDIRECTS) {
                throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: too many redirects", {
                    terminal: true,
                });
            }
            if (!response.location?.trim()) {
                throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: missing redirect Location", {
                    terminal: true,
                });
            }
            try {
                currentUrl = new URL(response.location, validation.url).href;
            } catch {
                throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: invalid redirect Location", {
                    terminal: true,
                });
            }
        }
    };

    try {
        // A wall-clock deadline also covers DNS and trickling response bodies;
        // socket inactivity timeouts alone cannot bound the whole redirect chain.
        return await Promise.race([
            (async () => {
                const response = await follow(input);
                assertReadableHttpStatus(response.status, input);
                if (response.status === 404 || response.status === 410) {
                    const parent = readableParentUrl(new URL(input));
                    if (parent) {
                        // Verify the GitHub repository or npm package is readable before
                        // treating its watched resource as missing. Reuse the resource
                        // request's SSRF policy, byte budget and wall-clock deadline.
                        const container = await follow(parent);
                        assertReadableHttpStatus(container.status, parent);
                        if (container.status < 200 || container.status >= 300) {
                            throw new SmartNoteNetworkError(
                                `SMART_NOTE_NETWORK: source container is not publicly readable at ${parent} (HTTP ${container.status}); cannot check ${input}`,
                                { terminal: true, persistent: true, uncheckable: true },
                            );
                        }
                    }
                }
                return response;
            })(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    reject(
                        new SmartNoteNetworkError("SMART_NOTE_NETWORK: request timed out", {
                            terminal: true,
                        }),
                    );
                    controller.abort();
                }, timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
        controller.abort();
    }
}

function rateLimitRetryAt(headers: IncomingHttpHeaders): number {
    const now = Date.now();
    const retryAfter = String(headers["retry-after"] ?? "");
    const delaySeconds = retryAfter.trim() ? Number(retryAfter) : NaN;
    const retryAt = Number.isFinite(delaySeconds)
        ? now + Math.max(0, delaySeconds) * 1000
        : Date.parse(retryAfter);
    const resetSeconds = Number(headers["x-ratelimit-reset"]);
    const resetAt = Number.isFinite(resetSeconds) ? resetSeconds * 1000 : NaN;
    // Missing/malformed Retry-After or X-RateLimit-Reset headers use the five-minute
    // minimum retry delay; rate limiting does not require reauthoring the check.
    return Math.max(
        now + 5 * 60 * 1000,
        Number.isFinite(retryAt) ? retryAt : 0,
        Number.isFinite(resetAt) ? resetAt : 0,
    );
}

function assertReadableHttpStatus(status: number, url: string): void {
    if (status === 401 || status === 403 || status === 451) {
        throw new SmartNoteNetworkError(
            `SMART_NOTE_NETWORK: source is not publicly readable at ${url} (HTTP ${status})`,
            { terminal: true, persistent: true, uncheckable: true },
        );
    }
    if (status === 408 || status === 429 || status >= 500) {
        throw new SmartNoteNetworkError(`SMART_NOTE_NETWORK: transient HTTP ${status} at ${url}`);
    }
}

function readableParentUrl(url: URL): string | null {
    const segments = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "api.github.com" && segments[0] === "repos" && segments.length >= 3) {
        return `https://api.github.com/repos/${segments[1]}/${segments[2]}`;
    }
    if (url.hostname === "raw.githubusercontent.com" && segments.length >= 2) {
        return `https://api.github.com/repos/${segments[0]}/${segments[1]}`;
    }
    if (url.hostname === "github.com" && segments.length >= 2) {
        return `https://api.github.com/repos/${segments[0]}/${segments[1]}`;
    }
    if (url.hostname === "registry.npmjs.org" && segments.length > 0) {
        // Scoped package names can be encoded as one segment or written with a slash.
        const name =
            segments[0].startsWith("@") && !/%2f/i.test(segments[0])
                ? `${segments[0]}/${segments[1] ?? ""}`
                : segments[0];
        return `https://registry.npmjs.org/${name}`;
    }
    // Generic document origins have no reliable repository/package metadata API.
    return null;
}

async function resolveHostToValidatedGlobalAddresses(
    rawHostname: string,
    signal: AbortSignal,
    resolver = defaultResolver,
): Promise<ResolvedSmartNoteAddress[]> {
    throwIfAborted(signal);
    const literal = parseIpLiteral(rawHostname);
    const candidates = literal
        ? [{ address: literal.address, family: literal.family }]
        : await resolver.lookup(canonicalDnsName(rawHostname), signal).catch((error) => {
              throw toNetworkError(error, "DNS resolution failed");
          });

    if (candidates.length === 0) {
        throw new SmartNoteSecurityError("DNS resolution returned no addresses");
    }

    // Requests are pinned to one validated IPv4 address, so discard IPv6 DNS
    // answers rather than rejecting an otherwise reachable dual-stack host.
    // IPv6-only destinations remain blocked because no request candidate survives.
    const ipv4Candidates = candidates.filter(
        (candidate) => candidate.family !== 6 && !candidate.address.includes(":"),
    );
    if (ipv4Candidates.length === 0) {
        throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: IPv6 destinations are not permitted");
    }

    const classified = ipv4Candidates.map((candidate) => {
        const parsed = parseIpLiteral(candidate.address);
        if (parsed?.family !== 4) {
            throw new SmartNoteSecurityError(
                `DNS returned an unparsable IPv4 address: ${candidate.address}`,
            );
        }
        return {
            address: parsed.address,
            family: parsed.family,
            global: isGlobalAddress(parsed),
        };
    });

    if (classified.some((candidate) => !candidate.global)) {
        throw new SmartNoteSecurityError("URL resolves to a non-global/internal address");
    }

    return classified.map((candidate) => ({
        address: candidate.address,
        family: candidate.family,
        classification: "global" as const,
    }));
}

/**
 * A `net.LookupFunction`-shaped hook that always resolves to the single
 * pre-validated, pinned IP — never re-querying DNS (anti-rebinding). Node may
 * invoke it with `{ all: true }` (Happy-Eyeballs / autoSelectFamily), which
 * expects the ARRAY callback form, or with the legacy single-address form. We
 * honor both: returning the wrong shape made Node's lookupAndConnectMultiple
 * call `results.sort(...)` on `undefined`, which surfaced as
 * "SMART_NOTE_NETWORK: results.sort is not a function" and broke every
 * network-touching smart-note check.
 *
 * Node's `LookupFunction` type only models the legacy 3-arg callback, so the
 * dual-shape dispatch is expressed against a locally-widened callback type and
 * the result is asserted back to `LookupFunction` for `https.request`.
 */
export function createPinnedLookup(candidate: { address: string; family: 4 | 6 }): LookupFunction {
    const hook = (
        _hostname: string,
        lookupOptions: { all?: boolean } | undefined,
        cb: (
            err: Error | null,
            addressOrList: string | Array<{ address: string; family: number }>,
            family?: number,
        ) => void,
    ): void => {
        if (lookupOptions?.all) {
            cb(null, [{ address: candidate.address, family: candidate.family }]);
            return;
        }
        cb(null, candidate.address, candidate.family);
    };
    return hook as unknown as LookupFunction;
}

export function requestValidatedAddress(
    validation: SmartNoteUrlValidation,
    candidate: ResolvedSmartNoteAddress,
    options: { signal: AbortSignal; timeoutMs: number; bodyLimitBytes: number },
): Promise<SmartNoteAddressResponse> {
    // A request-local agent prevents global keep-alive or proxying agents from
    // reusing a socket that was not opened through the pinned lookup below.
    const agent = createSmartNoteRequestAgent();
    return new Promise<SmartNoteAddressResponse>((resolve, reject) => {
        const url = validation.url;
        const hostHeader = url.host;
        const request = https.request(
            {
                protocol: "https:",
                hostname: validation.hostname,
                port: url.port ? Number(url.port) : 443,
                path: `${url.pathname}${url.search}`,
                method: "GET",
                servername: isIP(validation.hostname) ? undefined : validation.hostname,
                headers: {
                    Host: hostHeader,
                    "User-Agent": "magic-context-smart-note-check/1",
                    Accept: "text/plain, application/json;q=0.9, */*;q=0.1",
                },
                // Anti-rebinding: DNS was resolved and classified above; the
                // connector is pinned to that exact pre-validated IP while TLS
                // still verifies the original hostname via
                // hostname/servername/Host. The hook honors BOTH callback shapes
                // — Node 20+ defaults to autoSelectFamily (Happy-Eyeballs), which
                // drives the lookup with { all: true } and expects the ARRAY
                // form; returning the wrong shape was the bug that broke every
                // network-touching check.
                lookup: createPinnedLookup(candidate),
                agent,
                timeout: options.timeoutMs,
            },
            (response) => {
                const chunks: Buffer[] = [];
                let bytes = 0;
                response.on("data", (chunk: Buffer | string) => {
                    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    bytes += buf.byteLength;
                    if (bytes > options.bodyLimitBytes) {
                        // Reject FIRST, then destroy WITHOUT an error argument.
                        // destroy(err) hands the error to the stream machinery,
                        // which under OpenCode's embedded Bun has been observed
                        // re-surfacing it through the readable's flow() as an
                        // UNCAUGHT stderr dump even with 'error' listeners on
                        // both the request and the response. An errorless
                        // destroy gives the internals nothing to re-emit; the
                        // promise is already settled with the typed error.
                        reject(
                            new SmartNoteNetworkError(
                                `SMART_NOTE_NETWORK: response body too large at ${url.href} (received at least ${bytes} bytes; limit ${options.bodyLimitBytes})`,
                                { terminal: true, persistent: true },
                            ),
                        );
                        response.destroy();
                        request.destroy();
                        return;
                    }
                    chunks.push(buf);
                });
                // Genuine transport errors mid-body (connection reset, TLS
                // failure) surface here. Local aborts (body limit, timeout,
                // signal) reject the promise directly and destroy errorless,
                // so this listener only sees real network failures — but it
                // must exist: an unlistened stream 'error' dumps to stderr.
                response.on("error", (error) => {
                    reject(toNetworkError(error, "response failed"));
                });
                response.on("end", () => {
                    const status = response.statusCode ?? 0;
                    const rateLimited =
                        (status === 401 || status === 403 || status === 429) &&
                        (status === 429 ||
                            response.headers["x-ratelimit-remaining"] === "0" ||
                            response.headers["retry-after"] !== undefined);
                    if (rateLimited) {
                        reject(
                            new SmartNoteNetworkError(
                                `SMART_NOTE_NETWORK: rate-limited HTTP ${status} at ${url.href}`,
                                { terminal: true, retryAt: rateLimitRetryAt(response.headers) },
                            ),
                        );
                        return;
                    }
                    if (status >= 500) {
                        reject(
                            new SmartNoteNetworkError(
                                `SMART_NOTE_NETWORK: transient HTTP ${status}`,
                            ),
                        );
                        return;
                    }
                    resolve({
                        status,
                        body: Buffer.concat(chunks).toString("utf8"),
                        location: response.headers.location,
                        bytesRead: bytes,
                    });
                });
            },
        );

        // Same reject-then-errorless-destroy discipline as the body-limit
        // branch: passing an Error to destroy() lets stream internals re-throw
        // it where no listener reaches.
        const onAbort = () => {
            reject(new SmartNoteNetworkError("SMART_NOTE_NETWORK: aborted"));
            request.destroy();
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        request.on("timeout", () => {
            reject(
                new SmartNoteNetworkError("SMART_NOTE_NETWORK: request timed out", {
                    terminal: true,
                }),
            );
            request.destroy();
        });
        request.on("error", (error) => {
            options.signal.removeEventListener("abort", onAbort);
            reject(toNetworkError(error, "request failed"));
        });
        request.on("close", () => options.signal.removeEventListener("abort", onAbort));
        request.end();
    }).finally(() => agent.destroy());
}

export function createSmartNoteRequestAgent(): https.Agent {
    return new https.Agent({ keepAlive: false, maxSockets: 1 });
}

function canonicalDnsName(hostname: string): string {
    const ascii = domainToASCII(hostname);
    if (!ascii) throw new SmartNoteSecurityError("invalid DNS hostname");
    return ascii;
}

function parseIpLiteral(
    hostname: string,
):
    | { family: 4; address: string; value: number }
    | { family: 6; address: string; value: bigint; mappedIpv4?: number }
    | null {
    const host = stripIpv6Brackets(hostname).toLowerCase();
    if (isIP(host) === 4) {
        return { family: 4, address: host, value: ipv4ToNumber(host) };
    }
    if (isIP(host) === 6) {
        const parsed = parseIpv6ToParts(host);
        if (!parsed) return null;
        const value = ipv6PartsToBigInt(parsed.parts);
        const mappedIpv4 = ipv4MappedValue(parsed.parts);
        return { family: 6, address: host, value, mappedIpv4 };
    }
    return null;
}

function stripIpv6Brackets(hostname: string): string {
    return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function ipv4ToNumber(address: string): number {
    const parts = address.split(".").map((part) => Number(part));
    if (
        parts.length !== 4 ||
        parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
        throw new SmartNoteSecurityError(`invalid IPv4 address: ${address}`);
    }
    return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function parseIpv6ToParts(address: string): { parts: number[] } | null {
    if (address.includes("%")) return null;
    let text = address;
    if (text.includes(".")) {
        const idx = text.lastIndexOf(":");
        if (idx < 0) return null;
        const ipv4 = text.slice(idx + 1);
        const v4 = ipv4ToNumber(ipv4);
        text = `${text.slice(0, idx)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
    }
    const halves = text.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const parse = (part: string) => {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
        const value = Number.parseInt(part, 16);
        return Number.isInteger(value) && value >= 0 && value <= 0xffff ? value : null;
    };
    const parsedLeft = left.map(parse);
    const parsedRight = right.map(parse);
    if (parsedLeft.some((p) => p == null) || parsedRight.some((p) => p == null)) return null;
    const missing = 8 - parsedLeft.length - parsedRight.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
    return {
        parts: [
            ...(parsedLeft as number[]),
            ...Array.from({ length: missing }, () => 0),
            ...(parsedRight as number[]),
        ],
    };
}

function ipv6PartsToBigInt(parts: number[]): bigint {
    return parts.reduce((acc, part) => (acc << 16n) | BigInt(part), 0n);
}

function ipv4MappedValue(parts: number[]): number | undefined {
    if (parts.length !== 8) return undefined;
    if (parts.slice(0, 5).some((part) => part !== 0) || parts[5] !== 0xffff) return undefined;
    return (((parts[6] << 16) >>> 0) + parts[7]) >>> 0;
}

function isGlobalAddress(
    parsed: { family: 4; value: number } | { family: 6; value: bigint; mappedIpv4?: number },
): boolean {
    if (parsed.family === 4) return isGlobalIpv4(parsed.value);
    if (parsed.mappedIpv4 !== undefined) return isGlobalIpv4(parsed.mappedIpv4);
    return isGlobalIpv6(parsed.value);
}

function isGlobalIpv4(value: number): boolean {
    const inRange = (base: number, bits: number) => (value & mask(bits)) === (base & mask(bits));
    return !(
        inRange(0x00000000, 8) ||
        inRange(0x0a000000, 8) ||
        inRange(0x64400000, 10) ||
        inRange(0x7f000000, 8) ||
        inRange(0xa9fe0000, 16) ||
        inRange(0xac100000, 12) ||
        inRange(0xc0000000, 24) ||
        inRange(0xc0000200, 24) ||
        inRange(0xc0a80000, 16) ||
        inRange(0xc0586300, 24) ||
        inRange(0xc6120000, 15) ||
        inRange(0xc6336400, 24) ||
        inRange(0xcb007100, 24) ||
        inRange(0xe0000000, 4) ||
        inRange(0xf0000000, 4) ||
        value === 0xffffffff
    );
}

function mask(bits: number): number {
    return bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
}

function isGlobalIpv6(value: bigint): boolean {
    const inRange = (base: bigint, bits: number) =>
        (value & maskBig(bits)) === (base & maskBig(bits));
    return (
        inRange(0x20000000000000000000000000000000n, 3) &&
        !inRange(0x20010000000000000000000000000000n, 23) &&
        !inRange(0x20010db8000000000000000000000000n, 32) &&
        !inRange(0x20020000000000000000000000000000n, 16) &&
        !inRange(0x64ff9b00000000000000000000000000n, 96) &&
        !inRange(0x64ff9b00010000000000000000000000n, 48) &&
        !inRange(0x10000000000000000000000000000000n, 64) &&
        !inRange(0xfc000000000000000000000000000000n, 7) &&
        !inRange(0xfe800000000000000000000000000000n, 10) &&
        !inRange(0xff000000000000000000000000000000n, 8) &&
        value !== 0n &&
        value !== 1n
    );
}

function maskBig(bits: number): bigint {
    return bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
}

async function withAbortAndTimeout<T>(
    promise: Promise<T>,
    signal: AbortSignal,
    timeoutMs: number,
    timeoutMessage: string,
): Promise<T> {
    throwIfAborted(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(
                    () => reject(new SmartNoteNetworkError(timeoutMessage)),
                    timeoutMs,
                );
                signal.addEventListener(
                    "abort",
                    () => reject(new SmartNoteNetworkError("SMART_NOTE_NETWORK: aborted")),
                    { once: true },
                );
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new SmartNoteNetworkError("SMART_NOTE_NETWORK: aborted");
}

function toNetworkError(error: unknown, fallback: string): SmartNoteNetworkError {
    if (error instanceof SmartNoteNetworkError) return error;
    const message = error instanceof Error ? error.message : String(error || fallback);
    return new SmartNoteNetworkError(`SMART_NOTE_NETWORK: ${message || fallback}`);
}

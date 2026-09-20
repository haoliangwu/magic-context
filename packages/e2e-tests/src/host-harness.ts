import type { Database } from "bun:sqlite";
import type { CapturedRequest } from "./mock-provider/server";
import type { PiRunResult } from "./pi-runner/spawn";
import type { PiMessage, PiSessionStats, PiState } from "./pi-runner/rpc-client";

export type HostKind = "opencode" | "opencode2" | "pi" | "omp";

/** Host features that are not uniformly available to portable scenarios. */
export interface HostCapabilities {
    readonly childSessions: boolean;
    readonly nativeCompact: boolean;
    readonly sessionRemove: boolean;
    readonly steerDelivery: boolean;
}

export interface HostPromptOptions {
    timeoutMs?: number;
}

/** The host-neutral surface used by behavior scenarios. */
export interface HostHarness {
    readonly host: HostKind;
    /** Value persisted in Magic Context's harness column for this host. */
    readonly harnessId: HostKind;
    readonly capabilities: HostCapabilities;

    restart(): Promise<void>;
    createSession(): Promise<string>;
    sendPrompt(sessionId: string, text: string, options?: HostPromptOptions): Promise<unknown>;
    ballast(tokens: number): string;
    assertMagicContextProcessed(sessionId: string): void;
    waitForMockQuiescence(options?: { quietMs?: number; label?: string }): Promise<void>;
    waitFor<T>(
        predicate: () => T | null | undefined | false,
        options?: { timeoutMs?: number; intervalMs?: number; label?: string },
    ): Promise<T>;
    contextDb(): Database;
    hasContextDb(): boolean;
    countCompartments(sessionId: string): number;
    countTags(sessionId: string): number;
    countTagsByStatus(sessionId: string, status: string): number;
    requests(): CapturedRequest[];
    assertHistorianRequestsUseMock(): void;
    dispose(): Promise<void>;
}

export interface HostHarnessFactory<THarness extends HostHarness = HostHarness, TOptions = unknown> {
    create(options?: TOptions): Promise<THarness>;
}

/** Pi RPC operations intentionally stay outside the portable host contract. */
export interface PiHostHarness extends HostHarness {
    readonly host: "pi" | "omp";
    readonly harnessId: "pi" | "omp";

    sendPrompt(text: string, options?: { timeoutMs?: number; continueSession?: boolean; images?: unknown[] }): Promise<PiRunResult>;
    sendPrompt(
        sessionId: string,
        text: string,
        options?: { timeoutMs?: number; continueSession?: boolean; images?: unknown[] },
    ): Promise<PiRunResult>;
    getState(): Promise<PiState>;
    getMessages(): Promise<PiMessage[]>;
    getSessionStats(): Promise<PiSessionStats>;
    compactNow(): Promise<void>;
    compactNowExpectCancelled(): Promise<void>;
    invokeExtensionCommand(command: string): Promise<void>;
    newSession(): Promise<void>;
    reloadExtensions(): Promise<void>;
}

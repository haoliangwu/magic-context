/**
 * HarnessRuntime — Host-neutral runtime surface (merged from adapter-api/runtime.ts).
 */
export interface HarnessRuntime {
  readonly model: {
    readonly provider: string;
    readonly model: string;
    readonly contextWindow?: number;
  };
  readonly hasUI: boolean;
  readonly signal?: AbortSignal;
  notify(message: string, level?: "info" | "warn" | "error"): void;
  setStatus(key: string, text: string): void;
  sendMessage(text: string): void;
  inject(content: unknown): void;
}

import type {
    ClassifyModuleCallArgs,
    ClassifyModuleClient,
} from "../features/magic-context/dreamer/classify";
import type { RustModeModuleClient } from "../hooks/magic-context/rust-mode-transform";

export type DreamTimerModuleClient = ClassifyModuleClient;

/**
 * Adapt the Rust transport without extracting methods from its class instance.
 * Subc transports read instance routing state, so every forwarded call must retain `this`.
 */
export function createDreamTimerModuleClient(
    moduleClient: RustModeModuleClient | undefined,
): DreamTimerModuleClient | undefined {
    if (!moduleClient) return undefined;
    return {
        call: (args: ClassifyModuleCallArgs) =>
            moduleClient.call(args as unknown as Parameters<RustModeModuleClient["call"]>[0]),
    };
}

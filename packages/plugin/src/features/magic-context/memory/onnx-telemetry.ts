import { isMainThread } from "node:worker_threads";

type NativeEnvironmentFfi = {
    FFIType: { cstring: number; i32: number };
    dlopen(
        path: string,
        symbols: Record<string, { args: number[]; returns: number }>,
    ): {
        symbols: {
            setenv(name: Buffer, value: Buffer, overwrite: number): number;
            getenv(name: Buffer): { toString(): string } | null;
        };
        close(): void;
    };
};
const FFI_SPECIFIER = "bun:ffi";

/** Set the native process environment before any model worker or ONNX session starts. */
export async function prepareNativeOnnxTelemetry(): Promise<boolean> {
    if (process.platform === "win32") return true;
    if (!process.versions.bun) {
        if (!isMainThread) return false;
        process.env.ORT_DISABLE_TELEMETRY = "1";
        return true;
    }
    // A computed optional import keeps the Node-only package independent of Bun's ambient types.
    let ffi: NativeEnvironmentFfi;
    try {
        ffi = await import(FFI_SPECIFIER);
    } catch {
        return false;
    }
    const { dlopen, FFIType } = ffi;
    const paths =
        process.platform === "darwin"
            ? ["/usr/lib/libSystem.B.dylib"]
            : ["libc.so.6", `/lib/ld-musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`];
    for (const path of paths) {
        try {
            const library = dlopen(path, {
                setenv: {
                    args: [FFIType.cstring, FFIType.cstring, FFIType.i32],
                    returns: FFIType.i32,
                },
                getenv: { args: [FFIType.cstring], returns: FFIType.cstring },
            });
            try {
                const name = Buffer.from("ORT_DISABLE_TELEMETRY\0");
                const value = Buffer.from("1\0");
                const disabled =
                    library.symbols.setenv(name, value, 1) === 0 &&
                    String(library.symbols.getenv(name)) === "1";
                if (disabled) process.env.ORT_DISABLE_TELEMETRY = "1";
                return disabled;
            } finally {
                library.close();
            }
        } catch {
            // Try the next libc library; false makes the caller spawn with the opt-out in its OS environment.
        }
    }
    return false;
}

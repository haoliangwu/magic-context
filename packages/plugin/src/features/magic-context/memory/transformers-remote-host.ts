const DEFAULT_TRANSFORMERS_REMOTE_HOST = "https://huggingface.co/";

type TransformersRemoteEnvironment = {
    remoteHost?: string;
};

function readHuggingFaceEndpoint(): string | undefined {
    return (
        globalThis as typeof globalThis & {
            process?: { env?: Record<string, string | undefined> };
        }
    ).process?.env?.HF_ENDPOINT;
}

export function configureTransformersRemoteHost(
    env: TransformersRemoteEnvironment,
    endpoint = readHuggingFaceEndpoint(),
): void {
    const normalized = endpoint?.trim().replace(/\/+$/, "");
    env.remoteHost = normalized ? `${normalized}/` : DEFAULT_TRANSFORMERS_REMOTE_HOST;
}

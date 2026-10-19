const MAX_HISTORIAN_FAILURE_REASON_LENGTH = 512;

const KNOWN_PROVIDER_ERROR_TYPES = [
    "authentication_error",
    "context_length_exceeded",
    "insufficient_quota",
    "invalid_api_key",
    "invalid_request_error",
    "model_not_found",
    "overloaded_error",
    "permission_error",
    "rate_limit_error",
    "server_error",
    "content_filter",
] as const;

/** Bound failure-reason length while preserving its diagnostic text. */
export function capHistorianFailureReason(
    reason: string | null | undefined,
    fallback = "provider_error",
): string {
    const value = typeof reason === "string" && reason.trim() ? reason : fallback;
    return value.slice(0, MAX_HISTORIAN_FAILURE_REASON_LENGTH);
}

/** Summarize external errors using only structured status, type, code, or class. */
export function externalHistorianFailureReason(
    error: unknown,
    prefix:
        | "provider_error"
        | "exception"
        | "timeout"
        | "aborted"
        | "empty_output"
        | "parse_failed" = "provider_error",
): string {
    const record =
        typeof error === "object" && error !== null
            ? (error as Record<string, unknown>)
            : undefined;
    const message =
        typeof error === "string"
            ? error
            : typeof record?.message === "string"
              ? record.message
              : String(error ?? "");
    const normalized = message.toLowerCase();
    const dataRecord =
        typeof record?.data === "object" && record.data !== null
            ? (record.data as Record<string, unknown>)
            : undefined;
    const statusValue =
        record?.statusCode ??
        record?.status ??
        record?.status_code ??
        dataRecord?.statusCode ??
        dataRecord?.status ??
        dataRecord?.status_code;
    const structuredStatus =
        typeof statusValue === "number" || typeof statusValue === "string"
            ? /^[1-5]\d{2}$/.exec(String(statusValue))?.[0]
            : undefined;
    const status =
        structuredStatus ??
        /(?:\bhttp(?:\s+status)?|\bstatus(?:\s+code)?|\bapi\s+error|\berror)\s*[(:= ]+([1-5]\d{2})\b/i.exec(
            message,
        )?.[1];
    const structuredTypes = [record?.type, dataRecord?.type].filter(
        (value): value is string =>
            typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(value),
    );
    const structuredType = [record?.type, record?.code, dataRecord?.type, dataRecord?.code]
        .filter((value): value is string => typeof value === "string")
        .join(" ")
        .toLowerCase();
    const providerType =
        KNOWN_PROVIDER_ERROR_TYPES.find(
            (value) => normalized.includes(value) || structuredType.includes(value),
        ) ??
        (structuredTypes[0]?.toLowerCase() ||
            (/model not found|unknown model|model does not exist/.test(normalized)
                ? "model_not_found"
                : undefined));
    const structuredCode = record?.code ?? dataRecord?.code;
    const safeCode =
        typeof structuredCode === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(structuredCode)
            ? structuredCode
            : /\b(?:code|error code)\s*[:= ]\s*([A-Za-z][A-Za-z0-9_.-]{0,39})\b/i.exec(
                  message,
              )?.[1];
    const nameField = typeof record?.name === "string" ? record.name : undefined;
    const className =
        nameField && nameField !== "Error"
            ? nameField
            : (error as { constructor?: { name?: string } } | null)?.constructor?.name;
    const safeClass =
        className &&
        className !== "Error" &&
        /^[A-Za-z][A-Za-z0-9]{0,39}(?:Error|Exception)$/.test(className)
            ? `class_${className}`
            : undefined;
    const detail = [
        status ? `http_${status}` : undefined,
        providerType,
        safeCode ? `code_${safeCode}` : undefined,
        safeClass,
    ].filter((part): part is string => part !== undefined);
    return capHistorianFailureReason(`${prefix}${detail.length > 0 ? `:${detail.join(":")}` : ""}`);
}

/** Preserve child-stderr lines that match a recognized launcher-error pattern. */
export function subprocessExitHistorianFailureReason(exitCode: unknown, stderr: unknown): string {
    const code =
        typeof exitCode === "number" && Number.isInteger(exitCode)
            ? String(exitCode)
            : typeof exitCode === "string" && /^-?\d{1,6}$/.test(exitCode)
              ? exitCode
              : "unknown";
    const firstLine =
        typeof stderr === "string"
            ? (stderr
                  .split(/\r?\n/)
                  .find((line) => line.trim().length > 0)
                  ?.trim() ?? "")
            : "";
    const escapeCharacter = String.fromCharCode(27);
    const plainLine = firstLine
        .replace(new RegExp(`${escapeCharacter}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
        .split("")
        .filter((character) => {
            const code = character.charCodeAt(0);
            return code >= 32 && code !== 127;
        })
        .join("")
        .replace(/\s+/g, " ")
        .trim();
    const launcherError =
        /^(?:Error: Failed to load extension\b|Error: Unknown option\b|Unknown option\b|error: unrecognized option\b|Error: Cannot find module\b)/i.test(
            plainLine,
        );
    return capHistorianFailureReason(
        `subprocess_exit:${code}${launcherError ? `:${plainLine}` : ""}`,
    );
}

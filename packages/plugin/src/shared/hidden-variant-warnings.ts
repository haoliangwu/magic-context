const warnings = new Map<string, string>();

/** Remember a host catalog mismatch until the process exits so status can show it once. */
export function recordHiddenVariantWarning(
    providerID: string,
    modelID: string,
    variant: string,
): string {
    const key = `${providerID}/${modelID}:${variant}`;
    const message = `variant '${variant}' not offered by ${providerID}/${modelID} on this host; running without it`;
    warnings.set(key, message);
    return message;
}

export function listHiddenVariantWarnings(): string[] {
    return [...warnings.values()];
}

export function clearHiddenVariantWarningsForTest(): void {
    warnings.clear();
}

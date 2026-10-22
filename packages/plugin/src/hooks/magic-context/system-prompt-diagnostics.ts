import { createHash } from "node:crypto";

export interface SystemPromptSnapshot {
    elements: Buffer[];
    preset: string;
}

export function snapshotSystemPrompt(system: string[], preset: string): SystemPromptSnapshot {
    return { elements: system.map((element) => Buffer.from(element)), preset };
}

/** Compare UTF-8 bytes, not JavaScript character offsets; never return prompt text. */
export function describeSystemPromptChange(
    previous: SystemPromptSnapshot | undefined,
    current: SystemPromptSnapshot,
): string {
    const metadata = (element: Buffer | undefined): string =>
        element === undefined
            ? "absent"
            : `bytes=${element.length},md5=${createHash("md5").update(element).digest("hex")}`;
    const elements: string[] = [];
    for (
        let index = 0;
        index < Math.max(previous?.elements.length ?? 0, current.elements.length);
        index++
    ) {
        const before = previous?.elements[index];
        const after = current.elements[index];
        let offset = 0;
        while (
            before &&
            after &&
            offset < Math.min(before.length, after.length) &&
            before[offset] === after[offset]
        )
            offset++;
        const status = !previous
            ? "unknown"
            : !before
              ? "added"
              : !after
                ? "removed"
                : before.equals(after)
                  ? "unchanged"
                  : "changed";
        elements.push(
            `${index}:${status}(${metadata(before)} -> ${metadata(after)},firstDiffByte=${!previous ? "unknown" : status === "unchanged" ? "none" : offset})`,
        );
    }
    return `presetChanged=${previous ? previous.preset !== current.preset : "unknown"} elements=[${elements.join("; ")}]`;
}

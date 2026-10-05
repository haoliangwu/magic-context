import {
    getMagicContextBuiltinCommands,
    type MagicContextBuiltinCommandName,
} from "../../shared/builtin-commands";
import { acceptsMagicContextCommandArguments } from "./command-handler";

export interface StrippedMagicContextCommand {
    command: MagicContextBuiltinCommandName;
    arguments: string;
}

interface PromptPart {
    type?: unknown;
    text?: unknown;
    ignored?: unknown;
    synthetic?: unknown;
}

/**
 * Match the exact single-part prompt shape emitted by OpenCode Desktop after it
 * removes a registered command's slash. Attachments, synthetic/ignored parts,
 * multiline text, prose, partial names, and unsupported arguments pass through.
 */
export function matchStrippedMagicContextCommand(
    parts: readonly PromptPart[],
): StrippedMagicContextCommand | null {
    if (parts.length !== 1) return null;
    const part = parts[0];
    if (
        part?.type !== "text" ||
        typeof part.text !== "string" ||
        part.ignored === true ||
        part.synthetic === true ||
        /[\r\n]/.test(part.text)
    ) {
        return null;
    }

    const trimmed = part.text.trim();
    const parsed = /^(\S+)(?:[ \t]+(.*))?$/.exec(trimmed);
    if (!parsed) return null;

    const command = parsed[1];
    const registry = getMagicContextBuiltinCommands();
    if (!Object.hasOwn(registry, command)) return null;

    const argumentsText = (parsed[2] ?? "").trim();
    const registeredCommand = command as MagicContextBuiltinCommandName;
    if (!acceptsMagicContextCommandArguments(registeredCommand, argumentsText)) return null;

    return { command: registeredCommand, arguments: argumentsText };
}

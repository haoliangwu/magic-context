import { fileURLToPath } from "node:url";
import type { V2Message } from "../hooks/types";
import type { StoreRow } from "../store-reader";

type Part = Record<string, unknown>;
interface Attachment {
    mime: string;
    data: string;
    name?: string;
    description?: string;
    source: { type: string; uri?: string };
    mention?: { text?: string };
}
const imageMimes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
function attachmentParts(files: Attachment[]): Part[] {
    const seen = new Map<string, Set<string>>();
    return files.flatMap((file): Part[] => {
        if (imageMimes.has(file.mime) && file.source.type === "inline" && file.mention?.text) {
            const key = JSON.stringify([
                file.mime,
                file.name ?? null,
                file.description ?? null,
                file.mention.text,
            ]);
            const payloads = seen.get(key) ?? new Set<string>();
            if (payloads.has(file.data)) return [];
            payloads.add(file.data);
            seen.set(key, payloads);
        }
        const uri = file.source.type === "uri" ? file.source.uri : undefined;
        const location = uri?.startsWith("file:") ? fileURLToPath(uri) : undefined;
        if (file.mime === "text/plain" || file.mime === "application/x-directory") {
            const directory = file.mime === "application/x-directory";
            return [
                {
                    type: "text",
                    text: `\n\n${[
                        directory
                            ? `Attached directory: ${location ?? file.name ?? uri ?? "directory"}`
                            : `Attached file: ${file.name ?? uri ?? "inline attachment"}`,
                        file.description === undefined
                            ? undefined
                            : `Description: ${file.description}`,
                        directory && !file.data.length ? undefined : "",
                        directory && !file.data.length
                            ? undefined
                            : Buffer.from(file.data, "base64").toString("utf8"),
                    ]
                        .filter((line) => line !== undefined)
                        .join("\n")}`,
                    metadata: {
                        attachment: {
                            source: file.source,
                            name: file.name,
                            description: file.description,
                        },
                    },
                },
            ];
        }
        if (!imageMimes.has(file.mime) && file.mime !== "application/pdf") return [];
        return [
            ...(location ? [{ type: "text", text: `Attached file: ${location}` }] : []),
            {
                type: "media",
                mediaType: file.mime,
                data: file.data,
                filename: file.name,
                metadata:
                    file.description === undefined ? undefined : { description: file.description },
            },
        ];
    });
}

/** Render retained store rows using GA's to-llm-message representation, not the lossy
 * historian projection. Tool results stay paired, and attachments retain their payloads.
 * The store remains read-only; the host's bounded recent-context is not a preservation source.
 */
export function restoreRow(row: StoreRow, model: { providerID: string; id: string }): V2Message[] {
    const data = row.data;
    const make = (role: string, content: Part[], metadata: unknown = data.metadata): V2Message => ({
        id: row.id,
        role,
        content,
        ...(metadata === undefined ? {} : { metadata }),
    });
    if (row.type === "user") {
        const skills = (data.skills ?? []) as Array<{ text?: string }>;
        const content: Part[] = [
            ...skills.flatMap((skill) =>
                skill.text === undefined ? [] : [{ type: "text", text: skill.text }],
            ),
            ...(data.text ? [{ type: "text", text: data.text }] : []),
            ...attachmentParts((data.files ?? []) as Attachment[]),
        ];
        return content.length
            ? [
                  make("user", content, {
                      ...((data.metadata as Part) ?? {}),
                      ...((data.agents as unknown[])?.length ? { agents: data.agents } : {}),
                  }),
              ]
            : [];
    }
    if (["synthetic", "skill", "system"].includes(row.type))
        return [
            make(row.type === "system" ? "system" : "user", [
                { type: "text", text: data.text ?? "" },
            ]),
        ];
    if (row.type === "location-switched")
        return [
            make("user", [
                {
                    type: "text",
                    text: `The working directory has been changed to ${(data.location as { directory: string }).directory}.`,
                },
            ]),
        ];
    if (row.type === "shell")
        return (data.metadata as Part | undefined)?.background === true
            ? []
            : [
                  make("user", [
                      {
                          type: "text",
                          text: `The following shell command was executed by the user:\n\nCommand:\n${data.command}\n\nOutput:\n${(data.output as { output?: string } | undefined)?.output ?? ""}`,
                      },
                  ]),
              ];
    if (row.type !== "assistant") return [];
    const previousModel = data.model as { providerID: string; id: string };
    const sameProvider = previousModel?.providerID === model.providerID;
    const sameModel = sameProvider && previousModel?.id === model.id;
    const reuse = sameModel && data.error === undefined;
    const metadata = (state: unknown) =>
        state === undefined ? undefined : { [model.providerID]: state };
    const content: Part[] = [];
    const results: V2Message[] = [];
    for (const part of data.content ?? []) {
        if (part.type === "text") {
            if (part.text !== "")
                content.push({
                    type: "text",
                    text: part.text,
                    providerMetadata: reuse ? metadata(part.state) : undefined,
                });
            continue;
        }
        if (part.type === "reasoning") {
            if (part.text !== "" || (reuse && part.state !== undefined))
                content.push({
                    type: reuse || data.error === undefined ? "reasoning" : "text",
                    text: part.text,
                    providerMetadata: reuse ? metadata(part.state) : undefined,
                });
            continue;
        }
        const state = part.state as Part;
        const completed = state.status === "completed" || state.status === "error";
        const toolReuse = reuse || (sameModel && part.executed === true && completed);
        let input = state.input;
        if (state.status === "streaming" && typeof input === "string") {
            try {
                input = JSON.parse(input);
            } catch {
                /* An unfinished tool input is still text on GA. */
            }
        }
        content.push({
            type: "tool-call",
            id: part.id,
            name: part.name,
            input,
            providerExecuted: part.executed,
            providerMetadata: toolReuse ? metadata(part.providerState) : undefined,
        });
        if (!completed) continue;
        const toolContent = (state.content ?? []) as Part[];
        const single = toolContent.length === 1 ? toolContent[0] : undefined;
        const result: Part = {
            type: "tool-result",
            id: part.id,
            name: part.name,
            providerExecuted: part.executed,
            providerMetadata: toolReuse
                ? metadata(part.providerResultState ?? part.providerState)
                : sameProvider
                  ? metadata(part.providerResultState)
                  : undefined,
            result:
                state.status === "error"
                    ? { error: state.error, content: toolContent }
                    : single?.type === "text"
                      ? { type: "text", value: single.text }
                      : { type: "content", value: toolContent },
            ...(state.status === "error" ? { resultType: "error" } : {}),
        };
        if (part.executed === true) content.push(result);
        else results.push({ role: "tool", content: [result] });
    }
    return [...(content.length ? [make("assistant", content)] : []), ...results];
}

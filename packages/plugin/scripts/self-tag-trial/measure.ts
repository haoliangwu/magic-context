export type Event = { kind: string; [key: string]: any };
export type LiveRow = {
    model: string; variant: string; scenario: string; session: string; position: number; userTurn: number;
    messageID: string; partID: string | null; raw: string; rawFirst60: string; assignedTag: number | null;
    wellFormed: boolean; canonicalPrefix: boolean; correct: boolean | null; delta: number | null; malformed: boolean; misplaced: boolean;
    byteIdentity: boolean | null; retagged: string | null; toolOnly: boolean; tagOnlyText: boolean;
};
export function hasMisplacedTextTag(raw: string): boolean {
    const prefix = /^§\d+§ /.exec(raw);
    // A malformed leading token is a notation failure, not a second mid-text tag.
    const body = prefix ? raw.slice(prefix[0].length) : raw.replace(/^\s*§\S*\s?/, "");
    return /§/.test(body);
}

export function measure(events: Event[], session: string, variant: string, scenario: string,
    lookup: (messageID: string, partIndex: number) => number | null): LiveRow[] {
    const toolOwner = (event: Event): string | null => {
        if (event.input.messageID) return event.input.messageID;
        for (const wire of events.filter(e => e.kind === "wire")) {
            const message = wire.messages.find((m: any) => m.parts.some((p: any) => p.type === "tool" && p.callID === event.input.callID));
            if (message) return message.info.id;
        }
        return null;
    };
    const replies = new Map<string, { position: number; userTurn: number }>();
    let position = 0;
    for (const event of events) {
        const id = event.kind === "raw" ? event.input.messageID : event.kind === "tool" ? toolOwner(event) : null;
        if (id && !replies.has(id)) replies.set(id, { position: ++position, userTurn: event.userTurn });
    }
    const rows: LiveRow[] = [];
    for (const [id, meta] of replies) {
        const texts = events.filter(e => e.kind === "raw" && e.input.messageID === id);
        const toolEvents = events.filter(e => e.kind === "tool" && toolOwner(e) === id);
        const argumentTags = toolEvents.some(e => /§/.test(JSON.stringify(e.args)));
        if (!texts.length) {
            rows.push({ model: "deepseek-v4.1-flash", variant, scenario, session, ...meta, messageID: id, partID: null,
                raw: "", rawFirst60: "", assignedTag: null, wellFormed: false, canonicalPrefix: false, correct: null, delta: null,
                malformed: false, misplaced: argumentTags, byteIdentity: true, retagged: "", toolOnly: true, tagOnlyText: false });
        }
        for (const raw of texts) {
            const prefix = /^§(\d+)§ /.exec(raw.text);
            const closedPair = /^§(\d+)§/.exec(raw.text);
                        let assignedTag: number | null = null;
            let retagged: string | null = null;
            const start = events.indexOf(raw);
            for (const next of events.slice(start + 1).filter(e => e.kind === "wire")) {
                const message = next.messages.find((m: any) => m.info.id === id);
                const index = message?.parts.findIndex((p: any) => p.id === raw.input.partID) ?? -1;
                if (index >= 0) { assignedTag = lookup(id, index); retagged = message.parts[index].text; break; }
            }
            const stripped = events.find(e => e.kind === "stripped" && e.input.partID === raw.input.partID)?.text;
            const tagOnlyText = toolEvents.length > 0 && typeof stripped === "string" && !stripped.trim() && /§/.test(raw.text);
            rows.push({ model: "deepseek-v4.1-flash", variant, scenario, session, ...meta, messageID: id, partID: raw.input.partID,
                raw: raw.text, rawFirst60: raw.text.slice(0, 60), assignedTag, wellFormed: !!closedPair, canonicalPrefix: !!prefix,
                correct: assignedTag !== null ? !!closedPair && Number(closedPair[1]) === assignedTag : null,
                delta: closedPair && assignedTag !== null ? Number(closedPair[1]) - assignedTag : null,
                malformed: /§/.test(raw.text.replace(/§\d+§/g, "")),
                misplaced: hasMisplacedTextTag(raw.text) || argumentTags || tagOnlyText,
                byteIdentity: retagged !== null ? retagged === raw.text : null, retagged, toolOnly: false, tagOnlyText });
        }
    }
    return rows;
}

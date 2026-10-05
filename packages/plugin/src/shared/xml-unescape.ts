const XML_ENTITY_REGEX = /&(amp|apos|quot|lt|gt);/g;
const XML_ENTITIES: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    quot: '"',
    lt: "<",
    gt: ">",
};

/**
 * Decode the five predefined XML entities in a single left-to-right pass, so
 * every entity is decoded exactly once. Chained replacements that decode
 * `&amp;` first would turn the escaped literal `&amp;lt;` into `<` instead of
 * the text `&lt;`. Unknown entities are left untouched. The Rust historian
 * parser (`historian_validate::unescape_xml`) must stay identical.
 */
export function unescapeXml(s: string): string {
    return s.replace(XML_ENTITY_REGEX, (entity, name: string) => XML_ENTITIES[name] ?? entity);
}

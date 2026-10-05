/** Remove the redundant subject from user-profile entries at render time only. */
export function renderUserProfileContent(content: string): string {
    if (!content.startsWith("User ")) return content;

    const remainder = content.slice("User ".length);
    const firstCharacter = Array.from(remainder)[0];
    if (firstCharacter === undefined) return "";
    return `${firstCharacter.toUpperCase()}${remainder.slice(firstCharacter.length)}`;
}

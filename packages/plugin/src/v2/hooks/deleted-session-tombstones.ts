export class DeletedSessionTombstones {
    readonly #ids = new Set<string>();

    constructor(readonly limit = 1_000) {
        if (!Number.isSafeInteger(limit) || limit < 1) {
            throw new Error("Deleted-session tombstone limit must be a positive integer");
        }
    }

    add(sessionID: string): void {
        this.#ids.delete(sessionID);
        this.#ids.add(sessionID);
        while (this.#ids.size > this.limit) {
            const oldest = this.#ids.values().next().value;
            if (oldest === undefined) break;
            this.#ids.delete(oldest);
        }
    }

    has(sessionID: string): boolean {
        return this.#ids.has(sessionID);
    }

    clear(): void {
        this.#ids.clear();
    }

    get size(): number {
        return this.#ids.size;
    }
}

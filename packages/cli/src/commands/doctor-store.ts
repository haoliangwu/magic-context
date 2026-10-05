import {
    closeDatabase,
    getPersistedSchemaVersion,
    openDatabase,
    resolveDatabasePath,
} from "@magic-context/core/features/magic-context/storage-db";
import { openExistingContextDatabase } from "../lib/database-access";

export function runDoctorStoreInit(print: (line: string) => void = console.log): number {
    try {
        const { dbPath } = resolveDatabasePath();
        // Existing stores are inspected read-only so provisioning does not upgrade a
        // database that a running host may still be using with an older schema version.
        const existing = openExistingContextDatabase(dbPath, { readonly: true });
        if (existing) {
            try {
                print(
                    `Store already exists: ${dbPath} (schema v${getPersistedSchemaVersion(existing)})`,
                );
            } finally {
                existing.close();
            }
            return 0;
        }
        const db = openDatabase(dbPath);
        if (!db)
            throw new Error(
                `Unable to initialize ${dbPath}: the storage schema fence refused the open.`,
            );
        try {
            print(`Store initialized: ${dbPath} (schema v${getPersistedSchemaVersion(db)})`);
        } finally {
            closeDatabase();
        }
        return 0;
    } catch (error) {
        print(error instanceof Error ? error.message : String(error));
        return 1;
    }
}

export function runDoctorStoreCli(args: string[]): number {
    if (args.length !== 1 || args[0] !== "init") {
        console.error("Usage: magic-context doctor store init");
        return 1;
    }
    return runDoctorStoreInit();
}

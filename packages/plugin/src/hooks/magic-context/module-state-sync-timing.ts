import type { ContextDatabase } from "../../features/magic-context/storage";
import { sessionLog } from "../../shared/logger";

export class StateSyncTiming {
    collect = 0;
    serialize = 0;
    pageBuild = 0;
    transport = 0;
    status = 0;
    moduleAck = 0;
    compartments = 0;
    tags = 0;
    bytes = 0;
    pages = 0;
    rawReads = 0;
    rawMessages = 0;
    readonly started = performance.now();

    collectRead<T>(read: () => T): T {
        const start = performance.now();
        try {
            return read();
        } finally {
            this.collect += performance.now() - start;
        }
    }

    log(sessionId: string, phase = "pass"): void {
        sessionLog(
            sessionId,
            `transform stage: stage=rust.state_sync_detail phase=${phase} elapsed=${(performance.now() - this.started).toFixed(3)}ms collect_ms=${this.collect.toFixed(3)} serialize_ms=${this.serialize.toFixed(3)} page_build_ms=${this.pageBuild.toFixed(3)} status_ms=${this.status.toFixed(3)} transport_ms=${this.transport.toFixed(3)} module_ack_ms=${this.moduleAck.toFixed(3)} compartments=${this.compartments} tags=${this.tags} bytes=${this.bytes} pages=${this.pages} raw_reads=${this.rawReads} raw_messages=${this.rawMessages}`,
        );
    }
}

/** Attribute SQLite reads separately from the payload's CPU serialization work. */
export function timedStateSyncDatabase(
    db: ContextDatabase,
    timing: StateSyncTiming,
): ContextDatabase {
    return new Proxy(db, {
        get(target, key) {
            if (key === "prepare")
                return (...args: Parameters<ContextDatabase["prepare"]>) => {
                    const statement = target.prepare(...args);
                    return new Proxy(statement, {
                        get(stmt, method) {
                            const value = Reflect.get(stmt, method);
                            if (typeof value !== "function") return value;
                            if (method === "get" || method === "all")
                                return (...params: unknown[]) =>
                                    timing.collectRead(() => value.apply(stmt, params));
                            return value.bind(stmt);
                        },
                    });
                };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

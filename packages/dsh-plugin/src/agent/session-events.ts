/**
 * dsh 0.1.2 removed `Session#events` (the live array); the log materializes
 * through `snapshotEvents()` / `eventAt()` instead. 0.1.1 cores still expose
 * `.events` directly (tui/mc profiles). This helper keeps the plugin binary
 * running under both cores: prefer the 0.1.2 accessors, fall back to the
 * 0.1.1 array, and answer [] for anything else (defensive historical shape).
 */

export function sessionEventsOf(session: unknown): readonly unknown[] {
  const s = session as
    | { events?: readonly unknown[]; snapshotEvents?: () => readonly unknown[] }
    | undefined
  if (typeof s?.snapshotEvents === 'function') return s.snapshotEvents()
  return Array.isArray(s?.events) ? s.events : []
}

export function sessionEventAt(session: unknown, seq: number): unknown {
  const s = session as { eventAt?: (seq: number) => unknown } | undefined
  if (typeof s?.eventAt === 'function') return s.eventAt(seq)
  return sessionEventsOf(session)[seq]
}

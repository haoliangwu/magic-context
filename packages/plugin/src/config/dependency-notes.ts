import { PROJECT_MEMORY_DREAM_TASKS } from "../features/magic-context/dreamer/task-registry";
import { isDreamerRunnable } from "./agent-disable";

/**
 * Settings whose effect depends on a different section of the config. These
 * lines name a setting that is on but cannot act because another setting turns
 * off what it relies on, so a user reading the log can tell why nothing happens.
 *
 * Only settings the user can see as "on" are reported: an explicit
 * `memory.enabled: false` or `dreamer.disable: true` is the cause in every line,
 * so a configuration that sets neither produces none.
 */
export interface DependencyNoteConfig {
    memory?: { enabled?: boolean } | null;
    smart_notes?: { enabled?: boolean } | null;
    dreamer?: {
        disable?: boolean;
        tasks?: Record<string, { schedule?: string } | undefined>;
    } | null;
}

function scheduledTasks(config: DependencyNoteConfig): string[] {
    const tasks = config.dreamer?.tasks ?? {};
    return Object.entries(tasks)
        .filter(([, task]) => typeof task?.schedule === "string" && task.schedule.trim() !== "")
        .map(([name]) => name);
}

/** The dependency notes for one resolved config, in a stable order. */
export function configDependencyNotes(config: DependencyNoteConfig): string[] {
    const notes: string[] = [];
    const dreamerRunnable = isDreamerRunnable(config);
    const dreamerDisabled = config.dreamer?.disable === true;
    const memoryOff = config.memory?.enabled === false;

    const memoryTasks = scheduledTasks(config).filter((task) =>
        (PROJECT_MEMORY_DREAM_TASKS as readonly string[]).includes(task),
    );
    if (dreamerRunnable && memoryOff && memoryTasks.length > 0) {
        notes.push(
            `memory.enabled is false, so these scheduled dreamer tasks do not run for this project, on schedule or through /ctx-dream: ${memoryTasks.join(", ")}. maintain-docs, evaluate-smart-notes and review-user-memories still run.`,
        );
    }
    if (dreamerDisabled && config.smart_notes?.enabled !== false) {
        notes.push(
            "dreamer.disable is true, so smart_notes.enabled has no effect: ctx_note does not offer surface_condition and pending smart notes are not evaluated.",
        );
    }
    const reviewSchedule = config.dreamer?.tasks?.["review-user-memories"]?.schedule;
    if (dreamerDisabled && typeof reviewSchedule === "string" && reviewSchedule.trim() !== "") {
        notes.push(
            "dreamer.disable is true, so dreamer.tasks.review-user-memories.schedule has no effect: the historian does not collect user observations and the <user-profile> block gets no new entries.",
        );
    }
    return notes;
}

const loggedNotes = new Set<string>();

/**
 * Log each dependency note once per process. OpenCode Desktop starts one
 * plugin instance per open project in the same process, so a note already
 * written by another instance is skipped rather than repeated.
 */
export function logConfigDependencyNotesOnce(
    config: DependencyNoteConfig,
    log: (message: string) => void,
): string[] {
    const fresh = configDependencyNotes(config).filter((note) => !loggedNotes.has(note));
    for (const note of fresh) {
        loggedNotes.add(note);
        log(`[magic-context] config note: ${note}`);
    }
    return fresh;
}

/** Test-only: forget which notes this process has logged. */
export function resetConfigDependencyNotesForTest(): void {
    loggedNotes.clear();
}

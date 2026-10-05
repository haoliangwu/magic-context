import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import type {
	ExtensionCommandContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	__resetTodoSnapshotsForTests,
	getTodoSnapshot,
	registerTodoOverlay,
	registerTodosCommand,
	rememberTodowriteToolCallTodos,
	setTodoSnapshot,
	TodoOverlay,
} from "./todo-view-pi";
import { createTodowriteTool } from "./todowrite";

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
} as never;
function makeUi() {
	const setWidgetCalls: unknown[][] = [];
	const notifyCalls: unknown[][] = [];
	const ui = {
		setWidget: (...args: unknown[]) => setWidgetCalls.push(args),
		notify: (...args: unknown[]) => notifyCalls.push(args),
	} as unknown as ExtensionUIContext;
	return { ui, setWidgetCalls, notifyCalls };
}
function commandCtx(
	sessionId = "ses-test",
	ui = makeUi().ui,
): ExtensionCommandContext {
	return {
		hasUI: true,
		ui,
		sessionManager: { getSessionId: () => sessionId },
	} as never;
}
function widgetFactory(call: unknown[]) {
	return call[1] as (
		tui: { requestRender: () => void },
		theme: typeof identityTheme,
	) => { render: (width: number) => string[]; invalidate: () => void };
}
beforeEach(() => {
	__resetTodoSnapshotsForTests();
});
describe("todowrite tool rendering", () => {
	it("renders glyph lines while preserving the exact JSON text result", async () => {
		const tool = createTodowriteTool();
		const todos = [
			{ id: "a", content: "Plan", status: "pending", priority: "high" },
			{ id: "b", content: "Build", status: "in_progress", priority: "medium" },
			{ id: "c", content: "Done", status: "completed", priority: "low" },
			{ id: "d", content: "Drop", status: "cancelled", priority: "low" },
		];
		const result = await tool.execute(
			"call-1",
			{ todos } as never,
			undefined,
			undefined,
			{} as never,
		);
		expect(result.content).toEqual([
			{ type: "text", text: JSON.stringify(todos, null, 2) },
		]);
		const renderResult = tool.renderResult;
		const renderCall = tool.renderCall;
		if (!renderResult || !renderCall)
			throw new Error("todowrite render hooks missing");
		const rendered = renderResult(
			result,
			{ expanded: false, isPartial: false },
			identityTheme,
			{} as never,
		)
			.render(120)
			.join("\n");
		expect(rendered).toContain("○ #a Plan");
		expect(rendered).toContain("◐ #b Build");
		expect(rendered).toContain("✓ #c Done");
		expect(rendered).toContain("✗ #d Drop");
		expect(
			renderCall({ todos } as never, identityTheme, {} as never).render(80)[0],
		).toContain("Todos — 3 active");
	});
	it("formats a result's rows once per width instead of on every frame", async () => {
		const tool = createTodowriteTool();
		const todos = [
			{ id: "a", content: "Plan", status: "pending", priority: "high" },
			{ id: "b", content: "Build", status: "in_progress", priority: "medium" },
		];
		const result = await tool.execute(
			"call-memo",
			{ todos } as never,
			undefined,
			undefined,
			{} as never,
		);
		let themeCalls = 0;
		const countingTheme = {
			...(identityTheme as Record<string, unknown>),
			fg: (_color: string, text: string) => {
				themeCalls += 1;
				return text;
			},
		} as never;
		const renderResult = tool.renderResult;
		if (!renderResult) throw new Error("todowrite renderResult missing");
		const component = renderResult(
			result,
			{ expanded: false, isPartial: false },
			countingTheme,
			{} as never,
		);
		const first = component.render(120);
		const afterFirst = themeCalls;
		expect(afterFirst).toBeGreaterThan(0);
		for (let frame = 0; frame < 50; frame += 1) component.render(120);
		expect(themeCalls).toBe(afterFirst);
		expect(component.render(120)).toEqual(first);
		component.render(60);
		expect(themeCalls).toBeGreaterThan(afterFirst);
		const afterResize = themeCalls;
		component.invalidate();
		component.render(60);
		expect(themeCalls).toBeGreaterThan(afterResize);
	});
	it("uses cached todos when the transcript component was created with empty args", () => {
		const tool = createTodowriteTool();
		const renderCall = tool.renderCall;
		if (!renderCall) throw new Error("todowrite renderCall missing");
		const todos = [
			{ id: "1", content: "Work", status: "in_progress" as const },
			...Array.from({ length: 9 }, (_, index) => ({
				id: String(index + 2),
				content: `Done ${index + 2}`,
				status: "completed" as const,
			})),
		];
		rememberTodowriteToolCallTodos("call-stale", todos);
		expect(
			renderCall({}, identityTheme, {
				toolCallId: "call-stale",
			} as never).render(80)[0],
		).toContain("Todos — 1 active");
	});
	it("falls back to args when no cached tool-call todos exist", () => {
		const tool = createTodowriteTool();
		const renderCall = tool.renderCall;
		if (!renderCall) throw new Error("todowrite renderCall missing");
		const todos = [
			{ id: "1", content: "Plan", status: "pending" as const },
			{ id: "2", content: "Build", status: "in_progress" as const },
			{ id: "3", content: "Done", status: "completed" as const },
		];
		expect(
			renderCall({ todos } as never, identityTheme, {
				toolCallId: "call-miss",
			} as never).render(80)[0],
		).toContain("Todos — 2 active");
	});
	it("renders identically when cache and args already agree", () => {
		const tool = createTodowriteTool();
		const renderCall = tool.renderCall;
		if (!renderCall) throw new Error("todowrite renderCall missing");
		const todos = [
			{ id: "1", content: "Plan", status: "pending" as const },
			{ id: "2", content: "Done", status: "completed" as const },
		];
		rememberTodowriteToolCallTodos("call-equal", todos);
		expect(
			renderCall({ todos } as never, identityTheme, {
				toolCallId: "call-equal",
			} as never).render(80),
		).toEqual(
			renderCall({ todos } as never, identityTheme, {
				toolCallId: "call-equal-miss",
			} as never).render(80),
		);
	});
	it("uses cached todos for stale-empty results", () => {
		const tool = createTodowriteTool();
		const renderResult = tool.renderResult;
		if (!renderResult) throw new Error("todowrite renderResult missing");
		const todos = [
			{ id: "1", content: "Work", status: "in_progress" as const },
			{ id: "2", content: "Done", status: "completed" as const },
		];
		rememberTodowriteToolCallTodos("call-stale-result", todos);
		const rendered = renderResult(
			{
				details: { todos: [] },
				content: [{ type: "text", text: "[]" }],
			},
			{ expanded: false, isPartial: false },
			identityTheme,
			{ toolCallId: "call-stale-result" } as never,
		)
			.render(120)
			.join("\n");
		expect(rendered).toContain("◐ #1 Work");
		expect(rendered).toContain("✓ #2 Done");
	});
	it("prefers parsed tool results over cached todos when both are present", () => {
		const tool = createTodowriteTool();
		const renderResult = tool.renderResult;
		if (!renderResult) throw new Error("todowrite renderResult missing");
		rememberTodowriteToolCallTodos("call-real-result", [
			{ id: "stale", content: "Stale", status: "pending" },
		]);
		const rendered = renderResult(
			{
				details: {
					todos: [{ id: "fresh", content: "Fresh", status: "pending" }],
				},
				content: [{ type: "text", text: "[]" }],
			},
			{ expanded: false, isPartial: false },
			identityTheme,
			{ toolCallId: "call-real-result" } as never,
		)
			.render(120)
			.join("\n");
		expect(rendered).toContain("○ #fresh Fresh");
		expect(rendered).not.toContain("Stale");
	});
	it("evicts the oldest cached tool-call todos after the cap", () => {
		const tool = createTodowriteTool();
		const renderCall = tool.renderCall;
		if (!renderCall) throw new Error("todowrite renderCall missing");
		for (let index = 1; index <= 51; index++) {
			rememberTodowriteToolCallTodos(`call-${index}`, [
				{
					id: String(index),
					content: `Task ${index}`,
					status: "pending",
				},
			]);
		}
		expect(
			renderCall({}, identityTheme, { toolCallId: "call-1" } as never).render(
				80,
			)[0],
		).toContain("Todos — 0 active");
		expect(
			renderCall({}, identityTheme, { toolCallId: "call-51" } as never).render(
				80,
			)[0],
		).toContain("Todos — 1 active");
	});
	it("caps result rows at 12 with a +N more tail", async () => {
		const tool = createTodowriteTool();
		const todos = Array.from({ length: 14 }, (_, index) => ({
			id: String(index + 1),
			content: `Task ${index + 1}`,
			status: "pending",
			priority: "medium",
		}));
		const result = await tool.execute(
			"call-2",
			{ todos } as never,
			undefined,
			undefined,
			{} as never,
		);
		const renderResult = tool.renderResult;
		if (!renderResult) throw new Error("todowrite renderResult missing");
		const lines = renderResult(
			result,
			{ expanded: false, isPartial: false },
			identityTheme,
			{} as never,
		).render(120);
		expect(lines).toHaveLength(12);
		expect(lines[lines.length - 1]).toContain("+3 more");
		expect(lines.join("\n")).not.toContain("Task 12");
	});
});
describe("/todos command", () => {
	it("prints grouped todos from the shared in-memory snapshot", async () => {
		const commands = new Map<
			string,
			{ handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
		>();
		registerTodosCommand({
			registerCommand: (name, command) => commands.set(name, command),
		} as never);
		setTodoSnapshot("ses-command", [
			{ id: "p", content: "Plan", status: "pending" },
			{ id: "w", content: "Work", status: "in_progress" },
			{ id: "d", content: "Done", status: "completed" },
		]);
		const { ui, notifyCalls } = makeUi();
		await commands.get("todos")?.handler("", commandCtx("ses-command", ui));
		expect(notifyCalls).toHaveLength(1);
		const [text, level] = notifyCalls[0] as [string, string];
		expect(level).toBe("info");
		expect(text).toContain("1/3 completed · 1 in progress · 1 pending");
		expect(text).toContain("── Pending ──");
		expect(text).toContain("○ #p Plan");
		expect(text).toContain("── In Progress ──");
		expect(text).toContain("◐ #w Work");
		expect(text).toContain("── Completed ──");
		expect(text).toContain("✓ #d Done");
	});
	it("caps each /todos section with a +N more tail", async () => {
		const commands = new Map<
			string,
			{ handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
		>();
		registerTodosCommand({
			registerCommand: (name, command) => commands.set(name, command),
		} as never);
		setTodoSnapshot("ses-command-capped", [
			...Array.from({ length: 14 }, (_, index) => ({
				id: `p${index + 1}`,
				content: `Pending ${index + 1}`,
				status: "pending" as const,
			})),
			{ id: "d", content: "Done", status: "completed" },
		]);
		const { ui, notifyCalls } = makeUi();
		await commands
			.get("todos")
			?.handler("", commandCtx("ses-command-capped", ui));
		expect(notifyCalls).toHaveLength(1);
		const [text, level] = notifyCalls[0] as [string, string];
		expect(level).toBe("info");
		expect(text).toContain("── Pending ──");
		expect(text).toContain("○ #p11 Pending 11");
		expect(text).toContain("  +3 more");
		expect(text).not.toContain("Pending 12");
		expect(text).toContain("── Completed ──");
		expect(text).toContain("✓ #d Done");
	});
	it("notifies when the session has no todos", async () => {
		const commands = new Map<
			string,
			{ handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
		>();
		registerTodosCommand({
			registerCommand: (name, command) => commands.set(name, command),
		} as never);
		const { ui, notifyCalls } = makeUi();
		await commands.get("todos")?.handler("", commandCtx("empty-session", ui));
		expect(notifyCalls).toEqual([["No todos yet.", "info"]]);
	});
});
describe("TodoOverlay lifecycle", () => {
	it("registers once and refreshes after a todo state change", () => {
		setTodoSnapshot("ses-overlay", [
			{ id: "1", content: "Plan", status: "pending" },
		]);
		const overlay = new TodoOverlay();
		const { ui, setWidgetCalls } = makeUi();
		overlay.setUICtx("ses-overlay", ui);
		overlay.update("ses-overlay");
		expect(setWidgetCalls).toHaveLength(1);
		expect(setWidgetCalls[0][0]).toBe("magic-context-todos");
		expect(typeof setWidgetCalls[0][1]).toBe("function");
		expect(setWidgetCalls[0][2]).toEqual({ placement: "aboveEditor" });
		const tui = { requestRender: () => requestRenderCount++ };
		let requestRenderCount = 0;
		widgetFactory(setWidgetCalls[0])(tui, identityTheme);
		setTodoSnapshot("ses-overlay", [
			{ id: "1", content: "Plan", status: "in_progress" },
		]);
		overlay.update("ses-overlay");
		expect(setWidgetCalls).toHaveLength(1);
		expect(requestRenderCount).toBe(1);
	});
	it("keeps in-progress rendering static without timers between state changes", () => {
		const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(
			() => undefined as never,
		);
		const setIntervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
			() => undefined as never,
		);
		const requestRenderCalls: unknown[] = [];
		const overlay = new TodoOverlay();
		const { ui, setWidgetCalls } = makeUi();
		try {
			setTodoSnapshot("ses-overlay-static", [
				{ id: "1", content: "Work", status: "in_progress" },
			]);
			overlay.setUICtx("ses-overlay-static", ui);
			overlay.update("ses-overlay-static");
			expect(setTimeoutSpy).not.toHaveBeenCalled();
			expect(setIntervalSpy).not.toHaveBeenCalled();

			const widget = widgetFactory(setWidgetCalls[0])(
				{ requestRender: () => requestRenderCalls.push(undefined) },
				identityTheme,
			);
			expect(widget.render(120).join("\n")).toContain("◐ #1 Work");
			expect(widget.render(120).join("\n")).toContain("◐ #1 Work");
			expect(requestRenderCalls).toHaveLength(0);
		} finally {
			setIntervalSpy.mockRestore();
			setTimeoutSpy.mockRestore();
			overlay.dispose();
		}
	});
	it("auto-hides on empty snapshots", () => {
		setTodoSnapshot("ses-overlay", [
			{ id: "1", content: "Plan", status: "pending" },
		]);
		const overlay = new TodoOverlay();
		const { ui, setWidgetCalls } = makeUi();
		overlay.setUICtx("ses-overlay", ui);
		overlay.update("ses-overlay");
		setTodoSnapshot("ses-overlay", []);
		overlay.update("ses-overlay");
		expect(setWidgetCalls).toHaveLength(2);
		expect(setWidgetCalls[1]).toEqual(["magic-context-todos", undefined]);
	});
	it("re-registers after widget invalidation", () => {
		setTodoSnapshot("ses-overlay", [
			{ id: "1", content: "Plan", status: "pending" },
		]);
		const overlay = new TodoOverlay();
		const { ui, setWidgetCalls } = makeUi();
		overlay.setUICtx("ses-overlay", ui);
		overlay.update("ses-overlay");
		const widget = widgetFactory(setWidgetCalls[0])(
			{ requestRender: () => undefined },
			identityTheme,
		);
		widget.invalidate();
		overlay.update("ses-overlay");
		expect(setWidgetCalls).toHaveLength(2);
		expect(typeof setWidgetCalls[1][1]).toBe("function");
	});
	it("hides completed tasks from previous turns after showing them once", () => {
		setTodoSnapshot("ses-overlay", [
			{ id: "1", content: "Done", status: "completed" },
		]);
		const overlay = new TodoOverlay();
		const { ui, setWidgetCalls } = makeUi();
		overlay.setUICtx("ses-overlay", ui);
		overlay.update("ses-overlay");
		const widget = widgetFactory(setWidgetCalls[0])(
			{ requestRender: () => undefined },
			identityTheme,
		);
		expect(widget.render(120).join("\n")).toContain("Done");
		overlay.hideCompletedTasksFromPreviousTurn();
		expect(setWidgetCalls[setWidgetCalls.length - 1]).toEqual([
			"magic-context-todos",
			undefined,
		]);
		expect(widget.render(120)).toEqual([]);
	});
	it("seeds from session_meta.last_todo_state and clears on session switch", async () => {
		const tool = createTodowriteTool();
		const renderCall = tool.renderCall;
		if (!renderCall) throw new Error("todowrite renderCall missing");
		const handlers = new Map<
			string,
			(event: unknown, ctx: unknown) => Promise<void> | void
		>();
		rememberTodowriteToolCallTodos("call-session-switch", [
			{ id: "cached", content: "Cached", status: "pending" },
		]);
		registerTodoOverlay(
			{
				on: (event, handler) => handlers.set(event, handler as never),
			} as never,
			{
				readLastTodoState: () =>
					JSON.stringify([
						{ content: "Seeded", status: "pending", priority: "medium" },
					]),
			},
		);
		const { ui, setWidgetCalls } = makeUi();
		const ctx = {
			hasUI: true,
			ui,
			sessionManager: { getSessionId: () => "ses-seeded" },
		};
		await handlers.get("session_start")?.({ type: "session_start" }, ctx);
		expect(getTodoSnapshot("ses-seeded").todos).toEqual([
			{ content: "Seeded", status: "pending", priority: "medium" },
		]);
		expect(setWidgetCalls).toHaveLength(1);
		await handlers.get("session_before_switch")?.(
			{ type: "session_before_switch" },
			ctx,
		);
		expect(getTodoSnapshot("ses-seeded").todos).toEqual([]);
		expect(setWidgetCalls[setWidgetCalls.length - 1]).toEqual([
			"magic-context-todos",
			undefined,
		]);
		expect(
			renderCall({}, identityTheme, {
				toolCallId: "call-session-switch",
			} as never).render(80)[0],
		).toContain("Todos — 0 active");
	});
	it("caps content rows with a +N more tail", () => {
		setTodoSnapshot(
			"ses-overlay",
			Array.from({ length: 14 }, (_, index) => ({
				id: String(index + 1),
				content: `Task ${index + 1}`,
				status: "pending",
			})),
		);
		const overlay = new TodoOverlay();
		const { ui, setWidgetCalls } = makeUi();
		overlay.setUICtx("ses-overlay", ui);
		overlay.update("ses-overlay");
		const widget = widgetFactory(setWidgetCalls[0])(
			{ requestRender: () => undefined },
			identityTheme,
		);
		const lines = widget.render(120);
		expect(lines).toHaveLength(13); // header + 11 tasks + tail
		expect(lines[lines.length - 1]).toContain("+3 more");
	});
});

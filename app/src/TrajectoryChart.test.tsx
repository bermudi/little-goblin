import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { ts } from "./opsShared.tsx";
import type {
	AppWindowCall,
	AppWindowRun,
	AppWindowToolRun,
} from "../../src/http/app-wire.ts";
import { buildTrajectory } from "./trajectory.ts";
import { TrajectoryChart } from "./TrajectoryChart.tsx";

const call: AppWindowCall = {
	callId: "call-1",
	purpose: null,
	model: "test",
	startedMs: 10,
	finishedMs: 50,
	status: "failed",
	inputTokens: 10,
	outputTokens: 2,
	cacheRead: 0,
	cacheWrite: 0,
	prefixRelation: "append",
	sharedMessages: 1,
};

const runs: AppWindowRun[] = [
	{ runId: "r1", startedMs: 0, finishedMs: 100, status: "completed", resumedFrom: null },
	{ runId: "r2", startedMs: 200, finishedMs: null, status: "running", resumedFrom: null },
];

function mount(): {
	container: HTMLDivElement;
	root: Root;
	restore: () => void;
} {
	const win = new Window();
	const previous = {
		window: globalThis.window,
		document: globalThis.document,
		HTMLElement: globalThis.HTMLElement,
	};
	Object.assign(globalThis, { window: win, document: win.document, HTMLElement: win.HTMLElement });
	const container = win.document.createElement("div");
	const root: Root = createRoot(container as unknown as Element);
	return {
		container: container as unknown as HTMLDivElement,
		root,
		restore: () => {
			Object.assign(globalThis, previous);
			win.close();
		},
	};
}

describe("TrajectoryChart", () => {
	test("renders accessible rows and status classes", () => {
		const { container, root, restore } = mount();
		const endedCall: AppWindowCall = {
			...call,
			callId: "call-unfinished",
			finishedMs: null,
			status: "started",
		};
		const liveCall: AppWindowCall = {
			...call,
			callId: "call-live",
			startedMs: 210,
			finishedMs: null,
			status: "started",
		};
		const tools: AppWindowToolRun[] = [
			{
				toolCallId: "tool-1",
				runId: "r1",
				name: "probe",
				state: "completed",
				beganMs: 20,
				settledMs: 30,
				modelCallId: "call-1",
			},
			{
				toolCallId: "tool-unfinished",
				runId: "r1",
				name: "probe",
				state: "dispatched",
				beganMs: 40,
				settledMs: null,
				modelCallId: "call-unfinished",
			},
			{
				toolCallId: "tool-running",
				runId: "r2",
				name: "probe",
				state: "dispatched",
				beganMs: 220,
				settledMs: null,
				modelCallId: "call-live",
			},
		];
		act(() =>
			root.render(<TrajectoryChart rows={buildTrajectory([call, endedCall, liveCall], tools, runs, 320)} />),
		);
		expect(container.querySelectorAll('[role="img"]')).toHaveLength(2);
		expect(container.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
			"2 model calls, 2 tools",
		);
		expect(container.querySelector(".win-traj-call.append")).not.toBeNull();
		expect(container.querySelector(".win-traj-call.failed")).not.toBeNull();
		expect(container.querySelector(".win-traj-tool.ok")).not.toBeNull();
		const unfinishedCall = container.querySelector(".win-traj-call.unfinished");
		expect(unfinishedCall).not.toBeNull();
		expect(unfinishedCall!.classList.contains("running")).toBe(false);
		expect(unfinishedCall!.classList.contains("failed")).toBe(false);
		const unfinishedTool = container.querySelector<HTMLElement>(".win-traj-tool.unfinished");
		expect(unfinishedTool).not.toBeNull();
		expect(unfinishedTool!.classList.contains("running")).toBe(false);
		expect(unfinishedTool!.classList.contains("failed")).toBe(false);
		expect(unfinishedTool!.title.endsWith("· …")).toBe(true);
		expect(unfinishedCall!.querySelectorAll("span")[1]!.textContent).toMatch(/^…/);
		expect(
			container.querySelector(".win-traj-call.running")!.querySelectorAll("span")[1]!.textContent,
		).toMatch(/^0\.1s/);
		expect(container.querySelector(".win-traj-call.running")).not.toBeNull();
		const runningTool = container.querySelector<HTMLElement>(".win-traj-tool.running");
		expect(runningTool).not.toBeNull();
		expect(runningTool!.textContent).toBe("probe");
		expect(parseFloat(runningTool!.style.left)).toBeCloseTo(((220 - 200) / 120) * 100);
		expect(parseFloat(runningTool!.style.width)).toBeCloseTo(((320 - 220) / 120) * 100);
		expect(runningTool!.style.width).toMatch(/%$/);
		expect(runningTool!.title.endsWith("· 0.1s")).toBe(true);
		act(() => root.unmount());
		restore();
	});

	test("each tool's name, state and duration is text a screen reader can reach", () => {
		const { container, root, restore } = mount();
		const settledTool: AppWindowToolRun = {
			toolCallId: "tool-sr",
			runId: "r1",
			name: "probe",
			state: "completed",
			beganMs: 221,
			settledMs: 1221,
			modelCallId: call.callId,
		};
		act(() =>
			root.render(
				<TrajectoryChart rows={buildTrajectory([call], [settledTool], [runs[0]!], 1500)} />,
			),
		);
		const lists = container.querySelectorAll("ul.sr-only");
		expect(lists).toHaveLength(1);
		expect(container.querySelector('[role="img"]')!.contains(lists[0]!)).toBe(false);
		expect(lists[0]!.querySelectorAll("li")).toHaveLength(1);
		expect(lists[0]!.querySelector("li")!.textContent).toBe(
			`probe · completed · 1.0s · call at ${ts(new Date(call.startedMs).toISOString())}`,
		);
		act(() => root.unmount());
		restore();
	});

	test("a row without tools has no screen-reader list", () => {
		const { container, root, restore } = mount();
		act(() => root.render(<TrajectoryChart rows={buildTrajectory([call], [], [runs[0]!], 1500)} />));
		expect(container.querySelector("ul.sr-only")).toBeNull();
		act(() => root.unmount());
		restore();
	});

	test("each prefix relation and each tool outcome gets its own class", () => {
		const { container, root, restore } = mount();
		const relations = ["first", "same", "append", "rewrite"] as const;
		const calls: AppWindowCall[] = relations.map((relation, index) => ({
			...call,
			callId: `call-${relation}`,
			startedMs: index * 20,
			finishedMs: index * 20 + 10,
			status: "completed",
			prefixRelation: relation,
		}));
		const tools: AppWindowToolRun[] = (["completed", "failed"] as const).map((state, index) => ({
			toolCallId: `tool-${state}`,
			runId: "r1",
			name: "probe",
			state,
			beganMs: 20 + index * 20,
			settledMs: 29 + index * 20,
			modelCallId: null,
		}));
		act(() => root.render(<TrajectoryChart rows={buildTrajectory(calls, tools, runs, 1000)} />));
		expect([...container.querySelectorAll(".win-traj-call")].map((node) => node.className)).toEqual(
			relations.map((relation) => `win-traj-call ${relation}`),
		);
		expect([...container.querySelectorAll(".win-traj-tool")].map((node) => node.className)).toEqual([
			"win-traj-tool ok",
			"win-traj-tool failed",
		]);
		act(() => root.unmount());
		restore();
	});
});

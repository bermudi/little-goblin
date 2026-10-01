// Tool-part dispatch — one expandable row per call inside the Worked
// fold. The row maps part.state to a face: streaming states get a
// skeleton body, output-available goes to the tool's bespoke view
// (schema failure → the generic renderer), output-error gets the error
// renderer. Unknown tool names always land on the generic view — a
// transcript can never be blanked by a tool it doesn't know.

import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { Clip, ErrBox, Skeleton, type Face, type ToolView } from "./bits.tsx";
import { firstLine, joinSummary, shortJson } from "./parse.ts";
import { bashView } from "./bash.tsx";
import { editView } from "./edit.tsx";
import { fetchView } from "./fetch.tsx";
import { genericView } from "./generic.tsx";
import { readView } from "./read.tsx";
import { searchView } from "./search.tsx";
import { writeView } from "./write.tsx";

const VIEWS: Record<string, ToolView> = {
	search: searchView,
	fetch: fetchView,
	bash: bashView,
	read_file: readView,
	edit_file: editView,
	write_file: writeView,
};

// input-available means the args finished streaming and the call is
// executing; approval-responded is pending execution the same way.
const RUNNING = new Set(["input-streaming", "input-available", "approval-responded"]);
const WAITING = new Set(["approval-requested"]);

export function partRunning(part: ToolUIPart | DynamicToolUIPart): boolean {
	return RUNNING.has(part.state);
}

export function partFailed(part: ToolUIPart | DynamicToolUIPart): boolean {
	return part.state === "output-error" || part.state === "output-denied";
}

export function ToolRun({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
	const name = getToolName(part);
	const view = VIEWS[name] ?? genericView;
	let face: Face;
	let open = false;
	let stateLabel: string | null = null;
	switch (part.state) {
		case "output-available":
			face = view.done(part.input, part.output) ?? genericView.done(part.input, part.output)!;
			break;
		case "output-error": {
			const text = part.errorText ?? "tool failed";
			face = {
				summary: joinSummary(view.inputHint(part.input), `failed — ${firstLine(text, 96)}`),
				detail: (
					<div className="tool-body">
						<ErrBox text={text} />
					</div>
				),
				failed: true,
			};
			open = true;
			break;
		}
		case "output-denied":
			face = {
				summary: joinSummary(view.inputHint(part.input), "refused"),
				detail: (
					<div className="tool-body">
						<span className="tool-meta">the call was refused</span>
					</div>
				),
				failed: true,
			};
			open = true;
			break;
		default: {
			// input-streaming / input-available / approval-requested and any
			// future state: running rows get the skeleton, waiting rows the
			// input dump — never a blank.
			const running = RUNNING.has(part.state);
			stateLabel = running ? "running" : WAITING.has(part.state) ? "waiting" : part.state;
			open = running;
			face = {
				summary: view.inputHint(part.input) ?? "",
				detail: running ? (
					<Skeleton />
				) : (
					<div className="tool-body">
						<Clip text={shortJson(part.input)} />
					</div>
				),
			};
		}
	}
	return (
		<li>
			<details className="tool-run" open={open}>
				<summary>
					<span className="tool-ic">{view.icon}</span>
					<span className="tool-name">{name}</span>
					{face.summary !== "" && (
						<span className={face.failed === true ? "tool-sum err" : "tool-sum"}>
							{face.summary}
						</span>
					)}
					{stateLabel !== null && (
						<span className={`tool-state ${stateLabel}`}>{stateLabel}</span>
					)}
				</summary>
				{face.detail}
			</details>
		</li>
	);
}

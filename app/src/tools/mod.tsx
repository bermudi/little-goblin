// Tool-part dispatch — one expandable row per call inside the Worked
// fold. The row maps part.state to a face: streaming states get a
// skeleton body, output-available goes to the tool's bespoke view
// (schema failure → the generic renderer), output-error gets the error
// renderer. Unknown tool names always land on the generic view — a
// transcript can never be blanked by a tool it doesn't know.

import type { ReactNode } from "react";
import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { Clip, ErrBox, Skeleton, type Face, type ToolView } from "./bits.tsx";
import { firstLine, joinSummary, shortJson } from "./parse.ts";
import { artifactView } from "./artifact.tsx";
import { bashView } from "./bash.tsx";
import { editView } from "./edit.tsx";
import { fetchView } from "./fetch.tsx";
import { genericView } from "./generic.tsx";
import { readView } from "./read.tsx";
import { scriptView } from "./script.tsx";
import { searchView } from "./search.tsx";
import { writeView } from "./write.tsx";
import {
  bashInputSchema, readInputSchema, editInputSchema, writeInputSchema,
  searchInputSchema, fetchInputSchema,
} from "./schemas.ts";
import { commandProgramName } from "./commandProgramName.ts";

export function liveAction(
  part?: ToolUIPart | DynamicToolUIPart,
): { icon: ReactNode; label: string } {
  if (part === undefined) return { icon: null, label: "Thinking" };
  const name = getToolName(part);
  const icon = (VIEWS[name] ?? genericView).icon;
  if (part.state === "approval-requested")
    return { icon, label: `Waiting for approval: ${name}` };
  const failed = part.state === "output-error";
  const denied = part.state === "output-denied";
  const done = part.state === "output-available";
  if (name !== "bash" && (failed || denied))
    return { icon, label: `${failed ? "Failed" : "Refused"}: ${name}` };
  let label: string;
  switch (name) {
    case "bash": {
      const input = bashInputSchema.safeParse(part.input);
      const typed = input.success ? input.data.command : "";
      const command = part.state === "input-streaming" ? typed.replace(/\S*$/, "") : typed;
      const program = commandProgramName(command) ?? "command";
      let verb = done ? "Ran" : "Running";
      if (failed) verb = "Failed";
      if (denied) verb = "Refused";
      label = `${verb} ${program}`;
      break;
    }
    case "read_file":
    case "edit_file":
    case "write_file": {
      const fileSpecs = {
        read_file: { schema: readInputSchema, verbs: ["Reading", "Read"] },
        edit_file: { schema: editInputSchema, verbs: ["Editing", "Edited"] },
        write_file: { schema: writeInputSchema, verbs: ["Writing", "Wrote"] },
      };
      const spec = fileSpecs[name];
      const input = spec.schema.safeParse(part.input);
      const file = input.success
        ? input.data.path.split("/").filter(Boolean).at(-1) ?? "a file"
        : "a file";
      label = `${spec.verbs[done ? 1 : 0]} ${file}`;
      break;
    }
    case "search": {
      const input = searchInputSchema.safeParse(part.input);
      const query = input.success && input.data.query ? ` «${input.data.query}»` : "";
      label = `${done ? "Searched" : "Searching"}${query}`;
      break;
    }
    case "fetch": {
      const input = fetchInputSchema.safeParse(part.input);
      const host = input.success && URL.canParse(input.data.url)
        ? new URL(input.data.url).hostname || "a page"
        : "a page";
      label = `${done ? "Fetched" : "Fetching"} ${host}`;
      break;
    }
    case "script":
      label = `${done ? "Ran" : "Running"} a script`;
      break;
    case "artifact":
      label = `${done ? "Published" : "Publishing"} an artifact`;
      break;
    default:
      label = `${done ? "Used" : "Using"} ${name}`;
  }
  return { icon, label };
}

const VIEWS: Record<string, ToolView> = {
  search: searchView,
  fetch: fetchView,
  bash: bashView,
  read_file: readView,
  edit_file: editView,
  write_file: writeView,
  script: scriptView,
  artifact: artifactView,
};

// input-available means the args finished streaming and the call is
// executing; approval-responded is pending execution the same way.
const RUNNING = new Set([
  "input-streaming",
  "input-available",
  "approval-responded",
]);
const WAITING = new Set(["approval-requested"]);

export function partRunning(part: ToolUIPart | DynamicToolUIPart): boolean {
  return RUNNING.has(part.state);
}

export function partFailed(part: ToolUIPart | DynamicToolUIPart): boolean {
  return part.state === "output-error" || part.state === "output-denied";
}

interface PartFace {
  face: Face;
  stateLabel: string | null;
}

// The part → face mapping, shared by the row renderer and the Worked
// fold's collapsed summary (which needs the same one-liner without the
// detail body). `ended` marks a part on a message whose turn is over
// (the unlanded record) — a streaming state can never progress there,
// so it draws settled with "no result recorded" instead of the
// running shimmer.
function faceFor(
  part: ToolUIPart | DynamicToolUIPart,
  ended?: boolean,
): PartFace {
  const name = getToolName(part);
  const view = VIEWS[name] ?? genericView;
  switch (part.state) {
    case "output-available":
      return {
        face:
          view.done(part.input, part.output) ??
          genericView.done(part.input, part.output)!,
        stateLabel: null,
      };
    case "output-error": {
      const text = part.errorText ?? "tool failed";
      return {
        face: {
          summary: joinSummary(
            view.inputHint(part.input),
            `failed — ${firstLine(text, 96)}`,
          ),
          detail: (
            <div className="tool-body">
              <ErrBox text={text} />
            </div>
          ),
          failed: true,
        },
        stateLabel: null,
      };
    }
    case "output-denied":
      return {
        face: {
          summary: joinSummary(view.inputHint(part.input), "refused"),
          detail: (
            <div className="tool-body">
              <span className="tool-meta">the call was refused</span>
            </div>
          ),
          failed: true,
        },
        stateLabel: null,
      };
    default: {
      // input-streaming / input-available / approval-requested and any
      // future state: the expanded row shows the args received so far —
      // running keeps the shimmer under them, waiting stands alone —
      // never a blank. An ended message's stuck states stand alone too:
      // the turn is over, so the args are the record, not a live call.
      const running = !ended && RUNNING.has(part.state);
      const stranded = !running && ended && RUNNING.has(part.state);
      return {
        face: {
          summary: view.inputHint(part.input) ?? "",
          detail: running ? (
            <Skeleton>
              {part.input !== undefined && (
                <>
                  <span className="tool-meta">input</span>
                  <Clip text={shortJson(part.input)} />
                </>
              )}
            </Skeleton>
          ) : (
            <div className="tool-body">
              <Clip text={shortJson(part.input)} />
            </div>
          ),
        },
        stateLabel: running
          ? "running"
          : stranded
            ? "no result recorded"
            : WAITING.has(part.state)
              ? "waiting"
              : part.state,
      };
    }
  }
}

// The collapsed-Worked fragment for one part — "search «q» · 5
// results", "fetch github.com · 15.0k chars", "bash npm test · exit 1".
// The name glues to the input hint with a space; the face summary's own
// "·" separates the outcome.
export function partSummaryLine(part: ToolUIPart | DynamicToolUIPart): string {
  const summary = faceFor(part).face.summary;
  return summary === "" ? getToolName(part) : `${getToolName(part)} ${summary}`;
}

export function ToolRun({
  part,
  ended,
}: {
  part: ToolUIPart | DynamicToolUIPart;
  ended?: boolean;
}) {
  const name = getToolName(part);
  const view = VIEWS[name] ?? genericView;
  const { face, stateLabel } = faceFor(part, ended);
  return (
    <li>
      <details className="tool-run">
        <summary>
          <span className="tool-ic">{view.icon}</span>
          <span className="tool-name">{name}</span>
          {face.summary !== "" && (
            <span
              className={face.failed === true ? "tool-sum err" : "tool-sum"}
            >
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

// The collapsed Worked line for a run of calls, t3code-style: one call
// keeps its detailed one-liner; several group into a sentence by kind —
// "Read 3 files, ran 2 commands". Order follows first appearance.
const VERBS: Record<string, [string, string]> = {
  read_file: ["read", "file"],
  edit_file: ["edited", "file"],
  write_file: ["wrote", "file"],
  bash: ["ran", "command"],
  search: ["ran", "search"],
  fetch: ["fetched", "page"],
  script: ["ran", "script"],
  artifact: ["published", "artifact"],
};
function plural(n: number, noun: string): string {
  if (n === 1) return `1 ${noun}`;
  return `${n} ${noun.endsWith("h") ? `${noun}es` : `${noun}s`}`;
}
export function activitySummary(
  parts: readonly (ToolUIPart | DynamicToolUIPart)[],
): string {
  if (parts.length === 1) return partSummaryLine(parts[0]!);
  const counts = new Map<string, number>();
  for (const p of parts) {
    const name = getToolName(p);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const phrases = [...counts].map(([name, n]) => {
    const verb = VERBS[name];
    return verb === undefined
      ? `called ${name}${n > 1 ? ` ×${n}` : ""}`
      : `${verb[0]} ${plural(n, verb[1])}`;
  });
  const s = phrases.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

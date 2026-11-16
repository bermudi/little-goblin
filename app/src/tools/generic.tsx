// The generic renderer — every tool without a bespoke view (speak, mail,
// delegate, memory_search, program, history_search, send_file,
// transcribe, future unknowns) lands here, and bespoke tools land here
// when their payload fails narrowing. It never throws: the summary is a
// best-effort scalar off well-known keys, the detail is capped JSON.

import { Wrench } from "lucide-react";
import { Clip, type ToolView } from "./bits.tsx";
import {
  clipHead,
  firstLine,
  inputSummary,
  joinSummary,
  outputSummary,
  shortJson,
} from "./parse.ts";

export const genericView: ToolView = {
  icon: <Wrench size={12} strokeWidth={1.75} />,
  inputHint(input) {
    return inputSummary(input);
  },
  done(input, output) {
    const err =
      typeof output === "object" && output !== null && "error" in output
        ? (output as { error: unknown }).error
        : null;
    const errText = typeof err === "string" ? err : null;
    return {
      summary: joinSummary(
        inputSummary(input),
        errText !== null
          ? `failed — ${firstLine(errText)}`
          : outputSummary(output),
      ),
      detail: (
        <div className="tool-body">
          {input !== undefined && (
            <>
              <span className="tool-meta">input</span>
              <Clip text={shortJson(input)} />
            </>
          )}
          {errText !== null ? (
            <Clip className="err" text={clipHead(errText, 4000)} />
          ) : (
            <>
              <span className="tool-meta">output</span>
              <Clip text={shortJson(output)} />
            </>
          )}
        </div>
      ),
      failed: errText !== null,
    };
  },
};

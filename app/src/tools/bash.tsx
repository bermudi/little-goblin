// bash — the command in mono with a copy button, an exit badge, and the
// output tail in a capped scrollable block.

import { SquareTerminal } from "lucide-react";
import { Clip, CopyBtn, ErrBox, type ToolView } from "./bits.tsx";
import { bashInputSchema, bashOutputSchema } from "./schemas.ts";
import {
  byteLen,
  clipTail,
  firstLine,
  fmtBytes,
  joinSummary,
} from "./parse.ts";

const TAIL_CHARS = 12_000;

export const bashView: ToolView = {
  icon: <SquareTerminal size={12} strokeWidth={1.75} />,
  inputHint(input) {
    const p = bashInputSchema.safeParse(input);
    return p.success ? firstLine(p.data.command) : null;
  },
  done(input, output) {
    const o = bashOutputSchema.safeParse(output);
    if (!o.success) return null;
    const i = bashInputSchema.safeParse(input);
    const cmd = i.success ? i.data.command : "";
    const hint = cmd === "" ? null : firstLine(cmd);
    if ("error" in o.data) {
      return {
        summary: joinSummary(hint, `failed — ${firstLine(o.data.error)}`),
        detail: (
          <div className="tool-body">
            <ErrBox text={o.data.error} />
          </div>
        ),
        failed: true,
      };
    }
    const verdict =
      o.data.timed_out === true
        ? "timed out"
        : o.data.exit_code === null
          ? "no exit"
          : `exit ${o.data.exit_code}`;
    const bad = o.data.timed_out === true || o.data.exit_code !== 0;
    const failedCalls = (o.data.calls ?? []).filter((call) => !call.ok).length;
    return {
      summary: joinSummary(
        hint,
        verdict,
        failedCalls > 0 ? `${failedCalls} call${failedCalls === 1 ? "" : "s"} failed` : null,
      ),
      detail: (
        <div className="tool-body">
          {cmd !== "" && (
            <div className="cmdbar">
              <code>{cmd}</code>
              <CopyBtn text={cmd} />
            </div>
          )}
          <div className="meta-row">
            <span className={bad ? "exit-badge bad" : "exit-badge"}>
              {verdict}
            </span>
            {o.data.truncated === true && (
              <span className="tool-meta">output truncated</span>
            )}
            {o.data.output !== "" && (
              <span className="tool-meta">
                {fmtBytes(byteLen(o.data.output))}
              </span>
            )}
          </div>
          {o.data.output !== "" && (
            <Clip text={clipTail(o.data.output, TAIL_CHARS)} />
          )}
          {o.data.calls !== undefined && o.data.calls.length > 0 && (
            <ul className="script-calls">
              {o.data.calls.map((call, index) => (
                <li key={index}>
                  <code>{call.tool}</code>
                  {call.ok ? "" : " (failed)"} — {firstLine(`${call.args} → ${call.result}`, 200)}
                </li>
              ))}
            </ul>
          )}
        </div>
      ),
    };
  },
};

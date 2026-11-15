// script — the collapsed row counts nested calls and hoisted
// presentations; the expanded body lists each call's one-line result,
// then the digest text. The cards themselves render beside the fold
// (ChatView hoists them) — here only the count names them.

import { Code } from "lucide-react";
import { Clip, type ToolView } from "./bits.tsx";
import { clipHead, firstLine, joinSummary } from "./parse.ts";
import { scriptInputSchema, scriptOutputSchema } from "./schemas.ts";

export const scriptView: ToolView = {
  icon: <Code size={12} strokeWidth={1.75} />,
  inputHint(input) {
    const p = scriptInputSchema.safeParse(input);
    if (!p.success) return null;
    return firstLine(p.data.code, 80);
  },
  done(input, output) {
    const o = scriptOutputSchema.safeParse(output);
    if (!o.success) return null;
    const { text, calls, error, presentations } = o.data;
    const cards = presentations ?? [];
    const summary = joinSummary(
      `${calls.length} call${calls.length === 1 ? "" : "s"}`,
      cards.length > 0
        ? `${cards.length} artifact${cards.length === 1 ? "" : "s"}`
        : null,
      error !== undefined ? `failed — ${error}` : null,
    );
    return {
      summary,
      failed: error !== undefined,
      detail: (
        <div className="tool-body">
          {calls.length > 0 && (
            <ul className="script-calls">
              {calls.map((c, i) => (
                <li key={i}>
                  <code>{c.tool}</code>
                  {c.ok ? "" : " (failed)"} — {firstLine(c.result, 160)}
                </li>
              ))}
            </ul>
          )}
          {text !== "" && <Clip text={clipHead(text, 4000)} />}
        </div>
      ),
    };
  },
};

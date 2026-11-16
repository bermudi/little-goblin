// write_file — path chip, the +adds count, byte size, and a capped
// preview of the written content. A whole-file write has no removed
// lines on the wire, so only the add chip shows.

import { FilePlus } from "lucide-react";
import { Clip, DiffStat, ErrBox, PathChip, type ToolView } from "./bits.tsx";
import { writeInputSchema, writeOutputSchema } from "./schemas.ts";
import {
  clipHead,
  countLines,
  firstLine,
  fmtBytes,
  joinSummary,
} from "./parse.ts";

export const writeView: ToolView = {
  icon: <FilePlus size={12} strokeWidth={1.75} />,
  inputHint(input) {
    const p = writeInputSchema.safeParse(input);
    return p.success ? p.data.path : null;
  },
  done(input, output) {
    const o = writeOutputSchema.safeParse(output);
    if (!o.success) return null;
    const i = writeInputSchema.safeParse(input);
    if (!i.success) return null;
    const { path, content } = i.data;
    if ("error" in o.data) {
      return {
        summary: joinSummary(path, `failed — ${firstLine(o.data.error)}`),
        detail: (
          <div className="tool-body">
            <ErrBox text={o.data.error} />
          </div>
        ),
        failed: true,
      };
    }
    const adds = countLines(content);
    return {
      summary: joinSummary(path, `+${adds}`, fmtBytes(o.data.bytes)),
      detail: (
        <div className="tool-body">
          <div className="meta-row">
            <PathChip path={path} />
            <DiffStat adds={adds} dels={0} />
            <span className="tool-meta">{fmtBytes(o.data.bytes)}</span>
          </div>
          {content !== "" && <Clip text={clipHead(content, 3000)} />}
        </div>
      ),
    };
  },
};

// read_file — path chip, line/byte counts, and a capped preview of the
// numbered content the model received.

import { Clip, ErrBox, FileGlyph, PathChip, type ToolView } from "./bits.tsx";
import { readInputSchema, readOutputSchema } from "./schemas.ts";
import { byteLen, clipHead, firstLine, fmtBytes, joinSummary } from "./parse.ts";

export const readView: ToolView = {
	icon: <FileGlyph />,
	inputHint(input) {
		const p = readInputSchema.safeParse(input);
		return p.success ? p.data.path : null;
	},
	done(input, output) {
		const o = readOutputSchema.safeParse(output);
		if (!o.success) return null;
		const i = readInputSchema.safeParse(input);
		const path = i.success ? i.data.path : null;
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
		const { content, lines, shown } = o.data;
		const span = shown === lines ? `${lines} lines` : `${shown} of ${lines} lines`;
		return {
			summary: joinSummary(path, span),
			detail: (
				<div className="tool-body">
					<div className="meta-row">
						<PathChip path={path ?? "(unknown path)"} />
						<span className="tool-meta">
							{span} · {fmtBytes(byteLen(content))}
						</span>
					</div>
					{content !== "" && <Clip text={clipHead(content, 4000)} />}
				</div>
			),
		};
	},
};

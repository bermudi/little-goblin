// write_file — path chip, the +adds count, byte size, and a capped
// preview of the written content. A whole-file write has no removed
// lines on the wire, so only the add chip shows.

import { Clip, DiffStat, ErrBox, Icon, PathChip, type ToolView } from "./bits.tsx";
import { writeInputSchema, writeOutputSchema } from "./schemas.ts";
import { clipHead, countLines, firstLine, fmtBytes, joinSummary } from "./parse.ts";

export const writeView: ToolView = {
	icon: (
		<Icon>
			<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
			<polyline points="14 2 14 8 20 8" />
			<line x1="12" y1="12" x2="12" y2="18" />
			<line x1="9" y1="15" x2="15" y2="15" />
		</Icon>
	),
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

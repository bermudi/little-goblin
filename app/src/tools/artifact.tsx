// artifact — the fold row names what was published; the card below the
// fold is the openable thing (ChatView hoists it), so the detail shows
// provenance only: the source chip, target and stored meta.

import { ErrBox, FileGlyph, PathChip, type ToolView } from "./bits.tsx";
import { artifactInputSchema, artifactOutputSchema } from "./schemas.ts";
import { firstLine, fmtBytes, joinSummary } from "./parse.ts";

export const artifactView: ToolView = {
	icon: <FileGlyph />,
	inputHint(input) {
		const p = artifactInputSchema.safeParse(input);
		return p.success ? p.data.source.path : null;
	},
	done(input, output) {
		const o = artifactOutputSchema.safeParse(output);
		if (!o.success) return null;
		const i = artifactInputSchema.safeParse(input);
		const from = i.success ? `${i.data.source.target}:${i.data.source.path}` : null;
		if ("error" in o.data) {
			return {
				summary: joinSummary(from, `failed — ${firstLine(o.data.error)}`),
				detail: (
					<div className="tool-body">
						<ErrBox text={o.data.error} />
					</div>
				),
				failed: true,
			};
		}
		const a = o.data.artifact;
		return {
			summary: joinSummary(a.name, fmtBytes(a.size)),
			detail: (
				<div className="tool-body">
					<div className="meta-row">
						{a.source.target === "workspace" && <PathChip path={a.source.path} />}
						<span className="tool-meta">
							{a.source.target}
							{a.source.target === "workspace" ? "" : ` ${a.source.path}`} · {a.mediaType} ·{" "}
							{fmtBytes(a.size)}
						</span>
					</div>
				</div>
			),
		};
	},
};

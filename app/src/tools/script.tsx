// script — the collapsed row counts nested calls and hoisted
// presentations; the expanded body lists each call's one-line result,
// then the digest text. The cards themselves render beside the fold
// (ChatView hoists them) — here only the count names them.

import { Clip, Icon, type ToolView } from "./bits.tsx";
import { clipHead, firstLine, joinSummary } from "./parse.ts";
import { scriptInputSchema, scriptOutputSchema } from "./schemas.ts";

function ScriptGlyph() {
	return (
		<Icon>
			<polyline points="4 17 10 11 4 5" />
			<line x1="12" y1="19" x2="20" y2="19" />
		</Icon>
	);
}

export const scriptView: ToolView = {
	icon: <ScriptGlyph />,
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
			cards.length > 0 ? `${cards.length} artifact${cards.length === 1 ? "" : "s"}` : null,
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

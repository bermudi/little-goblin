// edit_file — path chip, +adds/−removes chips on the diff hues, and the
// old/new text as two tinted clips. The wire carries no diff, so the
// counts are computed from the input strings (×replaced on replace_all).

import { Clip, DiffStat, ErrBox, Icon, PathChip, type ToolView } from "./bits.tsx";
import { editInputSchema, editOutputSchema } from "./schemas.ts";
import { clipHead, countLines, firstLine, joinSummary } from "./parse.ts";

const DIFF_CHARS = 3000;

function diffClip(text: string, mark: string, cls: string) {
	const shown = clipHead(text, DIFF_CHARS);
	return (
		<Clip
			className={cls}
			text={shown
				.split("\n")
				.map((l) => `${mark} ${l}`)
				.join("\n")}
		/>
	);
}

export const editView: ToolView = {
	icon: (
		<Icon>
			<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
		</Icon>
	),
	inputHint(input) {
		const p = editInputSchema.safeParse(input);
		return p.success ? p.data.path : null;
	},
	done(input, output) {
		const o = editOutputSchema.safeParse(output);
		if (!o.success) return null;
		const i = editInputSchema.safeParse(input);
		if (!i.success) return null;
		const { path, old_string, new_string, replace_all } = i.data;
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
		const n = replace_all === true ? Math.max(1, o.data.replaced) : 1;
		const adds = countLines(new_string) * n;
		const dels = countLines(old_string) * n;
		return {
			summary: joinSummary(path, `+${adds} −${dels}`, n > 1 ? `×${n}` : null),
			detail: (
				<div className="tool-body">
					<div className="meta-row">
						<PathChip path={path} />
						<DiffStat adds={adds} dels={dels} />
					</div>
					{old_string !== "" && diffClip(old_string, "−", "diff-del")}
					{new_string !== "" && diffClip(new_string, "+", "diff-add")}
				</div>
			),
		};
	},
};

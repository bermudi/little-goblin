// fetch — the URL, its outcome, and a capped preview of what the model
// was handed. The wire carries no HTTP status (the outcome is a shaped
// string, a structured refusal, or a PDF ref), so the summary is host +
// size, not "200".

import { Clip, ErrBox, Icon, PathChip, type ToolView } from "./bits.tsx";
import { clipHead, firstLine, fmtBytes, fmtChars, hostOf, joinSummary, parseFetchText } from "./parse.ts";
import { fetchInputSchema, fetchOutputSchema } from "./schemas.ts";

export const fetchView: ToolView = {
	icon: (
		<Icon>
			<circle cx="12" cy="12" r="9" />
			<path d="M3 12h18" />
			<path d="M12 3c2.5 2.5 4 5.5 4 9s-1.5 6.5-4 9c-2.5-2.5-4-5.5-4-9s1.5-6.5 4-9z" />
		</Icon>
	),
	inputHint(input) {
		const p = fetchInputSchema.safeParse(input);
		return p.success ? hostOf(p.data.url) : null;
	},
	done(input, output) {
		const o = fetchOutputSchema.safeParse(output);
		if (!o.success) return null;
		const i = fetchInputSchema.safeParse(input);
		const url = i.success ? i.data.url : null;
		if (typeof o.data === "string") {
			const f = parseFetchText(o.data);
			const target = f.source ?? url;
			const meta = [
				f.title,
				fmtChars(f.chars),
				f.truncated ? "truncated — full text on disk" : null,
			]
				.filter((s): s is string => s !== null && s !== "")
				.join(" · ");
			return {
				summary: joinSummary(hostOf(target), fmtChars(f.chars)),
				detail: (
					<div className="tool-body">
						{target !== null && (
							<a href={target} target="_blank" rel="noreferrer" className="fetch-src">
								{target}
							</a>
						)}
						{meta !== "" && <span className="tool-meta">{meta}</span>}
						<Clip text={clipHead(f.body, 3000)} />
					</div>
				),
			};
		}
		if ("pdf" in o.data) {
			const pdf = o.data.pdf;
			return {
				summary: joinSummary(hostOf(pdf.url), `pdf ${fmtBytes(pdf.size)}`),
				detail: (
					<div className="tool-body">
						<a href={pdf.url} target="_blank" rel="noreferrer" className="fetch-src">
							{pdf.url}
						</a>
						<div className="meta-row">
							<PathChip path={pdf.path} />
							<span className="tool-meta">{fmtBytes(pdf.size)}</span>
						</div>
					</div>
				),
			};
		}
		return {
			summary: joinSummary(hostOf(url), `failed — ${o.data.kind ?? firstLine(o.data.error)}`),
			detail: (
				<div className="tool-body">
					<ErrBox text={o.data.error} />
				</div>
			),
			failed: true,
		};
	},
};

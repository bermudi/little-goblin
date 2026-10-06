// search — result rows: violet-linked title, URL, snippet.

import { Clip, ErrBox, Icon, type Face, type ToolView } from "./bits.tsx";
import { clipHead, firstLine, joinSummary, parseSearchOutput } from "./parse.ts";
import { searchInputSchema, searchOutputSchema } from "./schemas.ts";

export const searchView: ToolView = {
	icon: (
		<Icon>
			<circle cx="11" cy="11" r="7" />
			<line x1="21" y1="21" x2="16.5" y2="16.5" />
		</Icon>
	),
	inputHint(input) {
		const p = searchInputSchema.safeParse(input);
		return p.success ? `“${p.data.query}”` : null;
	},
	done(input, output) {
		const o = searchOutputSchema.safeParse(output);
		if (!o.success) return null;
		const p = searchInputSchema.safeParse(input);
		const q = p.success ? `“${p.data.query}”` : null;
		if (typeof o.data !== "string") {
			return {
				summary: joinSummary(q, `failed — ${firstLine(o.data.error)}`),
				detail: <div className="tool-body"><ErrBox text={o.data.error} /></div>,
				failed: true,
			};
		}
		const parsed = parseSearchOutput(o.data);
		// A string that isn't the fenced results list is still real output —
		// show it rather than falling through to a JSON dump.
		if (parsed === null) {
			return {
				summary: joinSummary(q, "done"),
				detail: (
					<div className="tool-body">
						<Clip text={clipHead(o.data, 4000)} />
					</div>
				),
			};
		}
		const n = parsed.hits.length;
		const face: Face = {
			summary: joinSummary(q, `${n} result${n === 1 ? "" : "s"}`),
			detail: (
				<div className="tool-body">
					{n > 0 && (
						<ul className="hits">
							{parsed.hits.map((h, i) => (
								<li key={i}>
									{h.url === "" ? (
										<span className="hit-title">{h.title}</span>
									) : (
										<a className="hit-title" href={h.url} target="_blank" rel="noreferrer">
											{h.title === "" ? h.url : h.title}
										</a>
									)}
									{h.url !== "" && h.title !== "" && <span className="hit-url">{h.url}</span>}
									{h.snippet !== "" && <span className="hit-snip">{h.snippet}</span>}
								</li>
							))}
						</ul>
					)}
					{n === 0 && <span className="tool-meta">No results.</span>}
					{parsed.note !== null && <span className="tool-meta">{parsed.note}</span>}
				</div>
			),
		};
		return face;
	},
};

// bash — the command in mono with a copy button, an exit badge, and the
// output tail in a capped scrollable block.

import { Clip, CopyBtn, ErrBox, Icon, type ToolView } from "./bits.tsx";
import { bashInputSchema, bashOutputSchema } from "./schemas.ts";
import { byteLen, clipTail, firstLine, fmtBytes, joinSummary } from "./parse.ts";

const TAIL_CHARS = 12_000;

export const bashView: ToolView = {
	icon: (
		<Icon>
			<polyline points="4 7 9 11 4 15" />
			<line x1="11" y1="17" x2="20" y2="17" />
		</Icon>
	),
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
		return {
			summary: joinSummary(hint, verdict),
			detail: (
				<div className="tool-body">
					{cmd !== "" && (
						<div className="cmdbar">
							<code>{cmd}</code>
							<CopyBtn text={cmd} />
						</div>
					)}
					<div className="meta-row">
						<span className={bad ? "exit-badge bad" : "exit-badge"}>{verdict}</span>
						{o.data.truncated === true && <span className="tool-meta">output truncated</span>}
						{o.data.output !== "" && (
							<span className="tool-meta">{fmtBytes(byteLen(o.data.output))}</span>
						)}
					</div>
					{o.data.output !== "" && <Clip text={clipTail(o.data.output, TAIL_CHARS)} />}
				</div>
			),
		};
	},
};

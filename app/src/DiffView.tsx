// Renders hunks from src/line-diff.ts. Lines wrap (a diff the operator
// must scroll sideways to read is a diff they skip).
import type { DiffLine } from "../../src/http/operator-wire.ts";

const MARK = { add: "+", del: "-", ctx: " " } as const;

export function DiffView({ lines }: { lines: DiffLine[] }) {
	return (
		<div className="diff">
			{lines.map((line, i) =>
				line.op === "gap" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: hunks are static, never reordered
					<div key={i} className="diff-line gap">
						{line.skipped} unchanged {line.skipped === 1 ? "line" : "lines"}
					</div>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: hunks are static, never reordered
					<div key={i} className={`diff-line ${line.op}`}>
						<span className="diff-mark" aria-hidden="true">
							{MARK[line.op]}
						</span>
						{line.text}
					</div>
				),
			)}
		</div>
	);
}

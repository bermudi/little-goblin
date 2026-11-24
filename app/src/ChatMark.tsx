import type { Mark } from "./homeList.ts";

const LABELS = {
	needs: "Needs you",
	new: "New reply",
	working: "Working",
	done: "Done",
} as const;

export function ChatMark({ mark }: { mark: Mark | "done" }) {
	return (
		<>
			<span className={`mark mark-${mark}`} aria-hidden="true">
				{mark === "needs" ? "!" : null}
			</span>
			<span className="sr-only">{LABELS[mark]}</span>
		</>
	);
}

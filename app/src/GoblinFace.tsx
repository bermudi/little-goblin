import { GoblinAvatar } from "./GoblinAvatar.tsx";
import { BotAvatar } from "./BotAvatar.tsx";

export function buildGoblinFaceLabel(
	working: number,
	needs: number | null,
	failed: boolean,
	name = "Little Goblin",
): string {
	const parts = [name];
	if (working > 0) parts.push(`${working} ${working === 1 ? "job" : "jobs"}`);
	else if (needs === null || needs === 0) parts.push("idle");

	if (needs !== null && needs > 0) {
		parts.push(needs === 1 ? "1 needs you" : `${needs} need you`);
	}
	if (failed) parts.push("couldn't load what needs you");
	return parts.join(", ");
}

export function GoblinFace({
	working,
	needs,
	failed,
	onClick,
	expanded,
	botName,
}: {
	working: number;
	needs: number | null;
	failed: boolean;
	onClick: () => void;
	expanded?: boolean;
	botName?: string | undefined;
}) {
	const badge = badgeText(needs, failed);
	return (
		<button
			type="button"
			className="goblin-panel-toggle"
			aria-label={buildGoblinFaceLabel(working, needs, failed, botName)}
			aria-expanded={expanded}
			onClick={onClick}
		>
			{botName === undefined ? <GoblinAvatar size="sm" working={working > 0} /> : <BotAvatar name={botName} />}
			{badge !== null && <span className="goblin-face-badge">{badge}</span>}
		</button>
	);
}

function badgeText(needs: number | null, failed: boolean): string | null {
	if (failed) return "?";
	if (needs === null || needs === 0) return null;
	return needs > 99 ? "99+" : String(needs);
}

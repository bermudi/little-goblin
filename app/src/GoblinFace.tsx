import { GoblinAvatar } from "./GoblinAvatar.tsx";

export function buildGoblinFaceLabel(
	working: number,
	needs: number | null,
	failed: boolean,
): string {
	const parts = ["Goblin"];
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
}: {
	working: number;
	needs: number | null;
	failed: boolean;
	onClick: () => void;
	expanded?: boolean;
}) {
	const badge = badgeText(needs, failed);
	return (
		<button
			type="button"
			className="goblin-panel-toggle"
			aria-label={buildGoblinFaceLabel(working, needs, failed)}
			aria-expanded={expanded}
			onClick={onClick}
		>
			<GoblinAvatar size="sm" working={working > 0} />
			{badge !== null && <span className="goblin-face-badge">{badge}</span>}
		</button>
	);
}

function badgeText(needs: number | null, failed: boolean): string | null {
	if (failed) return "?";
	if (needs === null || needs === 0) return null;
	return needs > 99 ? "99+" : String(needs);
}

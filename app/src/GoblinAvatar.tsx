export function GoblinAvatar({
	size,
	working,
	portrait = false,
}: {
	size: "sm" | "md" | "lg";
	working: boolean;
	portrait?: boolean;
}) {
	return (
		<span
			className={`goblin-avatar goblin-avatar-${size}`}
			data-portrait={portrait ? "" : undefined}
			{...(working ? { "data-working": "" } : {})}
		>
			<img src={portrait ? "/app/goblin-portrait.webp" : "/app/goblin-avatar.webp"} alt="" draggable={false} />
		</span>
	);
}

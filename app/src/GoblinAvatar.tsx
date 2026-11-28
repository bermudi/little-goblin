export function GoblinAvatar({ size, working }: { size: "sm" | "md" | "lg"; working: boolean }) {
	return (
		<span className={`goblin-avatar goblin-avatar-${size}`} {...(working ? { "data-working": "" } : {})}>
			<img src="/app/goblin-portrait.webp" alt="" draggable={false} />
		</span>
	);
}

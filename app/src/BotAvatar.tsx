export function BotAvatar({ name, large = false }: { name: string; large?: boolean }) {
	const initial = Array.from(name)[0]?.toUpperCase();
	return (
		<span className={large ? "bot-avatar bot-avatar-large" : "bot-avatar"} aria-hidden="true">
			{initial}
		</span>
	);
}

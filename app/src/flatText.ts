export function flatLine(text: string): string {
	return text
		.replace(/```+[ \t]*[^\s`\n]*/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
		.replace(/(\*|_)([^\s*_][^*_]*?[^\s*]|[^\s*_])\1/g, "$2")
		.replace(/^[ \t]*(?:#{1,6}|>|[-*+]|\d+\.)[ \t]+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function flatTitle(title: string | null): string | null {
	if (title === null) return null;
	return flatLine(title) || null;
}

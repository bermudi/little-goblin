import { log } from "../log.ts";

const MARKER = "[REDACTED:";
const patterns: readonly { label: string; pattern: RegExp; prefix?: boolean }[] = [
	{
		label: "private_key",
		pattern:
			/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g,
	},
	{
		label: "credential",
		pattern:
			/\b(?:sk-(?:ant-|proj-|admin-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|gsk_[A-Za-z0-9]{20,}|AIza[A-Za-z0-9_-]{35}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g,
	},
	{
		label: "jwt",
		pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	},
	{
		label: "authorization",
		pattern: /(\b(?:Bearer|Basic)[ \t]+)[A-Za-z0-9._~+/=-]{8,}/gi,
		prefix: true,
	},
	{
		label: "url_credentials",
		pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi,
		prefix: true,
	},
	{
		label: "secret_assignment",
		pattern:
			/((?<![\w-])["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|PASSWORD|SECRET))["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi,
		prefix: true,
	},
];

export function screenMemoryText(text: string, boundary: string): string {
	const hits: Record<string, number> = {};
	let result = text;
	for (const { label, pattern, prefix } of patterns) {
		result = result.replace(pattern, (match: string, head: string) => {
			const value = prefix ? match.slice(head.length) : match;
			if (value.includes(MARKER) && /^["']?\[REDACTED:[a-z_]+\]["']?@?$/.test(value)) return match;
			hits[label] = (hits[label] ?? 0) + 1;
			return `${prefix ? head : ""}[REDACTED:${label}]${label === "url_credentials" ? "@" : ""}`;
		});
	}
	if (Object.keys(hits).length > 0)
		log.info("memory credentials screened", { boundary, patterns: hits });
	return result;
}

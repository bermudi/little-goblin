// Whether an untrusted string earns an <a>: a literal, case-sensitive
// http(s) prefix that still parses — text, never a dead href, otherwise.
export function isHttpUrl(url: string): boolean {
	if (!/^https?:\/\//.test(url)) return false;
	try {
		const { protocol } = new URL(url);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

// Webhook credential helpers shared by the program tool (rotation on
// an existing hook) and the approval adapter (grant-time mint). The
// raw token exists only inside these call paths — stores, stamps and
// logs see its sha256 hash or nothing at all.

export function newHookToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

export function hookTokenHash(token: string): string {
	return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export function hookUrl(publicUrl: string, token: string): string {
	return `${publicUrl.replace(/\/+$/, "")}/hook/${token}`;
}

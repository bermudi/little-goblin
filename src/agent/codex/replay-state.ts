// The one owner of the codex replay-state shape: provider ciphertext
// lives under a `codex` key as reasoningEncryptedContent (part
// providerMetadata, tool callProviderMetadata/resultProviderMetadata,
// prompt providerOptions — same shape on both sides of the SDK
// boundary). Anything that must measure or bound serialized bulk without
// counting opaque state strips through here so the exclusion stays one
// rule everywhere.

// Deep, non-mutating walk: every object under a `codex` key loses its
// reasoningEncryptedContent member; all other values pass through
// structurally identical. Safe on the parsed-JSON shapes the callers
// hold (messages, parts, journaled checkpoints).
export function withoutReasoningCipher<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map((v) => withoutReasoningCipher(v)) as T;
	}
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
			if (key === "codex" && typeof v === "object" && v !== null) {
				const codex = { ...(v as Record<string, unknown>) };
				delete codex.reasoningEncryptedContent;
				for (const ck of Object.keys(codex)) {
					codex[ck] = withoutReasoningCipher(codex[ck]);
				}
				out[key] = codex;
				continue;
			}
			out[key] = withoutReasoningCipher(v);
		}
		return out as T;
	}
	return value;
}

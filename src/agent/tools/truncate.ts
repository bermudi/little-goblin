export interface TruncateTailResult {
	content: string;
	truncated: boolean;
	droppedBytes: number;
}

/**
 * Take the last maxBytes of a string, at a UTF-8 character boundary.
 */
function tailBytes(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf-8");
	if (buf.length <= maxBytes) return text;
	let start = buf.length - maxBytes;
	while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
		start++;
	}
	return buf.subarray(start).toString("utf-8");
}

/**
 * Tail-truncate text at complete lines within a byte budget. Never emits a
 * partial line — except when the very last line alone exceeds the budget,
 * where its last ≤maxBytes bytes (UTF-8 boundary-safe) are kept. The
 * skip-notice prepended on truncation is not counted against the budget.
 */
export function truncateTail(text: string, maxBytes: number): TruncateTailResult {
	const totalBytes = Buffer.byteLength(text, "utf-8");
	if (totalBytes <= maxBytes) {
		return { content: text, truncated: false, droppedBytes: 0 };
	}

	const lines = text.split("\n");
	const kept: string[] = [];
	let keptBytes = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]!;
		const lineBytes = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0);
		if (keptBytes + lineBytes > maxBytes) {
			if (kept.length === 0) {
				// Edge case: the last line alone exceeds the budget — keep
				// its final bytes rather than nothing.
				const partial = tailBytes(line, maxBytes);
				keptBytes = Buffer.byteLength(partial, "utf-8");
				kept.unshift(partial);
			}
			break;
		}
		kept.unshift(line);
		keptBytes += lineBytes;
	}

	const body = kept.join("\n");
	const droppedBytes = totalBytes - keptBytes;
	return {
		content: `[… ${droppedBytes} bytes of earlier output skipped — showing the tail]\n${body}`,
		truncated: true,
		droppedBytes,
	};
}

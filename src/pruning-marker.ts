// Byte format shared by the writer (cache-pruning.ts) and the fork's
// projection copy (conversation.ts), which re-points it at the fork's
// own id. A leaf so both sides import it without a module cycle.

// Fixed key order — history_search's context action parses it back.
export function pruningRecoveryAddress(
	conversation: string,
	seq: number,
	toolCallId: string,
): string {
	return JSON.stringify({
		action: "context",
		conversation,
		seq,
		window: 0,
		toolCallId,
		offset: 0,
	});
}

// The fork copies projections verbatim, but the embedded address still
// names the source id — recovery would read another conversation's
// events and die with the source. The rewrite is the exact serialized
// object: a false hit needs the original output to quote this call's
// own address verbatim.
export function retargetPruningMarker(
	marker: string,
	seq: number,
	toolCallId: string,
	fromId: string,
	toId: string,
): string {
	return marker.replaceAll(
		pruningRecoveryAddress(fromId, seq, toolCallId),
		pruningRecoveryAddress(toId, seq, toolCallId),
	);
}

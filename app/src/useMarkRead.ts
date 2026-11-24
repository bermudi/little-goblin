import { useEffect, useRef, useSyncExternalStore } from "react";
import { markConversationRead } from "./api.ts";
import { useLive, useLiveStore, useLiveStatus } from "./useLive.tsx";

function subscribeVisible(callback: () => void): () => void {
	document.addEventListener("visibilitychange", callback);
	return () => document.removeEventListener("visibilitychange", callback);
}

function useDocumentVisible(): boolean {
	return useSyncExternalStore(
		subscribeVisible,
		() => document.visibilityState === "visible",
		() => false,
	);
}

export function useMarkRead(token: string | null, onScreen: string | null): string | null {
	const list = useLive("conversations").data;
	const store = useLiveStore();
	const status = useLiveStatus();
	const visible = useDocumentVisible();
	const sent = useRef(new Set<string>());
	const conv = [...(list?.conversations ?? []), ...(list?.rolling.chain ?? [])].find(
		(entry) => entry.id === onScreen,
	);
	const id = conv?.id ?? null;
	const seq = conv === undefined || conv.busy ? null : conv.newReply;

	useEffect(() => {
		if (!visible || id === null || seq === null) return;
		const key = `${id}:${seq}`;
		if (sent.current.has(key)) return;
		sent.current.add(key);
		markConversationRead(token, id, seq).then(
			() => void store.refresh("conversations"),
			() => sent.current.delete(key),
		);
	}, [id, list, seq, status, store, token, visible]);

	return visible ? onScreen : null;
}

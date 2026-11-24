import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useSyncExternalStore,
} from "react";
import type { LiveData, LiveFeedStatus, LiveStore } from "./live.ts";

type Topic = keyof LiveData;

const LiveContext = createContext<LiveStore | null>(null);

export function LiveProvider(props: { store: LiveStore; children: ReactNode }) {
	return <LiveContext.Provider value={props.store}>{props.children}</LiveContext.Provider>;
}

export function useLiveStoreOrNull(): LiveStore | null {
	return useContext(LiveContext);
}

export function useLiveStore(): LiveStore {
	const store = useContext(LiveContext);
	if (store === null) throw new Error("useLive outside LiveProvider");
	return store;
}

export function useLive<K extends Topic>(
	topic: K,
): { data: LiveData[K] | null; error: Error | null; refresh: () => Promise<void> } {
	const store = useLiveStore();
	const snap = () => store.topic(topic);
	const state = useSyncExternalStore(store.subscribe, snap, snap);
	useEffect(() => store.retain(topic), [store, topic]);
	return {
		data: state.data,
		error: state.error,
		refresh: useCallback(() => store.refresh(topic), [store, topic]),
	};
}

export function useLiveStatus(): LiveFeedStatus {
	const store = useLiveStore();
	const snap = () => store.status();
	return useSyncExternalStore(store.subscribe, snap, snap);
}

export function useLiveVersion(topic: Topic): string | null {
	const store = useLiveStore();
	const snap = () => store.version(topic);
	return useSyncExternalStore(store.subscribe, snap, snap);
}

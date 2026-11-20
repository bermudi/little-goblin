import { useEffect, useRef, useState } from "react";
import type { AppSearchHit } from "../../src/http/app-wire.ts";
import { searchConversations } from "./api.ts";

export function useConversationSearch(token: string | null): {
	query: string;
	setQuery: (q: string) => void;
	hits: AppSearchHit[] | null;
	searchError: string | null;
} {
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<AppSearchHit[] | null>(null);
	const [searchError, setSearchError] = useState<string | null>(null);
	const searchSeq = useRef(0);

	// A failed search must surface as an error, never read as "no matches".
	// Debounced app-pool search. The sequence bumps on every invocation
	// including the clear, so a reply dispatched before the box emptied can
	// never reappear. A stale error
	// clears on empty and the next settled reply, never on a fresh query —
	// clearing there would flash "No matches.".
	useEffect(() => {
		const seq = ++searchSeq.current;
		const q = query.trim();
		if (q === "") {
			setHits(null);
			setSearchError(null);
			return;
		}
		const t = setTimeout(() => {
			void searchConversations(token, q).then(
				(r) => {
					if (seq !== searchSeq.current) return;
					setHits(r.hits);
					setSearchError(null);
				},
				(err: unknown) => {
					if (seq !== searchSeq.current) return;
					setHits([]);
					setSearchError(err instanceof Error ? err.message : "search failed");
				},
			);
		}, 250);
		return () => clearTimeout(t);
	}, [query, token]);

	return { query, setQuery, hits, searchError };
}

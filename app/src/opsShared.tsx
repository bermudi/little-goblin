// Bits shared across the operator views: error copy, time formatting,
// the KV row, and the reloadable load hook. Pure presentation — api.ts
// owns the server conversation.
import { useEffect, useState } from "react";
import { ApiError } from "./api.ts";

export function describe(err: unknown): string {
	return err instanceof ApiError ? err.message : "Couldn't reach goblin — check the tailnet.";
}

export function ts(iso: string | null): string {
	if (iso === null) return "—";
	const t = Date.parse(iso);
	return Number.isNaN(t)
		? iso
		: new Date(t).toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});
}

export function uptime(sec: number): string {
	if (sec < 60) return `${sec}s`;
	if (sec < 3600) return `${Math.floor(sec / 60)}m`;
	if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
	return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

export function bytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
	return (
		<div className="kv">
			<span className="kv-k">{k}</span>
			<span className={mono ? "kv-v mono" : "kv-v"}>{v}</span>
		</div>
	);
}

export function useLoad<T>(load: () => Promise<T>) {
	const [data, setData] = useState<T | null>(null);
	const [err, setErr] = useState<string | null>(null);
	const [nonce, setNonce] = useState(0);
	useEffect(() => {
		let live = true;
		load().then(
			(d) => {
				if (!live) return;
				setData(d);
				setErr(null);
			},
			(e) => live && setErr(describe(e)),
		);
		return () => {
			live = false;
		};
		// Runs once per mount plus on explicit reload() (post-mutation
		// refresh) — token changes still remount the view via App's page
		// switch.
	}, [nonce]);
	return { data, err, reload: () => setNonce((n) => n + 1) };
}

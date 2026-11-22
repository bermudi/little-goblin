import { useCallback, useEffect, useRef, useState } from "react";
import type { AppActivityResponse, AppAttentionItem } from "../../src/http/app-wire.ts";
import type { OperatorDelegationItem, OperatorProgramItem } from "../../src/http/operator-wire.ts";
import { getActivity, getAttention, listDelegations, listPrograms } from "./api.ts";

export function workingCount(
	activity: AppActivityResponse | null,
	delegations: OperatorDelegationItem[] | null,
): number {
	return (activity?.busy.length ?? 0) + (activity?.otherBusy ?? 0) +
		(delegations?.filter((item) => ["starting", "running", "needs_input"].includes(item.status)).length ?? 0);
}

export function useGoblinActivity(token: string | null, enabled: boolean) {
	const [attention, setAttention] = useState<AppAttentionItem[] | null>(null);
	const [attentionError, setAttentionError] = useState(false);
	const [delegations, setDelegations] = useState<OperatorDelegationItem[] | null>(null);
	const [programs, setPrograms] = useState<OperatorProgramItem[] | null>(null);
	const [activity, setActivity] = useState<AppActivityResponse | null>(null);
	const [loadError, setLoadError] = useState(false);
	const seq = useRef(0);
	const [refresh, setRefresh] = useState(0);
	const reload = useCallback(() => setRefresh((n) => n + 1), []);
	useEffect(() => {
		if (!enabled) return;
		let live = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const load = async () => {
			const current = ++seq.current;
			const results = await Promise.allSettled([
				getAttention(token),
				listDelegations(token),
				listPrograms(token),
				getActivity(token),
			]);
			if (!live || seq.current !== current) return;
			const [a, d, p, x] = results;
			if (a.status === "fulfilled") {
				setAttention(a.value.items);
				setAttentionError(false);
			} else {
				setAttentionError(true);
			}
			if (d.status === "fulfilled") setDelegations(d.value.delegations);
			if (p.status === "fulfilled") setPrograms(p.value.programs);
			if (x.status === "fulfilled") setActivity(x.value);
			setLoadError(d.status === "rejected" || p.status === "rejected" || x.status === "rejected");
			timer = setTimeout(() => {
				if (document.visibilityState === "visible") void load();
				else timer = undefined;
			}, 10_000);
		};
		const visible = () => {
			if (document.visibilityState === "visible") {
				if (timer !== undefined) clearTimeout(timer);
				void load();
			}
		};
		void load();
		document.addEventListener("visibilitychange", visible);
		return () => {
			live = false;
			seq.current += 1;
			if (timer !== undefined) clearTimeout(timer);
			document.removeEventListener("visibilitychange", visible);
		};
	}, [enabled, token, refresh]);
	return {
		attention,
		attentionError,
		delegations,
		programs,
		activity,
		loadError,
		working: workingCount(activity, delegations),
		reload,
	};
}

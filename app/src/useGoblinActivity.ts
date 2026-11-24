import { useCallback } from "react";
import type { AppActivityResponse, AppAttentionItem } from "../../src/http/app-wire.ts";
import type { OperatorDelegationItem, OperatorProgramItem } from "../../src/http/operator-wire.ts";
import { useLive, useLiveStore } from "./useLive.tsx";

export function workingCount(
	activity: AppActivityResponse | null,
	delegations: OperatorDelegationItem[] | null,
): number {
	return (activity?.busy.length ?? 0) + (activity?.otherBusy ?? 0) +
		(delegations?.filter((item) => ["starting", "running", "needs_input"].includes(item.status)).length ?? 0);
}

export function useGoblinActivity(): {
	attention: AppAttentionItem[] | null;
	attentionError: boolean;
	delegations: OperatorDelegationItem[] | null;
	programs: OperatorProgramItem[] | null;
	activity: AppActivityResponse | null;
	loadError: boolean;
	working: number;
	reload: () => void;
} {
	const store = useLiveStore();
	const attention = useLive("attention");
	const delegations = useLive("delegations");
	const programs = useLive("programs");
	const activity = useLive("activity");
	const delegationsList = delegations.data?.delegations ?? null;
	return {
		attention: attention.data?.items ?? null,
		attentionError: attention.error !== null,
		delegations: delegationsList,
		programs: programs.data?.programs ?? null,
		activity: activity.data,
		loadError:
			delegations.error !== null || programs.error !== null || activity.error !== null,
		working: workingCount(activity.data, delegationsList),
		reload: useCallback(
			() => void store.refresh("attention", "delegations", "programs", "activity"),
			[store],
		),
	};
}

import { expect, test } from "bun:test";
import type { AppActivityResponse } from "../../src/http/app-wire.ts";
import type { OperatorDelegationItem } from "../../src/http/operator-wire.ts";
import { workingCount } from "./useGoblinActivity.ts";

test("workingCount counts busy conversations and active delegations", () => {
	expect(workingCount(null, null)).toBe(0);
	const activity: AppActivityResponse = {
		busy: [
			{ id: "app/a", title: "A", parentId: null },
			{ id: "app/b", title: "B", parentId: null },
		],
		otherBusy: 1,
	};
	const make = (status: OperatorDelegationItem["status"]): OperatorDelegationItem =>
		({ status }) as OperatorDelegationItem;
	expect(workingCount(activity, [make("running"), make("needs_input"), make("done"), make("failed"), make("starting")])).toBe(6);
});

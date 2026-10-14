// The schema's size budget: the top-level block list is capped at 30
// and each container's leaf list at 10, so one container can't carry an
// unbounded payload into the tool part that replays to the model every
// turn. (ui.test.ts covers the repair and wire-schema concerns.)

import { describe, expect, test } from "bun:test";
import { uiBlockSchema, uiInputSchema } from "./ui-schema.ts";

const leaves = (n: number): { type: string; md: string }[] =>
	Array.from({ length: n }, (_, i) => ({ type: "text", md: `leaf ${i}` }));

describe("container leaf caps", () => {
	test("a tab with 10 leaves passes, 11 is rejected", () => {
		const tabs = (n: number) => ({
			type: "tabs",
			tabs: [{ label: "a", blocks: leaves(n) }, { label: "b", blocks: leaves(1) }],
		});
		expect(uiBlockSchema.safeParse(tabs(10)).success).toBe(true);
		expect(uiBlockSchema.safeParse(tabs(11)).success).toBe(false);
	});

	test("a column with 10 leaves passes, 11 is rejected", () => {
		const columns = (n: number) => ({
			type: "columns",
			columns: [{ blocks: leaves(n) }, { blocks: leaves(1) }],
		});
		expect(uiBlockSchema.safeParse(columns(10)).success).toBe(true);
		expect(uiBlockSchema.safeParse(columns(11)).success).toBe(false);
	});

	test("the cap holds through the full input schema", () => {
		const over = {
			blocks: [
				{
					type: "tabs",
					tabs: [{ label: "a", blocks: leaves(11) }, { label: "b", blocks: leaves(1) }],
				},
			],
		};
		expect(uiInputSchema.safeParse(over).success).toBe(false);
	});
});

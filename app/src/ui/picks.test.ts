import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { UiBlock } from "../../../src/agent/tools/ui-schema.ts";
import { choiceLabels, derivePick } from "./picks.ts";

const userText = (text: string): UIMessage => ({
	id: `u-${text}`,
	role: "user",
	parts: [{ type: "text", text }],
});

const surface: UiBlock[] = [
	{
		type: "table",
		columns: ["Ride", "km"],
		rows: [["Road loop", "42"], ["Gravel trail", "60"]],
	},
	{
		type: "choices",
		prompt: "Which ride?",
		options: [{ label: "Road loop" }, { label: "Gravel trail" }],
	},
	{
		type: "tabs",
		tabs: [
			{
				label: "fallback",
				blocks: [{ type: "choices", options: [{ label: "Stay home" }, { label: "Rain check" }] }],
			},
			{ label: "info", blocks: [{ type: "text", md: "x" }] },
		],
	},
];

describe("choiceLabels", () => {
	test("collects top-level and container choices labels", () => {
		expect(choiceLabels(surface)).toEqual(["Road loop", "Gravel trail", "Stay home", "Rain check"]);
	});

	test("a surface without choices yields none", () => {
		expect(choiceLabels([{ type: "text", md: "hi" }])).toEqual([]);
	});
});

describe("derivePick", () => {
	const labels = ["Road loop", "Gravel trail", "Stay home", "Rain check"];

	test("the latest matching [ui] message wins", () => {
		expect(derivePick([userText("[ui] Road loop"), userText("[ui] Gravel trail")], labels)).toBe(
			"Gravel trail",
		);
	});

	test("labels outside the surface and non-user messages never match", () => {
		const messages: UIMessage[] = [
			{ id: "a1", role: "assistant", parts: [{ type: "text", text: "[ui] Road loop" }] },
			userText("[ui] Unrelated"),
		];
		expect(derivePick(messages, labels)).toBeNull();
	});

	test("form submits and prose mentions do not match", () => {
		expect(
			derivePick([userText("[ui] Plan ride: distance=30"), userText("consider [ui] Road loop")], labels),
		).toBeNull();
	});

	test("an empty label set short-circuits", () => {
		expect(derivePick([userText("[ui] Road loop")], [])).toBeNull();
	});
});

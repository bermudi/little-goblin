import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { UiInput } from "../../../src/agent/tools/ui-schema.ts";
import { choiceLabels, derivePick } from "./picks.ts";

const userText = (text: string): UIMessage => ({
	id: `u-${text}`,
	role: "user",
	parts: [{ type: "text", text }],
});

const surface: UiInput = {
	root: "main",
	elements: {
		main: { type: "stack", children: ["tbl", "pick", "tabs"] },
		tbl: {
			type: "table",
			props: {
				columns: ["Ride", "km"],
				rows: [
					["Road loop", "42"],
					["Gravel trail", "60"],
				],
			},
		},
		pick: {
			type: "choices",
			props: {
				prompt: "Which ride?",
				options: [{ label: "Road loop" }, { label: "Gravel trail" }],
			},
		},
		tabs: { type: "tabs", children: ["t1", "t2"] },
		t1: {
			type: "tab",
			props: { label: "fallback" },
			children: ["nested-pick"],
		},
		"nested-pick": {
			type: "choices",
			props: { options: [{ label: "Stay home" }, { label: "Rain check" }] },
		},
		t2: { type: "tab", props: { label: "info" }, children: ["t2x"] },
		t2x: { type: "text", props: { md: "x" } },
	},
};

describe("choiceLabels", () => {
	test("collects choices labels at any depth", () => {
		expect(choiceLabels(surface)).toEqual(["Road loop", "Gravel trail", "Stay home", "Rain check"]);
	});

	test("a surface without choices yields none", () => {
		expect(
			choiceLabels({ root: "a", elements: { a: { type: "text", props: { md: "hi" } } } }),
		).toEqual([]);
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
			derivePick(
				[userText("[ui] Plan ride: distance=30"), userText("consider [ui] Road loop")],
				labels,
			),
		).toBeNull();
	});

	test("an empty label set short-circuits", () => {
		expect(derivePick([userText("[ui] Road loop")], [])).toBeNull();
	});
});

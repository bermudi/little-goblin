import { expect, test } from "bun:test";
import { applyProbeRules, CONTROL_URL } from "./bench-fetch-record.ts";

const QUOTES_URL = "https://quotes.toscrape.com/js/";

test("control accepts nonempty thin text with MIN_EXTRACT off", () => {
	const cell = applyProbeRules(
		{ outcome: "thin", note: "local: almost no text (156 chars)" },
		CONTROL_URL,
		156,
	);
	expect(cell).toEqual({
		outcome: "ok",
		chars: 156,
		note: "control — MIN_EXTRACT off (156ch)",
		jsExec: false,
	});
});

test("control keeps zero-text extraction thin", () => {
	expect(
		applyProbeRules(
			{ outcome: "thin", note: "local: almost no text (0 chars)" },
			CONTROL_URL,
			156,
		),
	).toEqual({
		outcome: "thin",
		chars: 0,
		note: "local: almost no text (0 chars)",
		jsExec: false,
	});
});

test("control detects JS when extraction exceeds its raw baseline", () => {
	expect(
		applyProbeRules({ outcome: "ok", chars: 958 }, CONTROL_URL, 156),
	).toEqual({ outcome: "ok", chars: 958, jsExec: true });
});

test("quotes probe keeps the thin rule and marks raw-shell-only text", () => {
	expect(
		applyProbeRules(
			{ outcome: "thin", note: "local: almost no text (100 chars)" },
			QUOTES_URL,
			100,
		),
	).toEqual({
		outcome: "thin",
		chars: 100,
		note: "local: almost no text (100 chars)",
		jsExec: false,
	});
});

test("quotes probe detects rendered JavaScript content", () => {
	expect(
		applyProbeRules({ outcome: "ok", chars: 1700 }, QUOTES_URL, 100),
	).toEqual({ outcome: "ok", chars: 1700, jsExec: true });
});

test("errors do not get a JS result; other URLs only gain thin counts", () => {
	const error = { outcome: "error" as const, note: "network failure" };
	expect(applyProbeRules(error, QUOTES_URL, 100)).toEqual(error);
	expect(
		applyProbeRules(
			{ outcome: "thin", note: "local: almost no text (72 chars)" },
			"https://www.reuters.com/",
			100,
		),
	).toEqual({
		outcome: "thin",
		chars: 72,
		note: "local: almost no text (72 chars)",
	});
});

test("probe rules return a new cell without mutating the input", () => {
	const input = {
		outcome: "thin" as const,
		note: "local: almost no text (156 chars)",
	};
	const original = { ...input };
	const result = applyProbeRules(input, CONTROL_URL, 156);
	expect(input).toEqual(original);
	expect(result).not.toBe(input);
});

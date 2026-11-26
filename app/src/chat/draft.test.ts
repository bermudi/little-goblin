import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import {
	chipKey,
	draftFromMessages,
	draftText,
	draftToParts,
	emptyDraft,
	isEmptyDraft,
	joinDrafts,
	normalizeDraft,
	parseChip,
	sameDraft,
	textDraft,
	unsentRemainder,
	uploadState,
	type Chip,
	type Draft,
	type FileChip,
} from "./draft.ts";

const imageRef = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	path: "attachments/a.png",
	mediaType: "image/png",
	filename: "a.png",
	size: 10,
	...over,
});

const imageChip = (over: Record<string, unknown> = {}): FileChip => ({
	kind: "file",
	state: "ready",
	ref: imageRef(over) as never,
});

const pdfChip = (over: Record<string, unknown> = {}): FileChip => ({
	kind: "file",
	state: "ready",
	ref: {
		path: "attachments/r.pdf",
		mediaType: "application/pdf",
		filename: "report.pdf",
		size: 20,
		...over,
	} as never,
});

const noteChip: Chip = { kind: "note", id: "n-1", title: "Budget" };
const skillChip: Chip = { kind: "skill", ref: { name: "deploy" } };
const tempSkillChip: Chip = { kind: "skill", ref: { url: "https://example.com/t.tar.gz", path: "cache/d41d8/deploy/SKILL.md" } };
const uploadingChip: Chip = {
	kind: "file",
	state: "uploading",
	uploadId: "u-1",
	filename: "b.png",
	mediaType: "image/png",
	size: 30,
};
const failedChip: Chip = { ...uploadingChip, state: "failed" };

const text = (t: string): Draft["items"][number] => ({ type: "text", text: t });
const chip = (c: Chip): Draft["items"][number] => ({ type: "chip", chip: c });

const draft = (items: Draft["items"], shelf: FileChip[] = []): Draft => ({ items, shelf });

describe("parseChip", () => {
	test("accepts valid chips and rejects hostile ones", () => {
		expect(parseChip(noteChip)).toEqual(noteChip);
		expect(parseChip(imageChip())).toEqual(imageChip());
		expect(parseChip(uploadingChip)).toEqual(uploadingChip);
		expect(parseChip({ kind: "note", id: "n", title: "t", extra: 1 })).toBeNull();
		expect(parseChip({ kind: "file", state: "ready", ref: { path: "a", mediaType: "image/png" } })).toBeNull();
		expect(parseChip({ kind: "robot", id: "n" })).toBeNull();
		expect(parseChip("note")).toBeNull();
		expect(parseChip({ kind: "file", state: "gone", uploadId: "u" })).toBeNull();
	});
});

describe("chipKey", () => {
	test("keys by identity and state", () => {
		expect(chipKey(imageChip())).toBe("file:attachments/a.png");
		expect(chipKey(uploadingChip)).toBe("file:u-1");
		expect(chipKey(failedChip)).toBe("file:u-1");
		expect(chipKey(noteChip)).toBe("note:n-1");
		expect(chipKey(skillChip)).toBe("skill:deploy");
		expect(chipKey(tempSkillChip)).toBe("skill:https://example.com/t.tar.gz\ncache/d41d8/deploy/SKILL.md");
	});
});

describe("normalizeDraft", () => {
	test("merges adjacent text, drops empty text, builds the image shelf deduped", () => {
		const out = normalizeDraft({
			items: [text("a"), text(""), text("b"), chip(imageChip()), text(" ")],
			shelf: [imageChip({ path: "attachments/c.png", filename: "c.png" }), imageChip()],
		});
		expect(out).toEqual(
			draft([text("ab"), chip(imageChip()), text(" ")], [imageChip({ path: "attachments/c.png", filename: "c.png" }), imageChip()]),
		);
	});

	test("a failed image keeps its chip but has no preview to show", () => {
		const out = normalizeDraft(draft([text("see "), chip(failedChip)], [failedChip]));
		expect(out).toEqual(draft([text("see "), chip(failedChip)], []));
	});

	test("non-image chips never join the shelf", () => {
		const out = normalizeDraft(draft([chip(pdfChip()), chip(noteChip)], [pdfChip()]));
		expect(out).toEqual(draft([chip(pdfChip()), chip(noteChip)], []));
	});
});

describe("isEmptyDraft / sameDraft / draftText", () => {
	test("blank text with no chips and empty shelf is empty", () => {
		expect(isEmptyDraft(emptyDraft())).toBe(true);
		expect(isEmptyDraft(draft([text("  ")]))).toBe(true);
		expect(isEmptyDraft(draft([text("x")]))).toBe(false);
		expect(isEmptyDraft(draft([], [imageChip()]))).toBe(false);
	});

	test("sameDraft compares content, not identity", () => {
		expect(sameDraft(draft([text("a"), chip(noteChip)]), draft([text("a"), chip({ ...noteChip })]))).toBe(true);
		expect(sameDraft(draft([text("a")]), draft([text("a"), chip(noteChip)]))).toBe(false);
		expect(sameDraft(draft([text("a")], [imageChip()]), draft([text("a")], [imageChip({ path: "attachments/z.png" })]))).toBe(
			false,
		);
	});

	test("draftText joins text items with newlines", () => {
		expect(draftText(textDraft("hi"))).toBe("hi");
		expect(draftText(draft([text("a\nb"), chip(noteChip), text("c")]))).toBe("a\nb\nc");
	});
});

describe("draftToParts", () => {
	test("trims the ends, keeps inner whitespace, flags chips, appends unmentioned shelf images", () => {
		const parts = draftToParts(
			draft(
				[text(" look "), chip(imageChip()), text(" and "), chip(noteChip), text(" please "), chip(pdfChip())],
				[imageChip({ path: "attachments/z.png", filename: "z.png" })],
			),
		);
		expect(parts).toEqual([
			{ type: "text", text: "look " },
			{ type: "data-attachment", data: { ...imageRef(), inline: true } },
			{ type: "text", text: " and " },
			{ type: "data-note", data: { id: "n-1", title: "Budget", inline: true } },
			{ type: "text", text: " please " },
			{ type: "data-attachment", data: { path: "attachments/r.pdf", mediaType: "application/pdf", filename: "report.pdf", size: 20, inline: true } },
			{ type: "data-attachment", data: imageRef({ path: "attachments/z.png", filename: "z.png" }) },
		]);
	});

	test("whitespace-only text between chips is kept, edge text that trims away is dropped", () => {
		const parts = draftToParts(draft([text("  "), chip(noteChip), text(" "), chip(skillChip), text("  ")]));
		expect(parts).toEqual([
			{ type: "data-note", data: { id: "n-1", title: "Budget", inline: true } },
			{ type: "text", text: " " },
			{ type: "data-skill", data: { name: "deploy", inline: true } },
		]);
	});

	test("uploading and failed chips are skipped, a mentioned shelf image is not repeated", () => {
		const parts = draftToParts(
			draft([text("a "), chip(uploadingChip), chip(failedChip)], [imageChip(), uploadingChip]),
		);
		expect(parts).toEqual([{ type: "text", text: "a" }, { type: "data-attachment", data: imageRef() }]);
	});

	test("speech and transcript fields ride through", () => {
		const parts = draftToParts(draft([chip(imageChip({ speech: true, transcript: "hello" }))]));
		expect(parts).toEqual([
			{ type: "data-attachment", data: { ...imageRef({ speech: true, transcript: "hello" }), inline: true } },
		]);
	});
});

describe("uploadState", () => {
	test("uploading and failed from items or shelf, ready otherwise", () => {
		expect(uploadState(draft([chip(uploadingChip)]))).toBe("uploading");
		expect(uploadState(draft([chip(failedChip)]))).toBe("failed");
		expect(uploadState(draft([], [failedChip]))).toBe("failed");
		expect(uploadState(draft([chip(imageChip())], [imageChip()]))).toBe("ready");
	});
});

describe("unsentRemainder", () => {
	test("equal drafts clear to empty", () => {
		const d = draft([text("hello "), chip(noteChip), text("world")], [imageChip()]);
		expect(unsentRemainder(d, d)).toEqual(emptyDraft());
	});

	test("a text prefix inside the first item leaves the tail and the rest", () => {
		const current = draft([text("hello world"), chip(noteChip)], [imageChip()]);
		const sent = draft([text("hello")]);
		expect(unsentRemainder(current, sent)).toEqual(draft([text(" world"), chip(noteChip)], [imageChip()]));
	});

	test("an item prefix leaves the rest and drops the sent shelf images", () => {
		const current = draft([text("hi "), chip(imageChip()), text(" and "), chip(noteChip)], [imageChip({ path: "attachments/z.png", filename: "z.png" })]);
		const sent = draft([text("hi "), chip(imageChip())], [imageChip()]);
		expect(unsentRemainder(current, sent)).toEqual(
			draft([text(" and "), chip(noteChip)], [imageChip({ path: "attachments/z.png", filename: "z.png" })]),
		);
	});

	test("a non-prefix returns the current draft", () => {
		const current = draft([text("other")]);
		const sent = draft([text("hello")]);
		expect(unsentRemainder(current, sent)).toBe(current);
		expect(unsentRemainder(current, draft([text("othe"), chip(noteChip)]))).toBe(current);
	});
});

describe("draftFromMessages", () => {
	const message = (parts: unknown[]): UIMessage["parts"] => parts as UIMessage["parts"];

	test("text parts join with a blank line, messages too", () => {
		const out = draftFromMessages([
			message([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
			message([{ type: "text", text: "c" }]),
		]);
		expect(out).toEqual(draft([text("a\n\nb\n\nc")]));
	});

	test("unflagged images go to the shelf, other unflagged chips follow the text with a space", () => {
		const out = draftFromMessages([
			message([
				{ type: "text", text: "see this" },
				{ type: "data-attachment", data: imageRef() },
				{ type: "data-attachment", data: { path: "attachments/r.pdf", mediaType: "application/pdf", filename: "report.pdf", size: 20 } },
				{ type: "data-note", data: { id: "n-1", title: "Budget" } },
				{ type: "data-skill", data: { url: "https://example.com/t.tar.gz", path: "cache/d41d8/deploy/SKILL.md" } },
			]),
		]);
		expect(out).toEqual(
			draft(
				[
					text("see this "),
					chip(pdfChip()),
					chip(noteChip),
					chip(tempSkillChip),
				],
				[imageChip()],
			),
		);
	});

	test("no space before a trailing chip when the text ends in whitespace or is a chip", () => {
		const out = draftFromMessages([
			message([
				{ type: "text", text: "ends space " },
				{ type: "data-note", data: { id: "n-1", title: "Budget" } },
				{ type: "data-skill", data: { name: "deploy" } },
			]),
		]);
		expect(out).toEqual(draft([text("ends space "), chip(noteChip), chip(skillChip)]));
	});

	test("flagged parts become chips in place", () => {
		const out = draftFromMessages([
			message([
				{ type: "text", text: "look " },
				{ type: "data-attachment", data: { ...imageRef(), inline: true } },
				{ type: "text", text: " and " },
				{ type: "data-note", data: { id: "n-1", title: "Budget", inline: true } },
				{ type: "text", text: "please" },
			]),
		]);
		expect(out).toEqual(draft([text("look "), chip(imageChip()), text(" and "), chip(noteChip), text("please")], [imageChip()]));
	});

	test("malformed refs and parts are skipped", () => {
		const out = draftFromMessages([
			message([
				{ type: "text", text: "hi" },
				{ type: "data-attachment", data: { path: 1 } },
				{ type: "data-note", data: { title: "no id" } },
				{ type: "data-skill", data: {} },
				{ type: "text", text: "!" },
			]),
		]);
		expect(out).toEqual(draft([text("hi\n\n!")]));
	});

	test("a repeated unflagged image stages once", () => {
		const parts = message([{ type: "data-attachment", data: imageRef() }, { type: "data-attachment", data: imageRef() }]);
		expect(draftFromMessages([parts])).toEqual(draft([], [imageChip()]));
	});

	test("round trip with draftFromMessages([draftToParts(d)]) is stable", () => {
		const d = normalizeDraft(
			draft(
				[
					text("look "),
					chip(imageChip()),
					text(" and\n"),
					chip(noteChip),
					chip(pdfChip({ sha256: "a".repeat(64) })),
					chip(skillChip),
					chip(tempSkillChip),
				],
				[imageChip({ path: "attachments/z.png", filename: "z.png" })],
			),
		);
		expect(draftToParts(d)[0]).toEqual({ type: "text", text: "look " });
		expect(sameDraft(draftFromMessages([draftToParts(d)]), d)).toBe(true);
	});
});

describe("joinDrafts", () => {
	test("blank line between two non-empty drafts, shelf merged", () => {
		const a = draft([text("a")], [imageChip()]);
		const b = draft([chip(noteChip), text("b")], [imageChip({ path: "attachments/z.png", filename: "z.png" })]);
		expect(joinDrafts(a, b)).toEqual(
			draft([text("a"), text("\n\n"), chip(noteChip), text("b")], [imageChip(), imageChip({ path: "attachments/z.png", filename: "z.png" })]),
		);
	});

	test("an empty side returns the other", () => {
		expect(joinDrafts(emptyDraft(), textDraft("x"))).toEqual(textDraft("x"));
		expect(joinDrafts(textDraft("x"), emptyDraft())).toEqual(textDraft("x"));
	});
});

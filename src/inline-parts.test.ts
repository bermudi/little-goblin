import { describe, expect, test } from "bun:test";
import type { Message, MessagePart } from "./message.ts";
import {
	hasInlineParts,
	inlineMentions,
	isInlinePart,
	proseOf,
	skillMarkerText,
	tempSkillMarkerText,
} from "./inline-parts.ts";

const ref = (over: Record<string, unknown>): Record<string, unknown> => ({
	path: "attachments/x.png",
	mediaType: "image/png",
	filename: "x.png",
	size: 10,
	...over,
});

const noteData = (over: Record<string, unknown>): Record<string, unknown> => ({
	id: "n-1",
	title: "T",
	rev: 2,
	body: "b",
	projectId: null,
	...over,
});

const attachment = (data: Record<string, unknown>): MessagePart =>
	({ type: "data-attachment", data }) as MessagePart;
const note = (data: Record<string, unknown>): MessagePart =>
	({ type: "data-note", data }) as MessagePart;
const skill = (data: Record<string, unknown>): MessagePart =>
	({ type: "data-skill", data }) as MessagePart;
const text = (t: string): MessagePart => ({ type: "text", text: t }) as MessagePart;

const msg = (parts: MessagePart[], role: "user" | "assistant" = "user"): Message => ({
	id: "m-1",
	role,
	parts,
});

describe("isInlinePart / hasInlineParts", () => {
	test("only the three chip part types with data.inline === true are inline", () => {
		expect(isInlinePart(attachment(ref({ inline: true })))).toBe(true);
		expect(isInlinePart(note(noteData({ inline: true })))).toBe(true);
		expect(isInlinePart(skill({ name: "deploy", inline: true }))).toBe(true);
		expect(isInlinePart(attachment(ref({})))).toBe(false);
		expect(isInlinePart(attachment(ref({ inline: "yes" })))).toBe(false);
		expect(isInlinePart(text("hi"))).toBe(false);
		expect(isInlinePart(({ type: "step-start" }) as MessagePart)).toBe(false);
		expect(hasInlineParts([text("a"), attachment(ref({}))])).toBe(false);
		expect(hasInlineParts([text("a"), note(noteData({ inline: true }))])).toBe(true);
	});
});

describe("proseOf", () => {
	test("text parts and inline chips in order, no separator, trimmed, others skipped", () => {
		const parts = [
			text("  see "),
			attachment(ref({ inline: true })),
			text(" and "),
			attachment(ref({ path: "attachments/r.pdf", mediaType: "application/pdf", filename: "r.pdf", inline: true })),
			note(noteData({ title: "Budget", inline: true })),
			skill({ name: "deploy", inline: true }),
			text(" please  "),
			attachment(ref({})),
			note(noteData({})),
			({ type: "step-start" }) as MessagePart,
		];
		expect(proseOf(parts)).toBe(
			"see [x.png] and [r.pdf][Budget][deploy] please",
		);
	});

	test("labels sanitize brackets and control characters, collapse whitespace, cap at 120", () => {
		const long = "a".repeat(200);
		expect(proseOf([text("v "), attachment(ref({ filename: "we[ird\n]name", inline: true }))])).toBe(
			"v [we ird name]",
		);
		expect(proseOf([attachment(ref({ filename: `x${long}`, inline: true }))])).toBe(
			`[x${"a".repeat(119)}]`,
		);
	});

	test("fallback labels and temp skill names", () => {
		expect(proseOf([attachment({ inline: true })])).toBe("[file]");
		expect(proseOf([note({ inline: true })])).toBe("[note]");
		expect(proseOf([skill({ url: "https://ex.dev/t.tar.gz", path: "cache/abc/deploy/SKILL.md", inline: true })])).toBe(
			"[deploy]",
		);
		expect(proseOf([skill({ inline: true })])).toBe("[skill]");
	});
});

describe("inlineMentions", () => {
	test("images, a pdf, a note, both skill kinds and text become one text part plus items", () => {
		const a = attachment(ref({ path: "attachments/a.png", filename: "a.png", inline: true }));
		const b = attachment(
			ref({ path: "attachments/b.png", filename: "b.png", size: 20, inline: true }),
		);
		const pdf = attachment(
			ref({
				path: "attachments/r.pdf",
				mediaType: "application/pdf",
				filename: "report.pdf",
				inline: true,
			}),
		);
		const n = note(noteData({ id: "n-9", title: "Budget", inline: true }));
		const cat = skill({ name: "deploy", inline: true });
		const tmp = skill({
			url: "https://example.com/t.tar.gz",
			path: "cache/d41d8cd9/deploy/SKILL.md",
			inline: true,
		});
		const m = msg([text("compare "), a, text(" with\n"), b, pdf, n, cat, tmp, text(" please")]);
		const out = inlineMentions(m);
		expect(out).not.toBe(m);
		expect(out.parts).toEqual([
			{
				type: "text",
				text:
					"compare [image 1: a.png] with\n[image 2: b.png][file 1: report.pdf]" +
					"[note: Budget (id n-9)][skill: deploy][temp skill: deploy (example.com)] please",
			},
			{ type: "text", text: "[image 1: a.png]" },
			{ type: "data-attachment", data: ref({ path: "attachments/a.png", filename: "a.png" }) },
			{ type: "text", text: "[image 2: b.png]" },
			{ type: "data-attachment", data: ref({ path: "attachments/b.png", filename: "b.png", size: 20 }) },
			{ type: "text", text: "[file 1: report.pdf]" },
			{
				type: "data-attachment",
				data: ref({ path: "attachments/r.pdf", mediaType: "application/pdf", filename: "report.pdf" }),
			},
			{ type: "data-note", data: noteData({ id: "n-9", title: "Budget" }) },
			{ type: "data-skill", data: { name: "deploy" } },
			{
				type: "data-skill",
				data: { url: "https://example.com/t.tar.gz", path: "cache/d41d8cd9/deploy/SKILL.md" },
			},
		]);
	});

	test("a repeated image reuses its number and emits one item", () => {
		const a = attachment(ref({ path: "attachments/a.png", filename: "a.png", inline: true }));
		const b = attachment(ref({ path: "attachments/b.png", filename: "b.png", inline: true }));
		const out = inlineMentions(msg([text("x "), a, text(" y "), a, b, text(" z"), a]));
		expect(out.parts).toEqual([
			{ type: "text", text: "x [image 1: a.png] y [image 1: a.png][image 2: b.png] z[image 1: a.png]" },
			{ type: "text", text: "[image 1: a.png]" },
			{ type: "data-attachment", data: ref({ path: "attachments/a.png", filename: "a.png" }) },
			{ type: "text", text: "[image 2: b.png]" },
			{ type: "data-attachment", data: ref({ path: "attachments/b.png", filename: "b.png" }) },
		]);
	});

	test("a message of only chips still gets its text part and items", () => {
		const a = attachment(ref({ path: "attachments/a.png", filename: "a.png", inline: true }));
		const n = note(noteData({ id: "n-2", title: "N", inline: true }));
		const out = inlineMentions(msg([a, n]));
		expect(out.parts).toEqual([
			{ type: "text", text: "[image 1: a.png][note: N (id n-2)]" },
			{ type: "text", text: "[image 1: a.png]" },
			{ type: "data-attachment", data: ref({ path: "attachments/a.png", filename: "a.png" }) },
			{ type: "data-note", data: noteData({ id: "n-2", title: "N" }) },
		]);
	});

	test("a loose unflagged part rides after the items, unchanged", () => {
		const loose = attachment(ref({ path: "attachments/loose.png", filename: "loose.png" }));
		const out = inlineMentions(msg([text("hi "), attachment(ref({ inline: true })), loose]));
		expect(out.parts).toEqual([
			{ type: "text", text: "hi [image 1: x.png]" },
			{ type: "text", text: "[image 1: x.png]" },
			{ type: "data-attachment", data: ref({}) },
			loose,
		]);
		expect(out.parts[3]).toBe(loose);
	});

	test("no flag, or not a user message, returns the same object", () => {
		const plain = msg([text("hi"), attachment(ref({})), note(noteData({})), skill({ name: "s" })]);
		expect(inlineMentions(plain)).toBe(plain);
		const flaggedAssistant = msg([text("hi"), attachment(ref({ inline: true }))], "assistant");
		expect(inlineMentions(flaggedAssistant)).toBe(flaggedAssistant);
	});

	test("malformed inline chips keep a label but emit no item", () => {
		const out = inlineMentions(msg([attachment({ inline: true }), note({ inline: true }), skill({ inline: true })]));
		expect(out.parts).toEqual([{ type: "text", text: "[file][note][skill]" }]);
	});

	test("the moved markers render as before", () => {
		expect(skillMarkerText("deploy")).toBe("[skill: deploy]");
		expect(tempSkillMarkerText("deploy", "https://example.com/x.tar.gz")).toBe(
			"[temp skill: deploy (example.com)]",
		);
	});
});

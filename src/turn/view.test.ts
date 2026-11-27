import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync as mkd, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToModelMessages } from "ai";
import type { PromptMessage } from "../prompt-message.ts";
import type { Message } from "../message.ts";
import { attachmentPart } from "../agent/attachments.ts";
import { promptText, serializePrompt } from "../agent/claude-code/prompt.ts";
import { summaryMessage } from "../conversation-events.ts";
import {
	ADDITIONAL_TOOLS_PREFIX,
	INCREMENTAL_TOOLS_NOTICE,
	TOOLS_PART,
	type ToolChange,
	type ToolDeclaration,
} from "../agent/tool-declarations.ts";
import { INSERTS_PART } from "../agent/turn-inserts.ts";
import { setLogFile } from "../log.ts";
import type { RecallContext } from "../memory/mod.ts";
import {
	buildModelView,
	convertSteeredMessage,
	incompleteToolCallIds,
	type ViewContext,
} from "./view.ts";

const user = (id: string, text: string): Message => ({
	id,
	role: "user",
	parts: [{ type: "text", text }],
});
const asst = (id: string, text: string): Message => ({
	id,
	role: "assistant",
	parts: [{ type: "text", text }],
});
const declaration = (name: string, description = name): ToolDeclaration => ({
	type: "function",
	name,
	description,
	parameters: { type: "object" },
	strict: false,
});
const toolStamp = (change: ToolChange): Message["parts"][number] =>
	({ type: TOOLS_PART, data: change }) as Message["parts"][number];
const entries = (msgs: Message[]) => msgs.map((m, i) => ({ seq: i + 1, message: m }));
const recall = (anchorSeq: number, content: string): RecallContext => ({
	anchorSeq,
	content,
	sourceIds: [`e${anchorSeq}`],
});
const texts = (view: PromptMessage[]): string[] =>
	view.flatMap((m) =>
		typeof m.content === "string"
			? [m.content]
			: m.content.map((p) => (p as { text: string }).text),
	);

const ctx: ViewContext = {
	convId: "dm:1",
	modelRef: "test/model-1",
	tools: {},
	modalities: undefined,
	carries: () => false,
	skillRef: () => {
		throw new Error("no skill parts expected in this fixture");
	},
};

const build = async (
	entriesList: { seq: number; message: Message }[],
	prior: RecallContext[] = [],
	current: RecallContext | null = null,
	partial: Message | null = null,
	summarySeq: number | null = null,
	context: Partial<ViewContext> = {},
	toolHistory?: { seq: number; message: Message }[],
): Promise<PromptMessage[]> =>
	buildModelView({ ...ctx, ...context }, {
		entries: entriesList,
		...(toolHistory !== undefined ? { toolHistory } : {}),
		prior,
		current,
		partial,
		summarySeq,
		assertAuthority: () => {},
	});

describe("the model view", () => {
	test("splitting a two-step assistant reply preserves conversion and drops its data-only head", async () => {
		const reply = {
			id: "a-split",
			role: "assistant",
			parts: [
				{ type: "step-start" },
				{ type: "text", text: "first step" },
				{ type: "step-start" },
				{ type: "text", text: "second step" },
			],
		} as unknown as Message;
		const expected = await convertToModelMessages([reply], {
			tools: {},
			ignoreIncompleteToolCalls: true,
		});
		expect(await build(entries([reply]))).toEqual(expected);

		const changedReply = {
			...reply,
			parts: [
				{
					type: TOOLS_PART,
					data: { added: [declaration("new-tool")], removed: [] },
				},
				{
					type: INSERTS_PART,
					data: {
						inserts: [{
							step: 1,
							items: [{ kind: "text", text: "[context: 20k token limit]" }],
						}],
					},
				},
				...reply.parts,
			],
		} as unknown as Message;
		const changed = await build(
			entries([user("u1", "start"), changedReply]),
			[],
			null,
			null,
			null,
			{ toolsInInput: true },
		);
		expect(changed.filter(
			(message) =>
				message.role === "system" &&
				typeof message.content === "string" &&
				message.content.includes(INCREMENTAL_TOOLS_NOTICE),
		)).toHaveLength(0);
		expect(changed.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(texts(changed)).toContain("[context: 20k token limit]");
		expect(texts(changed).filter((text) => text.startsWith(ADDITIONAL_TOOLS_PREFIX))).toHaveLength(1);
	});

	test("a split reply applies its stored incremental tool change once", async () => {
		const initialChange = { added: [declaration("old-tool")], removed: [] };
		const nextChange = { added: [declaration("new-tool")], removed: [] };
		const reply = {
			id: "a2",
			role: "assistant",
			parts: [
				{ type: TOOLS_PART, data: nextChange },
				{
					type: INSERTS_PART,
					data: {
						inserts: [{
							step: 1,
							items: [{ kind: "text", text: "[context: 10k token limit]" }],
						}],
					},
				},
				{ type: "step-start" },
				{ type: "text", text: "first" },
				{ type: "step-start" },
				{ type: "text", text: "second" },
			],
		} as unknown as Message;
		const view = await build(
			entries([
				user("u1", "start"),
				{ id: "a1", role: "assistant", parts: [toolStamp(initialChange), { type: "text", text: "old reply" }] } as Message,
				user("u2", "next"),
				reply,
			]),
			[],
			null,
			null,
			null,
			{ toolsInInput: true },
		);
		expect(view.filter(
			(message) =>
				message.role === "system" &&
				typeof message.content === "string" &&
				message.content === INCREMENTAL_TOOLS_NOTICE,
		)).toHaveLength(1);
	});

	test("replays recorded mid-turn inserts at their step boundary without merging", async () => {
		const reply = {
			id: "a1",
			role: "assistant",
			parts: [
				{ type: "text", text: "before" },
				{ type: "step-start" },
				{ type: "text", text: "between" },
				{ type: "step-start" },
				{ type: "text", text: "after" },
				{
					type: INSERTS_PART,
					data: {
						inserts: [{
							step: 1,
							items: [
								{ kind: "text", text: "[context: 100k token limit]" },
								{ kind: "steer", seq: 3 },
							],
						}],
					},
				},
			],
		} as unknown as Message;
		const view = await build([
			{ seq: 1, message: user("u1", "start") },
			{ seq: 2, message: reply },
			{ seq: 3, message: user("u2", "steer") },
		]);
		expect(view.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"assistant",
			"user",
			"user",
			"assistant",
		]);
		expect(texts(view)).toEqual([
			"start",
			"before",
			"between",
			"[context: 100k token limit]",
			"steer",
			"after",
		]);
	});

	test("recall blocks interleave before their anchored user and fuse with it", async () => {
		const view = await build(
			entries([user("u1", "i like quiet"), asst("a1", "noted"), user("u2", "and dark mode")]),
			[recall(1, "prefers quiet")],
			recall(3, "prefers dark"),
		);
		expect(view.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(texts(view)).toEqual([
			"prefers quiet",
			"i like quiet",
			"noted",
			"prefers dark",
			"and dark mode",
		]);
	});

	test("no recall, no reordering — the view is history's own sequence", async () => {
		const view = await build(
			entries([user("u1", "2+2?"), asst("a1", "answer"), user("u2", "2+5?")]),
		);
		expect(view.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(texts(view)).toEqual(["2+2?", "answer", "2+5?"]);
	});

	test("old history without insert records keeps its exact model prompt", async () => {
		expect(await build(entries([
			user("u1", "old question"),
			asst("a1", "old answer"),
			user("u2", "next"),
		]))).toEqual([
			{ role: "user", content: [{ type: "text", text: "old question" }] },
			{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
			{ role: "user", content: [{ type: "text", text: "next" }] },
		]);
	});

	test("a resume's partial rides last, as the in-progress assistant message", async () => {
		const partial = asst("p", "half an answ");
		const view = await build(
			entries([user("u1", "question"), asst("a1", "old answer")]),
			[],
			null,
			partial,
		);
		expect(view.map((m) => m.role)).toEqual(["user", "assistant", "assistant"]);
		expect(texts(view)).toEqual(["question", "old answer", "half an answ"]);
	});

	test("a compaction summary heads the view and never inherits the boundary's block", async () => {
		const summary = summaryMessage(
			{
				boundarySeq: 2,
				summary: "earlier days",
				summaryEligible: true,
				split: null,
				tokensBefore: 0,
				model: "m",
				createdAt: "",
				tailEvents: null,
			},
			"dm:1",
		);
		const boundary = [
			{ seq: 2, message: summary },
			{ seq: 3, message: user("u3", "fresh question") },
		];
		const view = await build(boundary, [recall(2, "stale evidence")], null, null, 2);
		expect(view.map((m) => m.role)).toEqual(["user"]);
		const marker = (summary.parts[0] as { text: string }).text;
		expect(marker).toContain("conversation dm:1");
		expect(marker).toContain("before seq 2");
		expect(texts(view)).toEqual([marker, "fresh question"]);
	});

	test("turn N+1's view is turn N's view with content appended", async () => {
		const turn1 = entries([user("u1", "i like quiet")]);
		const view1 = await build(turn1, [], recall(1, "prefers quiet"));
		const turn2 = entries([
			user("u1", "i like quiet"),
			asst("a1", "noted"),
			user("u2", "and dark mode"),
		]);
		const view2 = await build(turn2, [recall(1, "prefers quiet")], recall(3, "prefers dark"));
		expect(JSON.stringify(view2.slice(0, view1.length))).toBe(JSON.stringify(view1));
	});

	test("Codex adoption declares the full current tool set at the head", async () => {
		const current = declaration("agent", "current agent tools");
		const view = await build(
			entries([user("u1", "question")]),
			[],
			null,
			null,
			null,
			{ toolsInInput: true, pendingToolChange: { added: [current], removed: [] } },
		);
		expect(view[0]).toMatchObject({
			role: "system",
			content: `${ADDITIONAL_TOOLS_PREFIX}${JSON.stringify([current])}`,
			providerOptions: { codex: { inInput: true } },
		});
		expect(view.map((message) => message.role)).toEqual(["system", "user"]);
	});

	test("Codex change notices and additions stay before their stored event", async () => {
		const oldTool = declaration("old");
		const newTool = declaration("new");
		const laterTool = declaration("later");
		const view = await build(
			entries([
				user("u1", "first"),
				{ ...asst("a1", "answer"), parts: [toolStamp({ added: [oldTool], removed: [] }), { type: "text", text: "answer" }] },
				user("u2", "second"),
				{ ...asst("a2", "answer two"), parts: [toolStamp({ added: [newTool], removed: ["old"] }), { type: "text", text: "answer two" }] },
				user("u3", "third"),
				{ ...asst("a3", "answer three"), parts: [toolStamp({ added: [laterTool], removed: [] }), { type: "text", text: "answer three" }] },
			]),
			[],
			null,
			null,
			null,
			{ toolsInInput: true },
		);
		const systems = view.filter((message) => message.role === "system");
		expect(systems.map((message) => message.content)).toEqual([
			`${ADDITIONAL_TOOLS_PREFIX}${JSON.stringify([oldTool])}`,
			"This is an incremental tools update. Previously declared tools remain available unless explicitly marked unavailable. A tool declared again here is available again, and its latest definition replaces the earlier one.",
			`${ADDITIONAL_TOOLS_PREFIX}${JSON.stringify([newTool])}`,
			"The following tools are no longer available. Do not call them:\n- old",
			"This is an incremental tools update. Previously declared tools remain available unless explicitly marked unavailable. A tool declared again here is available again, and its latest definition replaces the earlier one.\nStill unavailable: old.",
			`${ADDITIONAL_TOOLS_PREFIX}${JSON.stringify([laterTool])}`,
		]);
		expect(systems.every((message) => message.providerOptions?.codex?.inInput === true)).toBe(true);
		expect(view.some((message) => JSON.stringify(message).includes(TOOLS_PART))).toBe(false);
	});

	test("the Codex head fold includes declarations stored before a compaction summary", async () => {
		const before = declaration("before");
		const after = declaration("after");
		const summary = summaryMessage(
			{
				boundarySeq: 2,
				summary: "folded history",
				summaryEligible: true,
				split: null,
				tokensBefore: 10,
				model: "m",
				createdAt: "",
				tailEvents: null,
			},
			"dm:1",
		);
		const fullHistory = [
			{ seq: 1, message: { ...asst("old", "old reply"), parts: [toolStamp({ added: [before], removed: [] }), { type: "text" as const, text: "old reply" }] } },
			{ seq: 2, message: summary },
			{ seq: 3, message: user("u3", "fresh question") },
			{ seq: 4, message: { ...asst("new", "new reply"), parts: [toolStamp({ added: [after], removed: [] }), { type: "text" as const, text: "new reply" }] } },
		];
		const modelWindow = [fullHistory[1]!, fullHistory[2]!, fullHistory[3]!];
		const view = await build(
			modelWindow,
			[],
			null,
			null,
			2,
			{ toolsInInput: true },
			fullHistory,
		);
		const systems = view.filter((message) => message.role === "system").map((message) => message.content);
		expect(systems).toEqual([
			`${ADDITIONAL_TOOLS_PREFIX}${JSON.stringify([before])}`,
			"This is an incremental tools update. Previously declared tools remain available unless explicitly marked unavailable. A tool declared again here is available again, and its latest definition replaces the earlier one.",
			`${ADDITIONAL_TOOLS_PREFIX}${JSON.stringify([after])}`,
		]);
	});

	test("a Codex tool edit after a compaction appends and keeps the compacted head", async () => {
		const before = declaration("before");
		const edited = declaration("before", "edited description");
		const summary = summaryMessage(
			{
				boundarySeq: 2,
				summary: "folded history",
				summaryEligible: true,
				split: null,
				tokensBefore: 10,
				model: "m",
				createdAt: "",
				tailEvents: null,
			},
			"dm:1",
		);
		const fullHistory = [
			{ seq: 1, message: { ...asst("old", "old reply"), parts: [toolStamp({ added: [before], removed: [] }), { type: "text" as const, text: "old reply" }] } },
			{ seq: 2, message: summary },
			{ seq: 3, message: user("u3", "fresh question") },
			{ seq: 4, message: asst("a3", "unchanged reply") },
		];
		const unchanged = await build(fullHistory.slice(1), [], null, null, 2, { toolsInInput: true }, fullHistory);
		const withNext = [...fullHistory, { seq: 5, message: user("u4", "next question") }];
		const changed = await build(
			withNext.slice(1),
			[],
			null,
			null,
			2,
			{ toolsInInput: true, pendingToolChange: { added: [edited], removed: [] } },
			withNext,
		);
		expect(JSON.stringify(changed.slice(0, unchanged.length))).toBe(JSON.stringify(unchanged));
		expect(changed.at(-1)).toMatchObject({
			role: "system",
			content: `${ADDITIONAL_TOOLS_PREFIX}${JSON.stringify([edited])}`,
		});
	});

	test("a history system event renders as a bracketed user note in position", async () => {
		const event = "proposed skill: talk-first — announced in this topic";
		const history = entries([
			asst("a0", "earlier answer"),
			{ id: "sys1", role: "system", parts: [{ type: "text", text: event }] },
			user("u2", "what did you save?"),
		]);
		const view = await build(history);
		expect(view.map((m) => m.role)).toEqual(["assistant", "user"]);
		expect(texts(view)).toEqual([
			"earlier answer",
			`[system event: ${event}]`,
			"what did you save?",
		]);
	});

	test("an unconvertible message degrades alone — burst-mates keep their text", async () => {
		const poison = {
			id: "poison",
			role: "user",
			parts: [
				{ type: "text", text: "read this" },
				{ type: "file", mediaType: "image/png", filename: "x.png", url: "not a url" },
			],
		} as unknown as Message;
		const view = await build(entries([poison, user("u2", "still there?")]));
		const joined = texts(view).join("\n");
		expect(joined).toContain("could not be prepared for the model (user role)");
		expect(joined).toContain("still there?");
	});

	test("a stored data-note part reaches the model as the fenced text — malformed degrades in place", async () => {
		const attached = {
			id: "n1",
			role: "user",
			parts: [
				{ type: "text", text: "use this" },
				{
					type: "data-note",
					data: { id: "note-1", title: "ref", rev: 3, body: "the note body", projectId: null },
				},
			],
		} as unknown as Message;
		const view = await build(entries([attached]));
		const joined = texts(view).join("\n");
		expect(joined).toContain("use this");
		expect(joined).toContain('Attached note "ref" (id note-1, rev 3 as of this message):');
		expect(joined).toContain('<note id="note-1" rev="3" title="ref">');
		expect(joined).toContain("the note body");

		const malformed = {
			id: "n2",
			role: "user",
			parts: [{ type: "data-note", data: { wrong: true } }],
		} as unknown as Message;
		const degraded = await build(entries([malformed]));
		expect(texts(degraded).join("\n")).toContain("attached note could not be rendered");
	});

	test("the injected authority re-check runs once and its fence propagates", async () => {
		const sentinel = new Error("fenced");
		let calls = 0;
		await expect(
			buildModelView(ctx, {
				entries: entries([user("u1", "hi")]),
				prior: [],
				current: null,
				partial: null,
				summarySeq: null,
				assertAuthority: () => {
					calls++;
					throw sentinel;
				},
			}),
		).rejects.toBe(sentinel);
		expect(calls).toBe(1);
	});
});

describe("reasoning origin (#417)", () => {
	let logDir: string | null = null;
	afterEach(() => {
		setLogFile(null);
		if (logDir !== null) rmSync(logDir, { recursive: true, force: true });
		logDir = null;
	});
	const dropMsg = "foreign reasoning dropped from the model view";
	const capture = (): string => {
		logDir = mkdtempSync(join(tmpdir(), "goblin-viewlog-"));
		const target = join(logDir, "goblin.log");
		setLogFile(target);
		return target;
	};
	const lines = (target: string): Record<string, unknown>[] =>
		readFileSync(target, "utf8")
			.split("\n")
			.filter((l) => l !== "")
			.map((l) => JSON.parse(l) as Record<string, unknown>);

	const asstReasoning = (id: string, model: string | undefined, text: string): Message => ({
		id,
		role: "assistant",
		...(model !== undefined ? { metadata: { model } } : {}),
		parts: [
			{
				type: "reasoning",
				text,
				providerMetadata: {
					codex: { itemId: "rs_1", replayScope: "s1", reasoningEncryptedContent: "C1" },
				},
			},
			{ type: "text", text: "the answer" },
		],
	});

	test("reasoning from the serving model replays with provider options intact", async () => {
		const view = await build(entries([asstReasoning("a1", "test/model-1", "chain of thought")]));
		const wire = JSON.stringify(view);
		expect(wire).toContain("chain of thought");
		expect(wire).toContain("reasoningEncryptedContent");
		const assistant = view.find((m) => m.role === "assistant");
		if (assistant === undefined) throw new Error("no assistant message in view");
		const content = assistant.content as Array<{
			type: string;
			text?: string;
			providerOptions?: unknown;
		}>;
		const reasoning = content.find((p) => p.type === "reasoning");
		expect(reasoning?.text).toBe("chain of thought");
		expect(reasoning?.providerOptions).toEqual({
			codex: { itemId: "rs_1", replayScope: "s1", reasoningEncryptedContent: "C1" },
		});
	});

	test("foreign reasoning drops; sibling text and tool parts stay", async () => {
		const target = capture();
		const foreign = {
			id: "a1",
			role: "assistant",
			metadata: { model: "other/model-2" },
			parts: [
				{ type: "reasoning", text: "foreign thinking" },
				{ type: "text", text: "still here" },
				{
					type: "tool-bash",
					toolCallId: "t1",
					state: "output-available",
					input: { command: "pwd" },
					output: "/workspace",
				},
			],
		} as unknown as Message;
		const view = await build(entries([foreign]));
		const wire = JSON.stringify(view);
		expect(wire).not.toContain("foreign thinking");
		expect(wire).not.toContain('"type":"reasoning"');
		expect(wire).toContain("still here");
		expect(wire).toContain("tool-call");
		expect(wire).toContain("tool-result");
		expect(wire).toContain("/workspace");
		const entry = lines(target).find((l) => l.msg === dropMsg);
		expect(entry).toMatchObject({
			level: "info",
			conversation: "dm:1",
			target: "test/model-1",
			messages: 1,
			parts: 1,
		});
	});

	test("unstamped assistant reasoning drops — origin cannot be proven", async () => {
		const view = await build(entries([asstReasoning("a1", undefined, "unstamped thinking")]));
		const wire = JSON.stringify(view);
		expect(wire).not.toContain("unstamped thinking");
		expect(wire).not.toContain('"type":"reasoning"');
		expect(texts(view)).toContain("the answer");
	});

	test("the recovery partial keeps its reasoning — a continuation never switches models", async () => {
		const partial = asstReasoning("p", undefined, "partial thinking");
		const view = await build(entries([user("u1", "q")]), [], null, partial);
		expect(JSON.stringify(view)).toContain("partial thinking");
	});

	test("partial inserts at and after the step-start count are not replayed", async () => {
		const partial = {
			id: "p-inserts",
			role: "assistant",
			parts: [
				{ type: "step-start" },
				{ type: "text", text: "first partial step" },
				{ type: "step-start" },
				{ type: "text", text: "second partial step" },
				{
					type: INSERTS_PART,
					data: {
						inserts: [
							{ step: 1, items: [{ kind: "text", text: "insert before cut" }] },
							{ step: 2, items: [{ kind: "text", text: "insert at cut" }] },
						],
					},
				},
			],
		} as unknown as Message;
		const view = await build(entries([user("u1", "question")]), [], null, partial);
		expect(texts(view)).toContain("insert before cut");
		expect(texts(view)).not.toContain("insert at cut");
	});

	test("a split foreign-model partial keeps reasoning in both slices", async () => {
		const partial = {
			id: "p-foreign-inserts",
			role: "assistant",
			metadata: { model: "other/model-2" },
			parts: [
				{ type: "step-start" },
				{ type: "reasoning", text: "first partial reasoning" },
				{ type: "text", text: "first partial answer" },
				{ type: "step-start" },
				{ type: "reasoning", text: "second partial reasoning" },
				{ type: "text", text: "second partial answer" },
				{
					type: INSERTS_PART,
					data: {
						inserts: [{ step: 1, items: [{ kind: "text", text: "[context: partial insert]" }] }],
					},
				},
			],
		} as unknown as Message;
		const view = await build(entries([user("u1", "question")]), [], null, partial);
		expect(view.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
		expect(texts(view)).toEqual([
			"question",
			"first partial reasoning",
			"first partial answer",
			"[context: partial insert]",
			"second partial reasoning",
			"second partial answer",
		]);
	});

	test("a history message sharing the partial's id is still filtered", async () => {
		const history = asstReasoning("p", "other/model-2", "foreign thinking");
		const partial = asstReasoning("p", undefined, "partial thinking");
		const view = await build(entries([user("u1", "q"), history]), [], null, partial);
		const wire = JSON.stringify(view);
		expect(wire).not.toContain("foreign thinking");
		expect(wire).toContain("partial thinking");
	});

	test("a foreign reasoning-file part drops like reasoning", async () => {
		const foreign = {
			id: "a1",
			role: "assistant",
			metadata: { model: "other/model-2" },
			parts: [
				{
					type: "reasoning-file",
					mediaType: "image/png",
					url: "https://example.com/secret-diagram.png",
				},
				{ type: "text", text: "kept text" },
			],
		} as Message;
		const view = await build(entries([foreign]));
		const wire = JSON.stringify(view);
		expect(wire).not.toContain("secret-diagram.png");
		expect(wire).toContain("kept text");
	});
});

describe("the steer variant", () => {
	test("one submit converts through the same gates — a gate-failed attachment degrades to its reference", async () => {
		const message = user("s1", "what is this");
		message.parts.unshift(
			attachmentPart({
				path: "/w/attachments/a.png",
				mediaType: "image/png",
				filename: "a.png",
				size: 9,
			}),
		);
		const view = await convertSteeredMessage(ctx, message);
		expect(view).toHaveLength(1);
		expect(texts(view)).toEqual([
			"[attachment: /w/attachments/a.png — image/png, 9 bytes. Read it with read_file or bash tools.]",
			"what is this",
		]);
	});

	test("a steered data-note maps through the same text fence", async () => {
		const message = {
			id: "s1",
			role: "user",
			parts: [
				{
					type: "data-note",
					data: { id: "note-9", title: "t", rev: 1, body: "steered note", projectId: "p1" },
				},
			],
		} as unknown as Message;
		const view = await convertSteeredMessage(ctx, message);
		const joined = texts(view).join("\n");
		expect(joined).toContain('Attached note "t" (id note-9, rev 1');
		expect(joined).toContain("steered note");
	});

	test("an unconvertible submit throws — the poison-pill verdict is the caller's", async () => {
		const poison = {
			id: "poison",
			role: "user",
			parts: [
				{ type: "text", text: "read this" },
				{ type: "file", mediaType: "image/png", filename: "x.png", url: "not a url" },
			],
		} as unknown as Message;
		await expect(convertSteeredMessage(ctx, poison)).rejects.toThrow("Invalid URL");
	});
});

describe("inline chips in the model view", () => {
	let home: string | null = null;
	afterEach(() => {
		if (home !== null) rmSync(home, { recursive: true, force: true });
		home = null;
		delete process.env.GOBLIN_HOME;
	});
	const skillCtx: ViewContext = {
		convId: "dm:1",
		modelRef: "test/model-1",
		tools: {},
		modalities: undefined,
		carries: () => false,
		skillRef: (ref) =>
			"name" in ref
				? { name: ref.name, body: `SKILL BODY ${ref.name}` }
				: { name: "fetch", body: "TEMP BODY" },
	};
	const inlineMsg = {
		id: "u1",
		role: "user",
		parts: [
			{ type: "text", text: "look at " },
			{
				type: "data-attachment",
				data: {
					path: "/w/attachments/a.png",
					mediaType: "image/png",
					filename: "a.png",
					size: 9,
					inline: true,
				},
			},
			{ type: "text", text: " and " },
			{
				type: "data-attachment",
				data: {
					path: "/w/attachments/report.pdf",
					mediaType: "application/pdf",
					filename: "report.pdf",
					size: 99,
					inline: true,
				},
			},
			{ type: "text", text: " and " },
			{
				type: "data-note",
				data: {
					id: "note-1",
					title: "Budget",
					rev: 3,
					body: "the note body",
					projectId: null,
					inline: true,
				},
			},
			{ type: "text", text: " plus " },
			{ type: "data-skill", data: { name: "deploy", inline: true } },
			{ type: "text", text: " and " },
			{ type: "data-skill", data: { name: "deploy", inline: true } },
			{ type: "text", text: " please" },
		],
	} as unknown as Message;

	test("a flagged message folds to a text part, then the mentioned items in first-mention order (S2)", async () => {
		const view = await buildModelView(skillCtx, {
			entries: entries([inlineMsg]),
			prior: [],
			current: null,
			partial: null,
			summarySeq: null,
			assertAuthority: () => {},
		});
		expect(texts(view)).toEqual([
			"look at [image 1: a.png] and [file 1: report.pdf] and [note: Budget (id note-1)] plus [skill: deploy] and [skill: deploy] please",
			"[image 1: a.png]",
			"[attachment: /w/attachments/a.png — image/png, 9 bytes. Read it with read_file or bash tools.]",
			"[file 1: report.pdf]",
			"[attachment: /w/attachments/report.pdf — application/pdf, 99 bytes. Read it with read_file or bash tools.]",
			'Attached note "Budget" (id note-1, rev 3 as of this message):\n<note id="note-1" rev="3" title="Budget">\nthe note body\n</note>',
			"[skill: deploy]",
		]);
	});

	test("the Claude prompt adapter renders the same order (S2)", async () => {
		const view = await buildModelView(skillCtx, {
			entries: entries([inlineMsg]),
			prior: [],
			current: null,
			partial: null,
			summarySeq: null,
			assertAuthority: () => {},
		});
		const prompt = promptText(serializePrompt(view));
		expect(prompt).toContain(
			"look at [image 1: a.png] and [file 1: report.pdf] and [note: Budget (id note-1)] plus [skill: deploy] and [skill: deploy] please",
		);
		const firstImage = prompt.indexOf("[image 1: a.png]");
		const fileLabel = prompt.indexOf("[file 1: report.pdf]");
		const noteFence = prompt.indexOf("Attached note");
		const skillMarker = prompt.lastIndexOf("[skill: deploy]");
		expect([firstImage, fileLabel, noteFence, skillMarker].every((i) => i >= 0)).toBe(true);
		expect(firstImage).toBeLessThan(fileLabel);
		expect(fileLabel).toBeLessThan(noteFence);
		expect(noteFence).toBeLessThan(skillMarker);
	});

	test("an unflagged [text, image, note, skill] message renders exactly as before (S2)", async () => {
		const unflagged = {
			id: "u1",
			role: "user",
			parts: [
				{ type: "text", text: "see this" },
				attachmentPart({
					path: "/w/attachments/a.png",
					mediaType: "image/png",
					filename: "a.png",
					size: 9,
				}),
				{
					type: "data-note",
					data: { id: "note-1", title: "Budget", rev: 3, body: "the note body", projectId: null },
				},
				{ type: "data-skill", data: { name: "deploy" } },
			],
		} as unknown as Message;
		const view = await buildModelView(skillCtx, {
			entries: entries([unflagged]),
			prior: [],
			current: null,
			partial: null,
			summarySeq: null,
			assertAuthority: () => {},
		});
		expect(texts(view)).toEqual([
			"see this",
			"[attachment: /w/attachments/a.png — image/png, 9 bytes. Read it with read_file or bash tools.]",
			'Attached note "Budget" (id note-1, rev 3 as of this message):\n<note id="note-1" rev="3" title="Budget">\nthe note body\n</note>',
			"[skill: deploy]",
		]);
	});

	test("a repeated mention reuses its number and one attachment part rides per item (S2)", async () => {
		const repeated = {
			id: "u2",
			role: "user",
			parts: [
				{ type: "text", text: "a " },
				{
					type: "data-attachment",
					data: {
						path: "/w/attachments/a.png",
						mediaType: "image/png",
						filename: "a.png",
						size: 9,
						inline: true,
					},
				},
				{ type: "text", text: " twice " },
				{
					type: "data-attachment",
					data: {
						path: "/w/attachments/a.png",
						mediaType: "image/png",
						filename: "a.png",
						size: 9,
						inline: true,
					},
				},
				{ type: "text", text: "ok" },
			],
		} as unknown as Message;
		const view = await buildModelView(skillCtx, {
			entries: entries([repeated]),
			prior: [],
			current: null,
			partial: null,
			summarySeq: null,
			assertAuthority: () => {},
		});
		expect(texts(view)).toEqual([
			"a [image 1: a.png] twice [image 1: a.png]ok",
			"[image 1: a.png]",
			"[attachment: /w/attachments/a.png — image/png, 9 bytes. Read it with read_file or bash tools.]",
		]);
	});

	test("two inline images keep first-mention numbering and materialized order (S2)", async () => {
		const twoImages = {
			id: "u-image-order",
			role: "user",
			parts: [
				{ type: "text", text: "compare " },
				{
					type: "data-attachment",
					data: {
						path: "/w/attachments/a.png",
						mediaType: "image/png",
						filename: "a.png",
						size: 3,
						inline: true,
					},
				},
				{ type: "text", text: " with " },
				{
					type: "data-attachment",
					data: {
						path: "/w/attachments/b.jpg",
						mediaType: "image/jpeg",
						filename: "b.jpg",
						size: 4,
						inline: true,
					},
				},
			],
		} as unknown as Message;
		const view = await buildModelView(skillCtx, {
			entries: entries([twoImages]),
			prior: [],
			current: null,
			partial: null,
			summarySeq: null,
			assertAuthority: () => {},
		});
		expect(texts(view)).toEqual([
			"compare [image 1: a.png] with [image 2: b.jpg]",
			"[image 1: a.png]",
			"[attachment: /w/attachments/a.png — image/png, 3 bytes. Read it with read_file or bash tools.]",
			"[image 2: b.jpg]",
			"[attachment: /w/attachments/b.jpg — image/jpeg, 4 bytes. Read it with read_file or bash tools.]",
		]);
	});

	test("a flagged message with only chips renders one fused text (S2)", async () => {
		const chipsOnly = {
			id: "u3",
			role: "user",
			parts: [
				{
					type: "data-attachment",
					data: {
						path: "/w/attachments/a.png",
						mediaType: "image/png",
						filename: "a.png",
						size: 9,
						inline: true,
					},
				},
				{
					type: "data-note",
					data: {
						id: "note-1",
						title: "Budget",
						rev: 3,
						body: "the note body",
						projectId: null,
						inline: true,
					},
				},
			],
		} as unknown as Message;
		const view = await buildModelView(skillCtx, {
			entries: entries([chipsOnly]),
			prior: [],
			current: null,
			partial: null,
			summarySeq: null,
			assertAuthority: () => {},
		});
		expect(texts(view)).toEqual([
			"[image 1: a.png][note: Budget (id note-1)]",
			"[image 1: a.png]",
			"[attachment: /w/attachments/a.png — image/png, 9 bytes. Read it with read_file or bash tools.]",
			'Attached note "Budget" (id note-1, rev 3 as of this message):\n<note id="note-1" rev="3" title="Budget">\nthe note body\n</note>',
		]);
	});

	test("a skill mentioned twice injects one body through the steer variant (S3)", async () => {
		const message = {
			id: "s9",
			role: "user",
			parts: [
				{ type: "text", text: "run " },
				{ type: "data-skill", data: { name: "deploy", inline: true } },
				{ type: "text", text: " then " },
				{ type: "data-skill", data: { name: "deploy", inline: true } },
				{ type: "text", text: " again" },
			],
		} as unknown as Message;
		const view = await convertSteeredMessage(skillCtx, message);
		const joined = texts(view).join("\n");
		expect(joined).toContain("run [skill: deploy] then [skill: deploy] again");
		expect(joined.split("SKILL BODY deploy").length - 1).toBe(1);
	});

	test("a steered flagged message mentions inline with the same labels (S3)", async () => {
		const message = {
			id: "s8",
			role: "user",
			parts: [
				{ type: "text", text: "check " },
				{
					type: "data-attachment",
					data: {
						path: "/w/attachments/a.png",
						mediaType: "image/png",
						filename: "a.png",
						size: 9,
						inline: true,
					},
				},
				{ type: "text", text: " now" },
			],
		} as unknown as Message;
		const view = await convertSteeredMessage(skillCtx, message);
		expect(texts(view)).toEqual([
			"check [image 1: a.png] now",
			"[image 1: a.png]",
			"[attachment: /w/attachments/a.png — image/png, 9 bytes. Read it with read_file or bash tools.]",
		]);
	});

	test("a loose unflagged image after inline chips rides last (S2)", async () => {
		const mixed = {
			id: "u4",
			role: "user",
			parts: [
				{ type: "text", text: "this " },
				{
					type: "data-attachment",
					data: {
						path: "/w/attachments/a.png",
						mediaType: "image/png",
						filename: "a.png",
						size: 9,
						inline: true,
					},
				},
				{ type: "text", text: " plus a loose one" },
				attachmentPart({
					path: "/w/attachments/b.png",
					mediaType: "image/png",
					filename: "b.png",
					size: 8,
				}),
			],
		} as unknown as Message;
		const view = await buildModelView(skillCtx, {
			entries: entries([mixed]),
			prior: [],
			current: null,
			partial: null,
			summarySeq: null,
			assertAuthority: () => {},
		});
		expect(texts(view)).toEqual([
			"this [image 1: a.png] plus a loose one",
			"[image 1: a.png]",
			"[attachment: /w/attachments/a.png — image/png, 9 bytes. Read it with read_file or bash tools.]",
			"[attachment: /w/attachments/b.png — image/png, 8 bytes. Read it with read_file or bash tools.]",
		]);
	});
});

describe("unfinished tool calls", () => {
	let logDir: string | null = null;
	afterEach(() => {
		setLogFile(null);
		if (logDir !== null) rmSync(logDir, { recursive: true, force: true });
		logDir = null;
	});
	const capture = (): string => {
		logDir = mkdtempSync(join(tmpdir(), "goblin-viewlog-"));
		const target = join(logDir, "goblin.log");
		setLogFile(target);
		return target;
	};
	const lines = (target: string): Record<string, unknown>[] =>
		readFileSync(target, "utf8")
			.split("\n")
			.filter((l) => l !== "")
			.map((l) => JSON.parse(l) as Record<string, unknown>);
	const historyDropMsg = "unfinished tool call in durable history — dropped from the model view";
	const partialDropMsg =
		"recovery partial ends on an unfinished tool call — dropped from the model view";

	test("a durable history call without its result is dropped and logged as a warning", async () => {
		const target = capture();
		const view = await build(
			entries([
				user("u1", "run pwd"),
				{
					id: "a1",
					role: "assistant",
					parts: [
						{ type: "text", text: "checking" },
						{
							type: "tool-bash",
							toolCallId: "t1",
							state: "input-available",
							input: { command: "pwd" },
						},
					],
				} as unknown as Message,
				user("u2", "hello?"),
			]),
		);
		expect(JSON.stringify(view)).not.toContain("tool-bash");
		expect(texts(view)).toContain("checking");
		const entry = lines(target).find((l) => l.msg === historyDropMsg);
		expect(entry).toMatchObject({ level: "warn", message: "a1", toolCalls: ["t1"] });
	});

	test("the recovery partial's dangling call drops at info — a crash mid-call is legitimate", async () => {
		const target = capture();
		const partial = {
			id: "p",
			role: "assistant",
			parts: [
				{ type: "text", text: "half an answ" },
				{
					type: "tool-bash",
					toolCallId: "t9",
					state: "input-streaming",
					input: { command: "pwd" },
				},
			],
		} as unknown as Message;
		const view = await build(
			entries([user("u1", "q"), asst("a1", "old answer")]),
			[],
			null,
			partial,
		);
		expect(JSON.stringify(view)).not.toContain("tool-bash");
		expect(texts(view)).toContain("half an answ");
		const entry = lines(target).find((l) => l.msg === partialDropMsg);
		expect(entry).toMatchObject({ level: "info", message: "p", toolCalls: ["t9"] });
		expect(lines(target).some((l) => l.level === "warn")).toBe(false);
	});

	test("a completed call+result pair converts whole and logs nothing", async () => {
		const target = capture();
		const view = await build(
			entries([
				user("u1", "run pwd"),
				{
					id: "a1",
					role: "assistant",
					parts: [
						{ type: "text", text: "checking" },
						{
							type: "tool-bash",
							toolCallId: "t1",
							state: "output-available",
							input: { command: "pwd" },
							output: "/workspace",
						},
					],
				} as unknown as Message,
			]),
		);
		const wire = JSON.stringify(view);
		expect(wire).toContain("tool-call");
		expect(wire).toContain("tool-result");
		expect(wire).toContain("/workspace");
		const dropLines = lines(target).filter(
			(l) => l.msg === historyDropMsg || l.msg === partialDropMsg,
		);
		expect(dropLines).toHaveLength(0);
	});

	test("the drop predicate matches the SDK filter — states it drops", async () => {
		const dropped: { state: string; preliminary?: boolean }[] = [
			{ state: "input-streaming" },
			{ state: "input-available" },
			{ state: "output-available", preliminary: true },
		];
		for (const s of dropped) {
			const m = {
				id: "a1",
				role: "assistant",
				parts: [
					{
						type: "tool-bash",
						toolCallId: "t1",
						state: s.state,
						preliminary: s.preliminary,
						input: { command: "pwd" },
						output: "/workspace",
					},
				],
			} as unknown as Message;
			expect(incompleteToolCallIds(m), s.state).toEqual(["t1"]);
			const wire = JSON.stringify(
				await convertToModelMessages([m], { tools: {}, ignoreIncompleteToolCalls: true }),
			);
			expect(wire.includes('"tool-call"'), s.state).toBe(false);
		}
	});

	test("the drop predicate matches the SDK filter — states it keeps", async () => {
		const kept: { state: string }[] = [{ state: "output-available" }, { state: "output-error" }];
		for (const s of kept) {
			const m = {
				id: "a1",
				role: "assistant",
				parts: [
					{
						type: "tool-bash",
						toolCallId: "t1",
						state: s.state,
						input: { command: "pwd" },
						output: "/workspace",
					},
				],
			} as unknown as Message;
			expect(incompleteToolCallIds(m), s.state).toEqual([]);
			const wire = JSON.stringify(
				await convertToModelMessages([m], { tools: {}, ignoreIncompleteToolCalls: true }),
			);
			expect(wire.includes('"tool-call"'), s.state).toBe(true);
		}
	});
});

describe("arrival stamp", () => {
	const stamped = (id: string, text: string, at: string): Message =>
		({
			id,
			role: "user",
			parts: [
				{ type: "text", text },
				{ type: "data-context", data: { at, surface: "telegram" } },
			],
		}) as Message;

	test("renders after the words, in history and when steered, byte-identically", async () => {
		const m = stamped("u1", "hi", "2026-11-06 14:32 -06:00");
		const view = await buildModelView(ctx, {
			entries: entries([m]),
			prior: [],
			current: null,
			partial: null,
			summarySeq: null,
			assertAuthority: () => {},
		});
		expect(texts(view)).toEqual(["hi", "[2026-11-06 14:32 -06:00 · telegram]"]);
		expect(await convertSteeredMessage(ctx, m)).toEqual(view);
	});

	test("an unstamped old row stays unstamped", async () => {
		const view = await buildModelView(ctx, {
			entries: entries([user("u1", "old")]),
			prior: [],
			current: null,
			partial: null,
			summarySeq: null,
			assertAuthority: () => {},
		});
		expect(texts(view)).toEqual(["old"]);
	});
});

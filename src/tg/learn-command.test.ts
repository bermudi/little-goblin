import { describe, expect, test } from "bun:test";
import type { Message } from "../message.ts";
import { fakeApi, type FakeApi } from "../testkit/fake-api.ts";
import { LEARN_PREFIX } from "../learn.ts";
import type { TurnSink } from "../turn/sink.ts";
import type { Conversation } from "../conversation-read.ts";
import { makeConversationDeliverySink } from "./turn-input.ts";
import { handleLearnCommand } from "./learn-command.ts";
import type { SkillCommandDeps } from "./skill-command.ts";

const conv = (): Conversation =>
	({
		id: "tg:1:2",
		chatId: 1,
		threadId: 2,
		title: null,
		titleImplicit: false,
		model: null,
		thinking: null,
		voice: false,
		memoryExcluded: false,
		persona: "personal",
		archivedAt: null,
		epoch: 0,
	}) as unknown as Conversation;

interface Harness {
	deps: SkillCommandDeps;
	fake: FakeApi;
	appended: Message[];
	submitted: Message[];
}

function harness(admitted = true): Harness {
	const fake = fakeApi({});
	const appended: Message[] = [];
	const submitted: Message[] = [];
	const deps: SkillCommandDeps = {
		api: fake.api as unknown as SkillCommandDeps["api"],
		store: {
			append: (_id: string, messages: Message[]) => {
				appended.push(...messages);
				return messages.map((_, i) => appended.length - messages.length + i + 1);
			},
			get: () => conv(),
		} as never,
		runtime: {
			submitPersisted: (_c: unknown, message: Message, _sink: TurnSink) => {
				// A fenced admission runs no turn — only an admitted one runs.
				if (!admitted) return false;
				submitted.push(message);
				return true;
			},
		} as never,
		delivery: (target) =>
			makeConversationDeliverySink(fake.api, target, {
				configRef: {
					current: { tts: false, operators: [1], telegram: { richReplies: false } } as never,
					ttsDown: false,
				},
				store: {
					lastReplyAnchor: () => null,
					lastEntry: () => null,
					recordDelivery: () => {},
				},
				synthesize: () => Promise.resolve([new Uint8Array([1])]),
			}),
	};
	return { deps, fake, appended, submitted };
}

const textOf = (m: Message): string =>
	(m.parts.find((p) => p.type === "text") as { text: string }).text;

describe("handleLearnCommand", () => {
	test("acks from-what-you-described and submits the builder turn", async () => {
		const h = harness();
		const handled = await handleLearnCommand(h.deps, conv(), "/learn the pdf workflow we just did");
		expect(handled).toBe(true);
		expect(h.fake.texts[0]).toBe("Learning a skill from what you described…");
		expect(textOf(h.submitted[0]!).startsWith(`${LEARN_PREFIX} `)).toBe(true);
		expect(textOf(h.submitted[0]!)).toContain("the pdf workflow we just did");
		// The turn is durable — the submitted message is the appended one.
		expect(h.appended).toEqual(h.submitted);
	});

	test("bare /learn learns from the conversation and says so", async () => {
		const h = harness();
		await handleLearnCommand(h.deps, conv(), "/learn");
		expect(h.fake.texts[0]).toBe("Learning a skill from this conversation…");
		expect(textOf(h.submitted[0]!)).toContain(
			"the workflow we just went through in this conversation",
		);
	});

	test("a fenced admission reports not-submitted and submits nothing", async () => {
		const h = harness(false);
		const handled = await handleLearnCommand(h.deps, conv(), "/learn anything");
		expect(handled).toBe(true);
		expect(h.submitted).toEqual([]);
		expect(h.fake.texts).toContain("not submitted — the turn was not admitted.");
	});
});

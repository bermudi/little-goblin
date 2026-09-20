// The scheduler's boundary contract: a due job becomes a submitted
// user turn in its pinned conversation, marked ran; a submit failure
// releases the sink and leaves the job due; nothing else fires.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import type { UIMessage } from "ai";
import { openStore } from "./conversation.ts";
import type { ConversationStore } from "./conversation.ts";
import type { Runtime, TurnSink } from "./runtime.ts";
import { openJobs } from "./jobs.ts";
import type { Config } from "./config.ts";
import { startScheduler, type SchedulerDeps } from "./scheduler.ts";

let dirs: string[] = [];
function tmpdirPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-sched-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const config: Config = {
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://api.example.com", auth: "zai" },
	},
	model: "zai/m",
	favorites: [],
	thinking: "medium",
	allowedUsers: [1],
	telegram: {},
	http: { port: 8787 },
	logLevel: "info",
};

interface Harness {
	deps: SchedulerDeps;
	submitted: Array<{ conv: string; parts: UIMessage["parts"]; sink: TurnSink }>;
	apiCalls: Array<{ method: string; text?: string }>;
	store: ConversationStore;
}

function harness(): Harness {
	const dir = tmpdirPath();
	const jobs = openJobs(join(dir, "goblin.sqlite"));
	const store = openStore(join(dir, "conv.sqlite"));
	const submitted: Harness["submitted"] = [];
	const apiCalls: Harness["apiCalls"] = [];
	const api = {
		sendMessage: (_chat: unknown, text: string) => {
			apiCalls.push({ method: "sendMessage", text });
			return Promise.resolve({ message_id: apiCalls.length });
		},
		editMessageText: (_c: unknown, _m: unknown, text: string) => {
			apiCalls.push({ method: "editMessageText", text });
			return Promise.resolve(true);
		},
		setMessageReaction: () => Promise.resolve(true),
		sendChatAction: () => Promise.resolve(true),
		sendVoice: () => Promise.resolve({ message_id: 1 }),
	} as unknown as Api;
	const deps: SchedulerDeps = {
		jobs,
		store,
		runtime: {
			submit: (conv: { id: string }, message: UIMessage, sink: TurnSink) => {
				submitted.push({ conv: conv.id, parts: message.parts, sink });
			},
		} as unknown as Runtime,
		api,
		configRef: { current: config },
		synthesize: () => Promise.resolve([]),
	};
	return { deps, submitted, apiCalls, store };
}

// Close every sink the fake runtime captured — they run typing
// intervals until onDone.
function closeSinks(h: Harness): Promise<unknown> {
	return Promise.all(h.submitted.map((s) => s.sink.onDone({ kind: "completed" })));
}

describe("scheduler", () => {
	test("a due job fires one turn into its pinned topic conversation", async () => {
		const h = harness();
		// Created 10 minutes "ago": every-minute cron → overdue = catch-up.
		const past = new Date(Date.now() - 10 * 60_000);
		const job = h.deps.jobs.create(
			{ name: "morning brief", cron: "* * * * *", prompt: "brief me on the day", address: { chatId: -100, threadId: 7 } },
			past,
		);
		startScheduler(h.deps).stop(); // the boot scan fires, then we stop the timer
		expect(h.submitted).toHaveLength(1);
		expect(h.submitted[0]!.conv).toBe("topic:-100:7");
		expect(h.submitted[0]!.parts).toEqual([
			{ type: "text", text: "[scheduled: morning brief] brief me on the day" },
		]);
		// Marked ran — not due again this minute.
		expect(h.deps.jobs.due(new Date()).map((j) => j.id)).not.toContain(job.id);
		await closeSinks(h);
	});

	test("nothing due → nothing fires", () => {
		const h = harness();
		h.deps.jobs.create(
			{ name: "x", cron: "0 4 * * *", prompt: "p", address: { chatId: 1, threadId: null } },
			new Date(),
		);
		const s = startScheduler(h.deps);
		s.tick();
		s.stop();
		expect(h.submitted).toEqual([]);
	});

	test("a disabled job never fires", () => {
		const h = harness();
		const job = h.deps.jobs.create(
			{ name: "x", cron: "* * * * *", prompt: "p", address: { chatId: 1, threadId: null } },
			new Date(Date.now() - 5 * 60_000),
		);
		h.deps.jobs.update(job.id, { enabled: false });
		const s = startScheduler(h.deps);
		s.tick();
		s.stop();
		expect(h.submitted).toEqual([]);
	});

	test("a submit failure releases the sink and leaves the job due", async () => {
		const h = harness();
		h.deps.runtime = {
			submit: (_c: unknown, _m: unknown, sink: TurnSink) => {
				throw new Error("queue closed");
			},
		} as unknown as Runtime;
		const job = h.deps.jobs.create(
			{ name: "x", cron: "* * * * *", prompt: "p", address: { chatId: 1, threadId: null } },
			new Date(Date.now() - 5 * 60_000),
		);
		const s = startScheduler(h.deps); // boot scan: submit throws
		s.stop();
		await Bun.sleep(10);
		expect(
			h.apiCalls.some((c) => c.method === "sendMessage" && c.text?.includes("queue closed")),
		).toBe(true);
		// Not marked ran — the job stays due for the next boot.
		expect(h.deps.jobs.due(new Date()).map((j) => j.id)).toContain(job.id);
	});

	test("one job's failure does not stop the scan", async () => {
		const h = harness();
		const past = new Date(Date.now() - 5 * 60_000);
		h.deps.jobs.create(
			{ name: "a", cron: "* * * * *", prompt: "p", address: { chatId: 1, threadId: null } },
			past,
		);
		h.deps.jobs.create(
			{ name: "b", cron: "* * * * *", prompt: "p", address: { chatId: 2, threadId: null } },
			past,
		);
		let calls = 0;
		h.deps.runtime = {
			submit: (_c: { id: string }, _m: UIMessage, sink: TurnSink) => {
				calls++;
				if (calls === 1) {
					// First fire explodes past the submit — the scan must
					// still reach the second job.
					void sink.onDone({ kind: "completed" });
					throw new Error("boom");
				}
				h.submitted.push({ conv: _c.id, parts: _m.parts, sink });
			},
		} as unknown as Runtime;
		const s = startScheduler(h.deps);
		s.stop();
		expect(h.submitted.map((x) => x.conv)).toEqual(["dm:2"]);
		await closeSinks(h);
	});
});

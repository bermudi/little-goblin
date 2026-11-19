import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentChildren } from "../agent-children.ts";
import type { Config } from "../config-schema.ts";
import type { AuthStore } from "../auth.ts";
import type { Conversation } from "../conversation-read.ts";
import { openStore, type ConversationStore } from "../conversation.ts";
import type { Desktops } from "../desktops.ts";
import type { T3, T3Thread } from "../t3.ts";
import { setLogFile, setLogWriter } from "../log.ts";
import type { MailApproval } from "../mail-approval.ts";
import type { NoteStore } from "../notes.ts";
import { openPrograms, type ProgramsStore } from "../programs.ts";
import { openProjects, type ProjectStore } from "../projects.ts";
import { openResponsibilities } from "../responsibilities.ts";
import { makeResponsibilityService } from "../responsibility-service.ts";
import { Runtime, userMessage } from "../runtime.ts";

import { aiSdkEngine } from "../turn/ai-sdk-engine.ts";
import { openTurnJournal } from "../turn-journal.ts";
import type { Sandboxes } from "../sandboxes.ts";
import { openWakeStore } from "../wake-store.ts";
import { finishPart, scriptedModel, textParts, toolCallPart } from "../testkit/fake-model.ts";
import { deferred, HeadlessSink, tmpDir, useHome, waitUntil } from "../testkit.ts";
import { makeWakeDispatcher, type WakeDispatcher } from "../wake-dispatcher.ts";
import { makeTurnTools, screenshotCapable } from "./turn-tools.ts";
import {
	_primeModelsDevForTest,
	_resetModelsDevForTest,
} from "./models-dev.ts";
import { policyOf } from "./tool-policy.ts";

setLogFile(null);

/** The rig's t3 adapter: lists `agents`, succeeds sends, records them. */
function fakeT3(agents: () => T3Thread[]) {
	const sends: { thread: string; message: string }[] = [];
	const t3: T3 = {
		startThread: () => Promise.reject(new Error("not used here")),
		sendThread: async (thread, message) => {
			sends.push({ thread, message });
			return {
				threadId: thread,
				link: "https://t3.example/t/sent",
				messageId: "m-9",
				runId: "run:2",
				status: "queued",
				delivery: "queued",
			};
		},
		showThread: () => Promise.reject(new Error("not used here")),
		listThreads: async () => agents(),
	};
	return { t3, sends };
}

/** The authority rigs' t3 fake: list/send may gate, sends are counted,
 *  the tool's abort signal is captured for the epoch assertions. */
function gatedT3(gates: { list?: () => Promise<void>; send?: () => Promise<void> } = {}) {
	let count = 0;
	let signal: AbortSignal | undefined;
	const t3: T3 = {
		startThread: () => Promise.reject(new Error("not used here")),
		async sendThread(thread, _message, opts) {
			signal = opts?.signal;
			await gates.send?.();
			expect(signal?.aborted ?? false).toBe(false);
			count += 1;
			return {
				threadId: thread,
				link: "https://t3.example/t/sent",
				messageId: "m-9",
				runId: "run:2",
				status: "queued",
				delivery: "queued",
			};
		},
		showThread: () => Promise.reject(new Error("not used here")),
		async listThreads() {
			await gates.list?.();
			return [AGENT];
		},
	};
	return { t3, count: () => count, signal: () => signal };
}

const T0 = "2026-11-16T10:00:00.000Z";
const AGENT: T3Thread = {
	threadId: "mcp:worker-1",
	projectId: "proj-1",
	title: "worker-1",
	link: "https://t3.example/t/worker-1",
	status: "idle",
	latestRunId: "run:1",
	itemCount: 3,
	createdAt: T0,
	updatedAt: T0,
};

const ACCEPT = JSON.stringify({
	action: "accept",
	understanding: {
		outcome: "land the fix",
		situation: "agent mid-task",
		nextAction: "check the diff",
		checkpoints: [],
		completionEvidence: ["ci green"],
	},
	attachments: [{ thread: AGENT.threadId }],
});

const AGENT2: T3Thread = {
	...AGENT,
	threadId: "mcp:worker-2",
	title: "worker-2",
};

const ACCEPT2 = JSON.stringify({
	action: "accept",
	understanding: {
		outcome: "land the second fix",
		situation: "another agent mid-task",
		nextAction: "check the other diff",
		checkpoints: [],
		completionEvidence: ["its ci green"],
	},
	attachments: [{ thread: AGENT2.threadId }],
});

describe("turn-tools responsibility composition", () => {
	function rig(attempts: Parameters<typeof scriptedModel>[0], agents: T3Thread[] = [AGENT]) {
		const home = useHome(`goblin-tt-${tmpDir().slice(-6)}-`);
		mkdirSync(join(home, "state"), { recursive: true });
		const store = openStore(join(home, "state", "goblin.sqlite"));
		const projects = openProjects(store);
		const project = projects.create({ name: "rig" });
		const conv = store.resolve(
			{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
			project.dir,
		);
		store.bindProject(conv.id, project.id);
		const resps = openResponsibilities(store.db);
		const wakes = openWakeStore(store.db);
		const programs = openPrograms(join(home, "state", "programs.sqlite"));
		const configRef = { current: {} as Config, ttsDown: false };
		const service = makeResponsibilityService({
			db: store.db,
			resps,
			wakes,
			programs,
			conversations: store,
			pump: () => {},
		});
		const toolsFor = makeTurnTools({
			configRef,
			auth: {} as unknown as AuthStore,
			store,
			projects,
			notes: {} as unknown as NoteStore,
			programs,
			sendPrivate: async () => {},
			memory: null,
			transcribe: async () => null,
			delegateDeps: () => undefined,
			t3: fakeT3(() => agents).t3,
			mail: () => ({}) as Pick<MailApproval, "requestDraft">,
			programApproval: () => undefined,
			visionDepsFor: () => undefined,
			sandboxes: {} as unknown as Sandboxes,
			desktops: () => null,
			agents: () => null,
			responsibility: () => ({ resps, service }),
			filterGuests: (_conv, tools) => tools,
		});
		const edge = scriptedModel(attempts);
		const runtime = new Runtime({
			engines: [aiSdkEngine],
			store,
			buildStep: () => ({ model: edge.model, system: "test" }),
			makeTools: toolsFor,
		});
		return { store, conv, project, resps, runtime, toolsFor, configRef };
	}

	test("warns when a parent turn builds before configured owners bind", () => {
		const f = rig([]);
		f.configRef.current = { desktops: {} } as Config;
		const records: Record<string, unknown>[] = [];
		setLogFile("/fixture/goblin.log");
		setLogWriter((_path, line) => {
			records.push(JSON.parse(line.trim()) as Record<string, unknown>);
		});
		try {
			f.toolsFor(f.conv);
			const warnings = records.filter((record) => record.msg === "turn tools built before owner bound");
			expect(warnings).toEqual([
				expect.objectContaining({
					conversation: f.conv.id,
					missing: ["desktop", "agent"],
				}),
			]);
		} finally {
			setLogWriter(null);
			setLogFile(null);
			f.store.close();
		}
	});

	test("accepts dedup on the owned source message; a later message hands over a new responsibility", async () => {
		const { store, conv, project, resps, runtime } = rig([
			[
				toolCallPart("a1", "responsibility", ACCEPT),
				toolCallPart("a2", "responsibility", ACCEPT),
				finishPart("tool-calls"),
			],
			[...textParts("taken"), finishPart("stop", 10)],
			[toolCallPart("b1", "responsibility", ACCEPT), finishPart("tool-calls")],
			[...textParts("also taken"), finishPart("stop", 10)],
		]);
		const msg1 = userMessage([{ type: "text", text: "handle this one" }]);
		const first = new HeadlessSink();
		runtime.submit(conv, msg1, first);
		expect(await first.done).toEqual({ kind: "completed" });
		await waitUntil(() => resps.forProject(project.id).length === 1, "accept lands");
		const all = resps.forProject(project.id);
		expect(all).toHaveLength(1);
		const seq1 = store.lastUserSeq(conv.id);
		expect(all[0]!.handoverKey).toBe(`handover:${conv.id}:seq:${seq1}`);
		expect(resps.attachmentsFor(all[0]!.responsibilityId)).toHaveLength(1);

		resps.setStatus(all[0]!.responsibilityId, "completed");
		const msg2 = userMessage([{ type: "text", text: "and this one" }]);
		const second = new HeadlessSink();
		runtime.submit(conv, msg2, second);
		expect(await second.done).toEqual({ kind: "completed" });
		await waitUntil(() => resps.forProject(project.id).length === 2, "second handover");
		const after = resps.forProject(project.id);
		expect(after).toHaveLength(2);
		const keys = after.map((x) => x.handoverKey);
		const seq2 = store.lastUserSeq(conv.id);
		expect(seq2).not.toBe(seq1);
		expect(keys).toContain(`handover:${conv.id}:seq:${seq1}`);
		expect(keys).toContain(`handover:${conv.id}:seq:${seq2}`);
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		store.close();
	});

	test("two events with one client message id still get distinct handover keys", async () => {
		const { store, conv, project, resps, runtime } = rig(
			[
				[toolCallPart("a1", "responsibility", ACCEPT), finishPart("tool-calls")],
				[...textParts("taken"), finishPart("stop", 10)],
				[toolCallPart("b1", "responsibility", ACCEPT2), finishPart("tool-calls")],
				[...textParts("also taken"), finishPart("stop", 10)],
			],
			[AGENT, AGENT2],
		);
		const msg = (text: string): ReturnType<typeof userMessage> => ({
			id: "dup",
			role: "user",
			parts: [{ type: "text", text }],
		});
		const first = new HeadlessSink();
		runtime.submit(conv, msg("handle this one"), first);
		expect(await first.done).toEqual({ kind: "completed" });
		const seq1 = store.lastUserSeq(conv.id);
		await waitUntil(() => resps.forProject(project.id).length === 1, "accept lands");

		resps.setStatus(resps.forProject(project.id)[0]!.responsibilityId, "completed");
		const second = new HeadlessSink();
		runtime.submit(conv, msg("and this one"), second);
		expect(await second.done).toEqual({ kind: "completed" });
		const seq2 = store.lastUserSeq(conv.id);
		await waitUntil(() => resps.forProject(project.id).length === 2, "second handover");
		const rows = resps.forProject(project.id);
		const keys = rows.map((x) => x.handoverKey);
		expect(seq2).not.toBe(seq1);
		expect(keys).toContain(`handover:${conv.id}:seq:${seq1}`);
		expect(keys).toContain(`handover:${conv.id}:seq:${seq2}`);
		const byKey = new Map(rows.map((x) => [x.handoverKey, x]));
		const firstRow = byKey.get(`handover:${conv.id}:seq:${seq1}`)!;
		const secondRow = byKey.get(`handover:${conv.id}:seq:${seq2}`)!;
		expect(firstRow.understanding.outcome).toBe("land the fix");
		expect(secondRow.understanding.outcome).toBe("land the second fix");
		expect(
			resps.attachmentsFor(firstRow.responsibilityId).map((a) => a.target.agentSession),
		).toEqual([AGENT.threadId]);
		expect(
			resps.attachmentsFor(secondRow.responsibilityId).map((a) => a.target.agentSession),
		).toEqual([AGENT2.threadId]);
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		store.close();
	});
});

describe("turn-tools managed send linkage", () => {
	test("a send stamps the journal run and tool-call identity on its operation", async () => {
		const home = useHome(`goblin-tt2-${tmpDir().slice(-6)}-`);
		mkdirSync(join(home, "state"), { recursive: true });
		const store = openStore(join(home, "state", "goblin.sqlite"));
		const projects = openProjects(store);
		const project = projects.create({ name: "rig" });
		const conv = store.resolve(
			{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
			project.dir,
		);
		store.bindProject(conv.id, project.id);
		const resps = openResponsibilities(store.db);
		const wakes = openWakeStore(store.db);
		const programs = openPrograms(join(home, "state", "programs.sqlite"));
		const journal = openTurnJournal(store.db);
		const service = makeResponsibilityService({
			db: store.db,
			resps,
			wakes,
			programs,
			conversations: store,
			pump: () => {},
		});
		const t3edge = fakeT3(() => [AGENT]);
		const toolsFor = makeTurnTools({
			configRef: { current: {} as Config, ttsDown: false },
			auth: {} as unknown as AuthStore,
			store,
			projects,
			notes: {} as unknown as NoteStore,
			programs,
			sendPrivate: async () => {},
			memory: null,
			transcribe: async () => null,
			delegateDeps: () => undefined,
			t3: t3edge.t3,
			mail: () => ({}) as Pick<MailApproval, "requestDraft">,
			programApproval: () => undefined,
			visionDepsFor: () => undefined,
			sandboxes: {} as unknown as Sandboxes,
			desktops: () => null,
			agents: () => null,
			responsibility: () => ({ resps, service }),
			filterGuests: (_conv, tools) => tools,
		});
		const SEND = JSON.stringify({ action: "send", attachment: 1, brief: "follow up" });
		const edge = scriptedModel([
			[toolCallPart("a1", "responsibility", ACCEPT), finishPart("tool-calls")],
			[...textParts("taken"), finishPart("stop", 10)],
			[toolCallPart("b1", "responsibility", SEND), finishPart("tool-calls")],
			[...textParts("sent"), finishPart("stop", 10)],
		]);
		const runtime = new Runtime({
			engines: [aiSdkEngine],
			store,
			turnJournal: journal,
			buildStep: () => ({ model: edge.model, system: "test" }),
			makeTools: toolsFor,
		});
		const first = new HeadlessSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "take this" }]), first);
		expect(await first.done).toEqual({ kind: "completed" });
		const second = new HeadlessSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "now send" }]), second);
		expect(await second.done).toEqual({ kind: "completed" });
		await waitUntil(
			() => resps.operationsFor(resps.forProject(project.id)[0]!.responsibilityId).length === 1,
			"op recorded",
		);
		const op = resps.operationsFor(resps.forProject(project.id)[0]!.responsibilityId)[0]!;
		expect(op.state).toBe("acknowledged");
		expect(op.toolCallId).toBe("b1");
		expect(op.journalRunId).not.toBeNull();
		const run = journal.get(op.journalRunId!);
		expect(run).not.toBeNull();
		expect(run!.conversationId).toBe(conv.id);
		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		store.close();
	});
});

describe("responsibility epoch authority", () => {
	test.each(["accept", "send"] as const)(
		"epoch revocation while %s is in flight fences the turn without aborting the tool signal",
		async (action) => {
			const home = useHome(`goblin-tt-epoch-${tmpDir().slice(-6)}-`);
			mkdirSync(join(home, "state"), { recursive: true });
			const store = openStore(join(home, "state", "goblin.sqlite"));
			const projects = openProjects(store);
			const project = projects.create({ name: "epoch" });
			const conv = store.resolve(
				{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
				project.dir,
			);
			store.bindProject(conv.id, project.id);
			const resps = openResponsibilities(store.db);
			const programs = openPrograms(join(home, "state", "programs.sqlite"));
			const service = makeResponsibilityService({
				db: store.db,
				resps,
				wakes: openWakeStore(store.db),
				programs,
				conversations: store,
				pump: () => {},
			});
			let entered = false;
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			// `accept` resolves its thread targets through the list; `send`
			// gates on the wire itself.
			const gate3 = () => (entered = true, gate);
			const edge3 = gatedT3(
				action === "accept" ? { list: gate3 } : { send: gate3 },
			);
			const toolsFor = makeTurnTools({
				configRef: { current: {} as Config, ttsDown: false },
				auth: {} as unknown as AuthStore,
				store,
				projects,
				notes: {} as unknown as NoteStore,
				programs,
				sendPrivate: async () => {},
				memory: null,
				transcribe: async () => null,
				delegateDeps: () => undefined,
				t3: edge3.t3,
				mail: () => ({}) as Pick<MailApproval, "requestDraft">,
				programApproval: () => undefined,
				visionDepsFor: () => undefined,
				sandboxes: {} as unknown as Sandboxes,
				desktops: () => null,
				agents: () => null,
				responsibility: () => ({ resps, service }),
				filterGuests: (_conv, tools) => tools,
			});
			const edge = scriptedModel([
				[toolCallPart("accept", "responsibility", ACCEPT), finishPart("tool-calls")],
				[...textParts("taken"), finishPart("stop", 10)],
				[
					toolCallPart(
						"send",
						"responsibility",
						JSON.stringify({ action: "send", attachment: 1, brief: "follow up" }),
					),
					finishPart("tool-calls"),
				],
				[...textParts("sent"), finishPart("stop", 10)],
			]);
			const runtime = new Runtime({
				engines: [aiSdkEngine],
				store,
				buildStep: () => ({ model: edge.model, system: "test" }),
				makeTools: toolsFor,
			});
			if (action === "send") {
				const first = new HeadlessSink();
				runtime.submit(conv, userMessage([{ type: "text", text: "take over" }]), first);
				expect(await first.done).toEqual({ kind: "completed" });
			}
			const sink = new HeadlessSink();
			runtime.submit(conv, userMessage([{ type: "text", text: action }]), sink);
			await waitUntil(() => entered, "in-flight entered");
			store.bumpEpoch(conv.id);
			expect(edge3.signal()?.aborted ?? false).toBe(false);
			release();
			expect(await sink.done).toEqual({ kind: "fenced" });
			if (action === "accept") {
				// Target discovery was still resolving — nothing was created.
				expect(edge3.count()).toBe(0);
				expect(resps.forProject(project.id)).toHaveLength(0);
			} else {
				// The t3 edge checks authority synchronously at the wire's
				// edge, right before the CLI runs — a bump concurrent with
				// the call itself is past the refusal point. The message
				// lands (honestly recorded); the turn fences, so the model
				// never banks the result and the correction wake re-decides.
				expect(edge3.count()).toBe(1);
				const [resp] = resps.forProject(project.id);
				expect(resp).toBeDefined();
				const ops = resps.operationsFor(resp!.responsibilityId);
				expect(ops).toHaveLength(1);
				expect(ops[0]!.state).toBe("acknowledged");
			}
			await waitUntil(() => !runtime.busy(conv.id), "fenced lane drains");
			programs.close();
			store.close();
		},
	);
});

describe("operator correction authority", () => {
	test("a correction landing while the model stream is gated fences the stale send it precedes", async () => {
		const home = useHome(`goblin-tt-corr-${tmpDir().slice(-6)}-`);
		mkdirSync(join(home, "state"), { recursive: true });
		const store = openStore(join(home, "state", "goblin.sqlite"));
		const projects = openProjects(store);
		const project = projects.create({ name: "rig" });
		const conv = store.resolve(
			{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
			project.dir,
		);
		store.bindProject(conv.id, project.id);
		const resps = openResponsibilities(store.db);
		const wakes = openWakeStore(store.db);
		const programs = openPrograms(join(home, "state", "programs.sqlite"));
		const journal = openTurnJournal(store.db);
		// No handover wake — the responsibility + attachment are staged
		// directly, exactly as an already-accepted project looks.
		const { responsibility } = resps.create({
			projectId: project.id,
			coordinationConversationId: conv.id,
			handoverKey: "hk:corr",
			understanding: {
				outcome: "o",
				situation: "s",
				nextAction: "n",
				checkpoints: [],
				completionEvidence: [],
			},
		});
		const att = resps.attach({
			responsibilityId: responsibility.responsibilityId,
			// The t3 shape the accept path binds: the thread id is the
			// identity, the project is the session.
			target: {
				server: "t3",
				session: AGENT.projectId,
				agentName: AGENT.threadId,
				paneId: null,
				terminalId: null,
				agentSession: AGENT.threadId,
				kind: AGENT.providerInstanceId ?? "codex",
				cwd: "/w",
			},
			baseline: {},
		});
		let dispatcher!: WakeDispatcher;
		let runtime!: Runtime;
		const settlements: Promise<void>[] = [];
		const t3fake = fakeT3(() => [AGENT]);
		const service = makeResponsibilityService({
			db: store.db,
			resps,
			wakes,
			programs,
			conversations: store,
			pump: () => dispatcher.pump(),
			onCorrectionCommitted: (convId, epoch) => {
				settlements.push(runtime.cancelFenced(convId, epoch).settled);
			},
		});
		const toolsFor = makeTurnTools({
			configRef: { current: {} as Config, ttsDown: false },
			auth: {} as unknown as AuthStore,
			store,
			projects,
			notes: {} as unknown as NoteStore,
			programs,
			sendPrivate: async () => {},
			memory: null,
			transcribe: async () => null,
			delegateDeps: () => undefined,
			t3: t3fake.t3,
			mail: () => ({}) as Pick<MailApproval, "requestDraft">,
			programApproval: () => undefined,
			visionDepsFor: () => undefined,
			sandboxes: {} as unknown as Sandboxes,
			desktops: () => null,
			agents: () => null,
			responsibility: () => ({ resps, service }),
			filterGuests: (_conv, tools) => tools,
		});
		const STALE_SEND = JSON.stringify({
			action: "send",
			responsibility: responsibility.responsibilityId,
			attachment: att.attachmentId,
			brief: "OLD-ACTION",
		});
		const FRESH_SEND = JSON.stringify({
			action: "send",
			responsibility: responsibility.responsibilityId,
			attachment: att.attachmentId,
			brief: "NEW-ACTION",
		});
		const started = deferred<void>();
		const release = deferred<void>();
		const edge = scriptedModel(
			[
				{
					drive: async (ctx) => {
						started.resolve();
						await release.promise;
						ctx.enqueue(toolCallPart("stale-send", "responsibility", STALE_SEND));
						ctx.enqueue(finishPart("tool-calls"));
						ctx.close();
					},
				},
				textParts("corrected course"),
				[toolCallPart("s1", "responsibility", FRESH_SEND), finishPart("tool-calls")],
				textParts("sent it"),
			],
			{ extra: textParts("done") },
		);
		runtime = new Runtime({
			engines: [aiSdkEngine],
			store,
			turnJournal: journal,
			buildStep: () => ({ model: edge.model, system: "test" }),
			makeTools: toolsFor,
			runOwnership: {
				begin: (e) => dispatcher.hooks.begin(e),
				members: (r, c, s) => dispatcher.hooks.members(r, c, s),
				end: (r, s, d) => dispatcher.hooks.end(r, s, d),
			},
		});
		dispatcher = makeWakeDispatcher({
			store,
			wakes,
			journal,
			runtime,
			sinkFor: () => new HeadlessSink(),
		});

		const sink = new HeadlessSink();
		const epochBefore = store.get(conv.id)!.epoch;
		runtime.submit(conv, userMessage([{ type: "text", text: "perform OLD-ACTION" }]), sink);
		await started.promise;

		// The operator's correction lands while the model's send decision
		// is still gated in the pipe — before any operation row exists.
		const revised = service.correct(responsibility.responsibilityId, {
			text: "Do not perform OLD-ACTION; change the approach",
		});
		expect(revised.revision).toBe(2);
		expect(store.get(conv.id)!.epoch).toBe(epochBefore + 1);
		release.resolve();
		expect(await sink.done).toEqual({ kind: "fenced" });
		expect(settlements).toHaveLength(1);
		await expect(Promise.all(settlements)).resolves.toBeDefined();
		// The stale send never reached the wire — no operation was ever minted.
		expect(t3fake.sends).toHaveLength(0);
		expect(resps.operationsFor(responsibility.responsibilityId)).toHaveLength(0);

		// The correction wake is processed by a fresh authoritative turn.
		await waitUntil(
			() =>
				store.db
					.query<{ state: string }, []>("SELECT state FROM wake_deliveries")
					.all()
					.every((w) => w.state === "settled"),
			"correction wake settled",
		);
		const wake = store.db
			.query<{ run_id: string | null }, []>("SELECT run_id FROM wake_deliveries")
			.get()!;
		expect(journal.get(wake.run_id!)?.status).toBe("completed");
		expect(
			edge.streamCalls.some((c) => JSON.stringify(c.prompt).includes("Do not perform OLD-ACTION")),
		).toBe(true);

		// A genuinely new send under the corrected revision still works.
		const sink2 = new HeadlessSink();
		runtime.submit(conv, userMessage([{ type: "text", text: "now send it" }]), sink2);
		expect(await sink2.done).toEqual({ kind: "completed" });
		expect(t3fake.sends).toHaveLength(1);
		const ops = resps.operationsFor(responsibility.responsibilityId);
		expect(ops).toHaveLength(1);
		expect(ops[0]!.state).toBe("acknowledged");
		expect(ops[0]!.responsibilityRevision).toBe(2);

		await waitUntil(() => !runtime.busy(conv.id), "lane drains");
		await runtime.shutdown();
		programs.close();
		store.close();
	});
});

test("a correction fences a stale send gated in ANOTHER bound conversation", async () => {
	const home = useHome(`goblin-tt-corr2-${tmpDir().slice(-6)}-`);
	mkdirSync(join(home, "state"), { recursive: true });
	const store = openStore(join(home, "state", "goblin.sqlite"));
	const projects = openProjects(store);
	const project = projects.create({ name: "rig" });
	const conv = store.resolve(
		{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
		project.dir,
	);
	store.bindProject(conv.id, project.id);
	// A second lane bound to the same project — it reaches the same
	// coordination tools, so the correction must fence it too.
	const conv2 = store.resolve(
		{ kind: "app", appId: `${project.slug}-2`, chatId: 0, threadId: 0 },
		project.dir,
	);
	store.bindProject(conv2.id, project.id);
	const resps = openResponsibilities(store.db);
	const wakes = openWakeStore(store.db);
	const programs = openPrograms(join(home, "state", "programs.sqlite"));
	const journal = openTurnJournal(store.db);
	const { responsibility } = resps.create({
		projectId: project.id,
		coordinationConversationId: conv.id,
		handoverKey: "hk:corr2",
		understanding: {
			outcome: "o",
			situation: "s",
			nextAction: "n",
			checkpoints: [],
			completionEvidence: [],
		},
	});
	const att = resps.attach({
		responsibilityId: responsibility.responsibilityId,
		target: {
			server: "local",
			session: "default",
			agentName: "worker-1",
			paneId: "w1:p1",
			terminalId: "term-9",
			agentSession: "sess-1",
			kind: "pi",
			cwd: "/w",
		},
		baseline: {},
	});
	let dispatcher!: WakeDispatcher;
	let runtime!: Runtime;
	const settlements: Promise<void>[] = [];
	const t3fake = fakeT3(() => [AGENT]);
	const service = makeResponsibilityService({
		db: store.db,
		resps,
		wakes,
		programs,
		conversations: store,
		pump: () => dispatcher.pump(),
		onCorrectionCommitted: (convId, epoch) => {
			settlements.push(runtime.cancelFenced(convId, epoch).settled);
		},
	});
	const toolsFor = makeTurnTools({
		configRef: { current: {} as Config, ttsDown: false },
		auth: {} as unknown as AuthStore,
		store,
		projects,
		notes: {} as unknown as NoteStore,
		programs,
		sendPrivate: async () => {},
		memory: null,
		transcribe: async () => null,
		delegateDeps: () => undefined,
		t3: t3fake.t3,
		mail: () => ({}) as Pick<MailApproval, "requestDraft">,
		programApproval: () => undefined,
		visionDepsFor: () => undefined,
		sandboxes: {} as unknown as Sandboxes,
		desktops: () => null,
		agents: () => null,
		responsibility: () => ({ resps, service, listFor: async () => [AGENT] }),
		filterGuests: (_conv, tools) => tools,
	});
	const STALE_SEND = JSON.stringify({
		action: "send",
		responsibility: responsibility.responsibilityId,
		attachment: att.attachmentId,
		brief: "OLD-ACTION",
	});
	const started = deferred<void>();
	const release = deferred<void>();
	const edge = scriptedModel(
		[
			{
				drive: async (ctx) => {
					started.resolve();
					await release.promise;
					ctx.enqueue(toolCallPart("stale-send", "responsibility", STALE_SEND));
					ctx.enqueue(finishPart("tool-calls"));
					ctx.close();
				},
			},
			textParts("corrected course"),
		],
		{ extra: textParts("done") },
	);
	runtime = new Runtime({
		engines: [aiSdkEngine],
		store,
		turnJournal: journal,
		buildStep: () => ({ model: edge.model, system: "test" }),
		makeTools: toolsFor,
		runOwnership: {
			begin: (e) => dispatcher.hooks.begin(e),
			members: (r, c, s) => dispatcher.hooks.members(r, c, s),
			end: (r, s, d) => dispatcher.hooks.end(r, s, d),
		},
	});
	dispatcher = makeWakeDispatcher({
		store,
		wakes,
		journal,
		runtime,
		sinkFor: () => new HeadlessSink(),
	});

	const before1 = store.get(conv.id)!.epoch;
	const before2 = store.get(conv2.id)!.epoch;
	// The stale send lives in the NON-coordinator lane.
	const sink = new HeadlessSink();
	runtime.submit(conv2, userMessage([{ type: "text", text: "perform OLD-ACTION" }]), sink);
	await started.promise;
	service.correct(responsibility.responsibilityId, {
		text: "Do not perform OLD-ACTION; change the approach",
	});
	expect(store.get(conv.id)!.epoch).toBe(before1 + 1);
	expect(store.get(conv2.id)!.epoch).toBe(before2 + 1);
	release.resolve();
	expect(await sink.done).toEqual({ kind: "fenced" });
	expect(settlements).toHaveLength(2);
	await expect(Promise.all(settlements)).resolves.toBeDefined();
	expect(t3fake.sends).toHaveLength(0);
	expect(resps.operationsFor(responsibility.responsibilityId)).toHaveLength(0);
	// The correction wake still lands once, on the coordinator's lane.
	await waitUntil(
		() =>
			store.db
				.query<{ state: string }, []>("SELECT state FROM wake_deliveries")
				.all()
				.every((w) => w.state === "settled"),
		"correction wake settled",
	);
	expect(
		edge.streamCalls.some((c) => JSON.stringify(c.prompt).includes("Do not perform OLD-ACTION")),
	).toBe(true);
	await waitUntil(() => !runtime.busy(conv.id) && !runtime.busy(conv2.id), "lanes drain");
	await runtime.shutdown();
	programs.close();
	store.close();
});

describe("hosted web_search mount", () => {
	const cfgFor = (webSearch: "off" | "cached" | "live") =>
		({
			providers: {
				codex: { kind: "codex", webSearch },
				zai: { kind: "openai-compatible", baseUrl: "https://api.z.ai/x", auth: "zai" },
			},
			search: [{ kind: "ddg" }],
		}) as unknown as Config;

	const rigTools = (config: Config, conv: Conversation) =>
		makeTurnTools({
			configRef: { current: config, ttsDown: false },
			auth: {} as unknown as AuthStore,
			store: {} as unknown as ConversationStore,
			projects: {} as unknown as ProjectStore,
			notes: {} as unknown as NoteStore,
			programs: {} as unknown as ProgramsStore,
			memory: null,
			transcribe: async () => null,
			delegateDeps: () => undefined,
			t3: fakeT3(() => []).t3,
			mail: () => ({}) as never,
			programApproval: () => undefined,
			visionDepsFor: () => undefined,
			sandboxes: {} as unknown as Sandboxes,
			desktops: () => null,
			agents: () => null,
			responsibility: () => null,
			filterGuests: (_c, t) => t,
		});

	const conv = (model: string) =>
		({ id: "dm:1", model, projectId: null, persona: "operator", agentType: null }) as unknown as Conversation;

	test("codex+live/cached mounts web_search, search absent; off and non-codex keep local search", () => {
		for (const mode of ["live", "cached"] as const) {
			const t = rigTools(cfgFor(mode), conv("codex/gpt-6.1-sol"))(conv("codex/gpt-6.1-sol"));
			expect("web_search" in t).toBe(true);
			expect("search" in t).toBe(false);
		}
		const off = rigTools(cfgFor("off"), conv("codex/gpt-6.1-sol"))(conv("codex/gpt-6.1-sol"));
		expect("web_search" in off).toBe(false);
		expect("search" in off).toBe(true);
		const other = rigTools(cfgFor("live"), conv("zai/glm-5.3"))(conv("zai/glm-5.3"));
		expect("web_search" in other).toBe(false);
		expect("search" in other).toBe(true);
	});

	test("guests keep web_search exactly like local search", () => {
		expect(policyOf("web_search").guestSandbox).toBe(true);
		expect(policyOf("search").guestSandbox).toBe(true);
	});
});

describe("agent tool mount", () => {
	const parentConv = {
		id: "dm:1",
		model: null,
		projectId: null,
		persona: "operator",
		agentType: null,
	} as unknown as Conversation;
	const childConv = {
		id: "app/agent-1",
		model: "a/b",
		projectId: null,
		persona: "operator",
		agentType: "general",
	} as unknown as Conversation;

	const rigTools = (engine: AgentChildren | null) =>
		makeTurnTools({
			configRef: { current: {} as Config, ttsDown: false },
			auth: {} as unknown as AuthStore,
			store: {} as unknown as ConversationStore,
			projects: {} as unknown as ProjectStore,
			notes: {} as unknown as NoteStore,
			programs: {} as unknown as ProgramsStore,
			memory: null,
			transcribe: async () => null,
			delegateDeps: () => undefined,
			t3: {} as unknown as T3,
			mail: () => ({}) as never,
			programApproval: () => undefined,
			visionDepsFor: () => undefined,
			sandboxes: {} as unknown as Sandboxes,
			desktops: () => null,
			agents: () => engine,
			responsibility: () => null,
			filterGuests: (_c, t) => t,
		});

	test("no engine: the agent tool never mounts", () => {
		expect("agent" in rigTools(null)(parentConv)).toBe(false);
	});

	test("a parent turn mounts the agent tool listing the types", () => {
		const tools = rigTools({} as unknown as AgentChildren)(parentConv);
		expect("agent" in tools).toBe(true);
		const tool = "agent" in tools ? tools.agent : undefined;
		expect(tool && "description" in tool && tool.description).toContain("- general:");
	});

	test("a child turn gets only its spawn-time allowlist — never agent itself", () => {
		const engine = {
			allowlistFor: (id: string) => (id === "app/agent-1" ? ["read_file", "bash"] : null),
			desktopFor: () => null,
		} as unknown as AgentChildren;
		const tools = rigTools(engine)(childConv);
		const names = Object.keys(tools);
		expect(names).toContain("read_file");
		expect(names).toContain("bash");
		for (const banned of ["agent", "delegate", "speak", "memory_search", "note", "ui"]) {
			expect(names).not.toContain(banned);
		}
	});

	test("a child with no registry row fails loud", () => {
		const engine = { allowlistFor: () => null, desktopFor: () => null } as unknown as AgentChildren;
		expect(() => rigTools(engine)(childConv)).toThrow(/no registry row/);
	});
});

describe("computer child mount", () => {
	const computerConv = {
		id: "app/agent-2",
		model: "a/b",
		projectId: null,
		persona: "operator",
		agentType: "computer",
	} as unknown as Conversation;
	const parentConv = {
		id: "dm:1",
		model: null,
		projectId: null,
		persona: "operator",
		agentType: null,
	} as unknown as Conversation;
	const desktopsStub = {} as unknown as Desktops;

	const rigTools = (engine: AgentChildren | null, desktops: Desktops | null) =>
		makeTurnTools({
			// providers:{} — the model's provider is unconfigured, so the
			// screenshot capability gate fails closed (issue #606).
			configRef: { current: { providers: {} } as Config, ttsDown: false },
			auth: {} as unknown as AuthStore,
			store: {} as unknown as ConversationStore,
			projects: {} as unknown as ProjectStore,
			notes: {} as unknown as NoteStore,
			programs: {} as unknown as ProgramsStore,
			memory: null,
			transcribe: async () => null,
			delegateDeps: () => undefined,
			t3: {} as unknown as T3,
			mail: () => ({}) as never,
			programApproval: () => undefined,
			visionDepsFor: () => undefined,
			sandboxes: {} as unknown as Sandboxes,
			desktops: () => desktops,
			agents: () => engine,
			responsibility: () => null,
			filterGuests: (_c, t) => t,
		});

	const computerEngine = (desktop: string | null) =>
		({
			// The real computer type's allowlist now names screenshot;
			// the capability gate — not the allowlist — decides mounting.
			allowlistFor: (id: string) =>
				id === "app/agent-2"
					? ["inspect", "act", "launch", "screenshot", "ask_operator"]
					: null,
			desktopFor: (id: string) => (id === "app/agent-2" ? desktop : null),
		}) as unknown as AgentChildren;

	test("a computer child mounts the desktop tools and ask_operator — never agent or desktop", () => {
		const tools = rigTools(computerEngine("desk"), desktopsStub)(computerConv);
		const names = Object.keys(tools);
		for (const name of ["inspect", "act", "launch", "ask_operator"]) {
			expect(names).toContain(name);
		}
		// Allowlisted but gate-blocked: no configured provider carries
		// image tool results for this model, so screenshot stays absent.
		expect(names).not.toContain("screenshot");
		for (const banned of ["agent", "delegate", "desktop", "subagent", "speak", "ui"]) {
			expect(names).not.toContain(banned);
		}
	});

	test("a parent turn never mounts the computer tools", () => {
		const tools = rigTools(computerEngine("desk"), desktopsStub)(parentConv);
		const names = Object.keys(tools);
		for (const name of ["inspect", "act", "launch", "ask_operator"]) {
			expect(names).not.toContain(name);
		}
		expect(names).toContain("agent");
	});

	test("a computer child with no bound desktop mounts none of them", () => {
		const tools = rigTools(computerEngine(null), desktopsStub)(computerConv);
		const names = Object.keys(tools);
		for (const name of ["inspect", "act", "launch"]) {
			expect(names).not.toContain(name);
		}
		// ask_operator is not desktop-bound — it still mounts.
		expect(names).toContain("ask_operator");
	});
});

describe("screenshotCapable — issue #606 mount gate", () => {
	// The tool mounts only when the model takes image input AND the
	// provider pipe carries image tool results. Either failure means the
	// tool is absent, never erroring. The catalog and config share the
	// provider names the model refs use.
	const conv = (model: string | null) => ({ model }) as Conversation;
	const cfg = {
		providers: {
			or: { kind: "openrouter", auth: "x" },
			oai: { kind: "openai-compatible", baseUrl: "https://x.test", auth: "x" },
			cx: { kind: "codex" },
			cc: { kind: "claude-code", auth: "x" },
		},
	} as unknown as Config;
	const models = (input: string[]) => ({ modalities: { input } });
	const primeAll = () =>
		_primeModelsDevForTest({
			or: { models: { seer: models(["text", "image"]), blind: models(["text"]) } },
			oai: { models: { seer: models(["text", "image"]) } },
			cx: { models: { seer: models(["text", "image"]) } },
			cc: { models: { seer: models(["text", "image"]) } },
		});

	test("image model + image-capable pipe mounts; every other combo does not", () => {
		try {
			primeAll();
			expect(screenshotCapable(conv("or/seer"), cfg)).toBe(true);
			expect(screenshotCapable(conv("cc/seer"), cfg)).toBe(true);
			// openai-compatible stringifies tool results — never.
			expect(screenshotCapable(conv("oai/seer"), cfg)).toBe(false);
			// codex runs the stock Responses model — tool results carry images (#731).
			expect(screenshotCapable(conv("cx/seer"), cfg)).toBe(true);
			// Text-only model — never, even on a carrying pipe.
			expect(screenshotCapable(conv("or/blind"), cfg)).toBe(false);
			// No model, unknown provider, unknown model — never.
			expect(screenshotCapable(conv(null), cfg)).toBe(false);
			expect(screenshotCapable(conv("ghost/seer"), cfg)).toBe(false);
			expect(screenshotCapable(conv("or/ghost"), cfg)).toBe(false);
		} finally {
			_resetModelsDevForTest();
		}
	});

	test("a cold catalog is conservative: the tool stays absent", () => {
		_resetModelsDevForTest();
		expect(screenshotCapable(conv("or/seer"), cfg)).toBe(false);
	});
});

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { AuthStore } from "../auth.ts";
import { openStore } from "../conversation.ts";
import type { OperatorAgent, OperatorHerdr } from "../herdr.ts";
import { setLogFile } from "../log.ts";
import type { MailApproval } from "../mail-approval.ts";
import type { NoteStore } from "../notes.ts";
import { openPrograms } from "../programs.ts";
import { openProjects } from "../projects.ts";
import { openResponsibilities } from "../responsibilities.ts";
import { makeResponsibilityService } from "../responsibility-service.ts";
import { Runtime, userMessage } from "../runtime.ts";
import { openTurnJournal } from "../turn-journal.ts";
import type { Sandboxes } from "../sandboxes.ts";
import { openWakeStore } from "../wake-store.ts";
import { finishPart, scriptedModel, textParts, toolCallPart } from "../testkit/fake-model.ts";
import { deferred, HeadlessSink, tmpDir, useHome, waitUntil } from "../testkit.ts";
import { makeWakeDispatcher, type WakeDispatcher } from "../wake-dispatcher.ts";
import { makeTurnTools } from "./turn-tools.ts";

setLogFile(null);

const AGENT: OperatorAgent = {
	pane_id: "w1:p1",
	workspace_id: "w1",
	tab_id: "w1:t1",
	agent: "pi",
	agent_status: "idle",
	name: "worker-1",
	cwd: "/w",
	terminal_title: null,
	workspace_label: null,
	tab_label: null,
	terminal_id: "term-9",
	agent_session: "sess-1",
	state_change_seq: 1,
	completion_seq: null,
	revision: 1,
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
	attachments: [{ pane: "w1:p1" }],
});

describe("turn-tools responsibility composition", () => {
	test("accepts dedup on the owned source message; a later message hands over a new responsibility", async () => {
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
		const service = makeResponsibilityService({
			db: store.db,
			resps,
			wakes,
			programs,
			conversations: store,
			pump: () => {},
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
			operatorHerdr: { list: async () => [AGENT] } as unknown as OperatorHerdr,
			mail: () => ({}) as Pick<MailApproval, "requestDraft">,
			programApproval: () => undefined,
			visionDepsFor: () => undefined,
			sandboxes: {} as unknown as Sandboxes,
			subagents: () => null,
			desktops: () => null,
			subagentsBoot: () => undefined,
			responsibility: () => ({ resps, service, listFor: async () => [AGENT] }),
			filterGuests: (_conv, tools) => tools,
		});
		const edge = scriptedModel([
			[
				toolCallPart("a1", "responsibility", ACCEPT),
				toolCallPart("a2", "responsibility", ACCEPT),
				finishPart("tool-calls"),
			],
			[...textParts("taken"), finishPart("stop", 10)],
			[toolCallPart("b1", "responsibility", ACCEPT), finishPart("tool-calls")],
			[...textParts("also taken"), finishPart("stop", 10)],
		]);
		const runtime = new Runtime({
			store,
			buildStep: () => ({ model: edge.model, system: "test" }),
			makeTools: toolsFor,
		});
		const msg1 = userMessage([{ type: "text", text: "handle this one" }]);
		const first = new HeadlessSink();
		runtime.submit(conv, msg1, first);
		expect(await first.done).toEqual({ kind: "completed" });
		await waitUntil(() => resps.forProject(project.id).length === 1, "accept lands");
		const all = resps.forProject(project.id);
		expect(all).toHaveLength(1);
		expect(all[0]!.handoverKey).toBe(`handover:${conv.id}:${msg1.id}`);
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
		expect(keys).toContain(`handover:${conv.id}:${msg1.id}`);
		expect(keys).toContain(`handover:${conv.id}:${msg2.id}`);
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
		const herdr = {
			list: async () => [AGENT],
			prompt: async () => ({ ...AGENT, agent_status: "working" }),
		} as unknown as OperatorHerdr;
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
			operatorHerdr: herdr,
			mail: () => ({}) as Pick<MailApproval, "requestDraft">,
			programApproval: () => undefined,
			visionDepsFor: () => undefined,
			sandboxes: {} as unknown as Sandboxes,
			subagents: () => null,
			desktops: () => null,
			subagentsBoot: () => undefined,
			responsibility: () => ({ resps, service, listFor: async () => [AGENT] }),
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
		"epoch revocation during %s preflight wins without aborting the tool signal",
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
			let sends = 0;
			let signal: AbortSignal | undefined;
			const herdr: OperatorHerdr = {
				list: async () => [AGENT],
				read: async () => "",
				prompt: async (_pane, _kind, _brief, abortSignal, guard) => {
					signal = abortSignal;
					entered = true;
					await gate;
					expect(abortSignal?.aborted).toBe(false);
					guard?.beforeSend?.();
					sends += 1;
					return { ...AGENT, agent_status: "working" };
				},
			};
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
				operatorHerdr: herdr,
				mail: () => ({}) as Pick<MailApproval, "requestDraft">,
				programApproval: () => undefined,
				visionDepsFor: () => undefined,
				sandboxes: {} as unknown as Sandboxes,
				subagents: () => null,
				desktops: () => null,
				subagentsBoot: () => undefined,
				responsibility: () => ({
					resps,
					service,
					listFor: async () => {
						if (action === "accept") {
							entered = true;
							await gate;
						}
						return [AGENT];
					},
				}),
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
			await waitUntil(() => entered, "preflight entered");
			store.bumpEpoch(conv.id);
			expect(signal?.aborted ?? false).toBe(false);
			release();
			expect(await sink.done).toEqual({ kind: "fenced" });
			expect(sends).toBe(0);
			expect(resps.forProject(project.id)).toHaveLength(action === "accept" ? 0 : 1);
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
		let sends = 0;
		const herdr = {
			list: async () => [AGENT],
			prompt: async (
				_pane: string,
				_kind: string,
				_brief: string,
				_signal?: AbortSignal,
				guard?: { beforeSend?: () => void },
			) => {
				sends += 1;
				guard?.beforeSend?.();
				return { ...AGENT, agent_status: "working" };
			},
		} as unknown as OperatorHerdr;
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
			operatorHerdr: herdr,
			mail: () => ({}) as Pick<MailApproval, "requestDraft">,
			programApproval: () => undefined,
			visionDepsFor: () => undefined,
			sandboxes: {} as unknown as Sandboxes,
			subagents: () => null,
			desktops: () => null,
			subagentsBoot: () => undefined,
			responsibility: () => ({ resps, service, listFor: async () => [AGENT] }),
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
			store,
			turnJournal: journal,
			buildStep: () => ({ model: edge.model, system: "test" }),
			makeTools: toolsFor,
			runOwnership: {
				begin: (e) => dispatcher.hooks.begin(e),
				members: (r, ids) => dispatcher.hooks.members(r, ids),
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
		expect(sends).toBe(0);
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
		expect(sends).toBe(1);
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
	let sends = 0;
	const herdr = {
		list: async () => [AGENT],
		prompt: async () => {
			sends += 1;
			return { ...AGENT, agent_status: "working" };
		},
	} as unknown as OperatorHerdr;
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
		operatorHerdr: herdr,
		mail: () => ({}) as Pick<MailApproval, "requestDraft">,
		programApproval: () => undefined,
		visionDepsFor: () => undefined,
		sandboxes: {} as unknown as Sandboxes,
		subagents: () => null,
		desktops: () => null,
		subagentsBoot: () => undefined,
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
		store,
		turnJournal: journal,
		buildStep: () => ({ model: edge.model, system: "test" }),
		makeTools: toolsFor,
		runOwnership: {
			begin: (e) => dispatcher.hooks.begin(e),
			members: (r, ids) => dispatcher.hooks.members(r, ids),
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
	expect(sends).toBe(0);
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

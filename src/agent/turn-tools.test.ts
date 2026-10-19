import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { AuthStore } from "../auth.ts";
import { openStore } from "../conversation.ts";
import type { OperatorAgent, OperatorHerdr } from "../herdr.ts";
import { setLogFile } from "../log.ts";
import type { MailApproval } from "../tg/mail-approval.ts";
import type { NoteStore } from "../notes.ts";
import { openPrograms } from "../programs.ts";
import { openProjects } from "../projects.ts";
import { openResponsibilities } from "../responsibilities.ts";
import { makeResponsibilityService } from "../responsibility-service.ts";
import { Runtime, userMessage } from "../runtime.ts";
import type { Sandboxes } from "../sandboxes.ts";
import { openWakeStore } from "../wake-store.ts";
import { finishPart, scriptedModel, textParts, toolCallPart } from "../testkit/fake-model.ts";
import { HeadlessSink, tmpDir, useHome, waitUntil } from "../testkit.ts";
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

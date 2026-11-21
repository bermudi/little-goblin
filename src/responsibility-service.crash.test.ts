import { describe, expect, test } from "bun:test";
import { openStore } from "./conversation.ts";
import { openProjects } from "./projects.ts";
import { openResponsibilities } from "./responsibilities.ts";
import { makeResponsibilityService } from "./responsibility-service.ts";
import { openPrograms } from "./programs.ts";
import { deferred, tmpDb } from "./testkit.ts";
import { openWakeStore } from "./wake-store.ts";
import { storeFence } from "./testkit/store-fence.ts";

describe("responsibility send crash recovery", () => {
	test("a claimed send accepted before acknowledgement becomes uncertain and is not re-sent", async () => {
		const path = tmpDb("goblin-resp-crash-");
		const store = openStore(path);
		const projects = openProjects(store);
		const project = projects.create({ name: "crash" });
		const conv = store.resolve({ kind: "app", appId: project.slug, chatId: 0, threadId: 0 }, project.dir);
		store.bindProject(conv.id, project.id);
		const resps = openResponsibilities(store.db);
		const programsPath = path.replace(/goblin\.sqlite$/, "programs.sqlite");
		const programs = openPrograms(programsPath);
		const svc = makeResponsibilityService({ db: store.db, resps, wakes: openWakeStore(store.db), programs, conversations: store, fence: storeFence(store), pump: () => {} });
		const { responsibility } = svc.accept({
			projectId: project.id, coordinationConversationId: conv.id, handoverKey: "crash",
			understanding: { outcome: "done", situation: "working", nextAction: "continue", checkpoints: [], completionEvidence: ["test"] },
			attachments: [{ target: { server: "t3", session: "s", agentName: "a", paneId: null, terminalId: null, agentSession: "s", kind: null, cwd: null }, baseline: {} }],
		});
		const attachment = resps.attachmentsFor(responsibility.responsibilityId)[0]!;
		const prepared = resps.prepareOperation({ responsibilityId: responsibility.responsibilityId, attachmentId: attachment.attachmentId, brief: "work" });
		if (!("operation" in prepared)) throw new Error("expected prepared operation");
		const pending = deferred<Record<string, never>>();
		let sends = 0;
		void svc.dispatch(prepared.operation.operationId, async () => { sends++; return pending.promise; });
		await Bun.sleep(0);
		expect(sends).toBe(1);
		expect(resps.getOperation(prepared.operation.operationId)?.state).toBe("sent");
		store.close();
		programs.close();
		const reboot = openStore(path);
		const recovered = openResponsibilities(reboot.db);
		const nextPrograms = openPrograms(programsPath);
		const next = makeResponsibilityService({ db: reboot.db, resps: recovered, wakes: openWakeStore(reboot.db), programs: nextPrograms, conversations: reboot, fence: storeFence(reboot), pump: () => {} });
		await next.dispatch(prepared.operation.operationId, async () => { sends++; return {}; });
		expect(sends).toBe(1);
		expect(recovered.getOperation(prepared.operation.operationId)?.state).toBe("uncertain");
		reboot.close();
		nextPrograms.close();
	});
});

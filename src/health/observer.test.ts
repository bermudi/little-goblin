// The doctor check reads only the durable declaration: below the poll
// threshold nothing surfaces, a declared outage warns with its start,
// and a store that predates the columns skips rather than fails.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "../conversation.ts";
import { openProjects } from "../projects.ts";
import { openResponsibilities, type ResponsibilityStore } from "../responsibilities.ts";
import { tmpDir, useHome } from "../testkit.ts";
import { observer } from "./observer.ts";

function homeWithStore(): { home: string; resps: ResponsibilityStore; attach: () => number; close: () => void } {
	const home = useHome(`goblin-doc-obs-${tmpDir().slice(-6)}-`);
	mkdirSync(join(home, "state"), { recursive: true });
	const store = openStore(join(home, "state", "goblin.sqlite"));
	const projects = openProjects(store);
	const project = projects.create({ name: "rig" });
	const conv = store.resolve(
		{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
		project.dir,
	);
	const resps = openResponsibilities(store.db);
	const { responsibility } = resps.create({
		projectId: project.id,
		coordinationConversationId: conv.id,
		handoverKey: "h1",
		understanding: {
			outcome: "o",
			situation: "s",
			nextAction: "n",
			checkpoints: [],
			completionEvidence: [],
		},
	});
	return {
		home,
		resps,
		attach: () =>
			resps.attach({
				responsibilityId: responsibility.responsibilityId,
				target: {
					server: "local",
					session: "op",
					agentName: "worker-1",
					paneId: "pane-7",
					terminalId: "term-9",
					agentSession: "sess-abc",
					kind: "pi",
					cwd: "/w",
				},
				baseline: {},
				cursor: {},
			}).attachmentId,
		close: () => store.close(),
	};
}

describe("observer health check", () => {
	test("a home without a state database skips", () => {
		const home = useHome(`goblin-doc-obs-empty-${tmpDir().slice(-6)}-`);
		const [r] = observer(home, "installed");
		expect(r?.status).toBe("skip");
		expect(r?.id).toBe("observer.unreachable");
	});

	test("no declared outage passes; sub-threshold failures stay invisible", () => {
		const { home, resps, attach, close } = homeWithStore();
		try {
			const id = attach();
			// Two consecutive failures — below the declaration threshold.
			for (let i = 0; i < 2; i++)
				resps.markUnreachable(id, "2030-01-01T12:00:00.000Z");
			const [r] = observer(home, "installed");
			expect(r?.status).toBe("pass");
		} finally {
			close();
		}
	});

	test("a declared outage warns with the agent, target and start", () => {
		const { home, resps, attach, close } = homeWithStore();
		try {
			const id = attach();
			for (let i = 0; i < 3; i++)
				resps.markUnreachable(id, "2030-01-01T12:00:00.000Z");
			const [r] = observer(home, "installed");
			expect(r?.status).toBe("warn");
			expect(r?.detail).toContain("worker-1");
			expect(r?.detail).toContain("local/op");
			expect(r?.detail).toContain("2030-01-01T12:00:00.000Z");
			expect(r?.next).toBeTruthy();
		} finally {
			close();
		}
	});

	test("a cleared declaration passes again", () => {
		const { home, resps, attach, close } = homeWithStore();
		try {
			const id = attach();
			for (let i = 0; i < 3; i++)
				resps.markUnreachable(id, "2030-01-01T12:00:00.000Z");
			resps.clearUnreachable(id);
			const [r] = observer(home, "installed");
			expect(r?.status).toBe("pass");
		} finally {
			close();
		}
	});

	test("a store that predates the columns skips rather than failing", () => {
		const home = useHome(`goblin-doc-obs-old-${tmpDir().slice(-6)}-`);
		mkdirSync(join(home, "state"), { recursive: true });
		const db = new Database(join(home, "state", "goblin.sqlite"));
		db.exec("CREATE TABLE attachments (attachment_id INTEGER PRIMARY KEY)");
		db.close();
		const [r] = observer(home, "installed");
		expect(r?.status).toBe("skip");
	});
});

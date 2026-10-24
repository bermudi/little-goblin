import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPrograms, type ProgramsStore } from "../programs.ts";
import { startProgramOps } from "../program-ops.ts";
import { hookTokenHash } from "../program-hook.ts";
import {
	openResponsibilities,
	type ResponsibilityStore,
	type Understanding,
} from "../responsibilities.ts";
import { makeResponsibilityService } from "../responsibility-service.ts";
import { openWakeStore } from "../wake-store.ts";
import { setup } from "./app-testing.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

function wired(opts: { publicUrl?: string } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "goblin-app-programs-"));
	dirs.push(dir);
	const programs = openPrograms(join(dir, "programs.sqlite"));
	const posted: number[] = [];
	const ops = startProgramOps({
		programs,
		publicUrl: () => opts.publicUrl,
		requestApproval: async (proposal) => {
			posted.push(proposal.id);
		},
	});
	const { http, call } = setup({ programOps: ops });
	return { http, call, programs, posted };
}

const patch = (call: ReturnType<typeof setup>["call"], id: number, body: unknown) =>
	call(`/api/app/programs/${id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

// The same wiring plus the responsibility surface — a resp-target
// program's approval lane resolves through it to the coordination
// conversation.
function wiredResp() {
	const dir = mkdtempSync(join(tmpdir(), "goblin-app-programs-"));
	dirs.push(dir);
	const programs = openPrograms(join(dir, "programs.sqlite"));
	const posted: number[] = [];
	const ops = startProgramOps({
		programs,
		publicUrl: () => undefined,
		requestApproval: async (proposal) => {
			posted.push(proposal.id);
		},
	});
	let resps!: ResponsibilityStore;
	const { http, call, store, projects } = setup({
		programOps: ops,
		responsibilities: (ctx) => {
			resps = openResponsibilities(ctx.store.db);
			const wakes = openWakeStore(ctx.store.db);
			return {
				feed: { db: ctx.store.db, resps, programs },
				resps,
				service: makeResponsibilityService({
					db: ctx.store.db,
					resps,
					wakes,
					programs,
					conversations: ctx.store,
					pump: () => {},
				}),
				listAgents: async () => [],
			};
		},
	});
	return { http, call, store, projects, programs, posted, resps: () => resps };
}

const understanding: Understanding = {
	outcome: "o",
	situation: "s",
	nextAction: "n",
	checkpoints: [],
	completionEvidence: [],
};

function seed(programs: ProgramsStore, hook = false) {
	return programs.create({
		name: "reports",
		charter: "send reports",
		cron: "0 9 * * 1",
		...(hook ? { hookHash: "old-hook" } : {}),
		address: { target: "app/chat-01" },
	});
}

describe("app program operations", () => {
	test("safe edits, toggle and delete apply directly against the live row", async () => {
		const { http, call, programs, posted } = wired();
		try {
			const program = seed(programs);
			const renamed = await patch(call, program.id, { name: "weekly reports" });
			expect(renamed.status).toBe(200);
			expect(programs.get(program.id)).toMatchObject({ name: "weekly reports" });
			expect(posted).toEqual([]);

			const toggled = await call(`/api/app/programs/${program.id}/toggle`, { method: "POST" });
			expect(toggled.status).toBe(200);
			expect(programs.get(program.id)?.enabled).toBe(false);

			const deleted = await call(`/api/app/programs/${program.id}`, { method: "DELETE" });
			expect(deleted.status).toBe(200);
			expect(programs.get(program.id)).toBeNull();
		} finally {
			http.stop();
			programs.close();
		}
	});

	test("a grant-shaped edit stages one pending proposal at the program's own target", async () => {
		const { http, call, programs, posted } = wired();
		try {
			const program = seed(programs);
			const res = await patch(call, program.id, {
				name: "renamed",
				charter: "send broader reports",
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { status: string; proposalId: number };
			expect(body.status).toBe("proposal");
			const proposal = programs.proposals.get(body.proposalId);
			expect(proposal).toMatchObject({
				targetId: program.id,
				target: "app/chat-01",
				state: "pending",
				patch: { name: "renamed", charter: "send broader reports" },
			});
			expect(programs.get(program.id)?.charter).toBe("send reports");
			expect(posted).toEqual([body.proposalId]);
		} finally {
			http.stop();
			programs.close();
		}
	});

	test("hook enable stages; hook rotate returns the URL once and only stores its hash", async () => {
		const { http, call, programs, posted } = wired({ publicUrl: "https://goblin.example" });
		try {
			const program = seed(programs);
			const enable = await call(`/api/app/programs/${program.id}/hook`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: "enable" }),
			});
			expect(enable.status).toBe(200);
			const staged = (await enable.json()) as { status: string; proposalId: number };
			expect(staged.status).toBe("proposal");
			expect(posted).toEqual([staged.proposalId]);
			const approved = programs.proposals.approve(staged.proposalId, "app", {
				hookHash: "granted-hook",
			});
			expect(approved.kind).toBe("activated");

			const rotated = await call(`/api/app/programs/${program.id}/hook`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: "rotate" }),
			});
			expect(rotated.status).toBe(200);
			const body = (await rotated.json()) as { status: string; hookUrl?: string };
			expect(body.status).toBe("rotated");
			expect(body.hookUrl).toMatch(/^https:\/\/goblin\.example\/hook\//);
			const token = body.hookUrl!.split("/hook/")[1]!;
			expect(programs.get(program.id)?.hookHash).toBe(hookTokenHash(token));
			const detail = await call(`/api/app/programs/${program.id}`);
			expect(JSON.stringify(await detail.json())).not.toContain(token);
		} finally {
			http.stop();
			programs.close();
		}
	});

	test("a resp-target program stages approvals at the coordination conversation", async () => {
		const { http, call, store, projects, programs, posted, resps } = wiredResp();
		try {
			const project = projects.create({ name: "rig" });
			const conv = store.resolve(
				{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
				project.dir,
			);
			const { responsibility } = resps().create({
				projectId: project.id,
				coordinationConversationId: conv.id,
				handoverKey: "k1",
				understanding,
			});
			const program = programs.create({
				name: "check-in",
				charter: "check in",
				cron: "0 9 * * 1",
				responsibilityId: responsibility.responsibilityId,
			});
			expect(program.target).toBe(`resp:${responsibility.responsibilityId}`);

			// A charter edit stages at the coordination conversation's
			// target — the live row and its destination are untouched.
			const res = await patch(call, program.id, { charter: "check in more broadly" });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { status: string; proposalId: number };
			expect(body.status).toBe("proposal");
			expect(programs.proposals.get(body.proposalId)).toMatchObject({
				targetId: program.id,
				target: conv.id,
				state: "pending",
			});
			expect(programs.get(program.id)?.charter).toBe("check in");
			expect(posted).toEqual([body.proposalId]);
			// Approval activates the requested patch; the program stays a
			// responsibility-destination row.
			expect(programs.proposals.approve(body.proposalId, "app").kind).toBe("activated");
			const after = programs.get(program.id)!;
			expect(after.charter).toBe("check in more broadly");
			expect(after.target).toBe(`resp:${responsibility.responsibilityId}`);
			expect(after.responsibilityId).toBe(responsibility.responsibilityId);

			// An added mail filter stages on the same lane.
			const mail = await patch(call, program.id, { mailFilter: "from:builds@ci" });
			expect(mail.status).toBe(200);
			const mailBody = (await mail.json()) as { status: string; proposalId: number };
			expect(mailBody.status).toBe("proposal");
			expect(programs.proposals.get(mailBody.proposalId)?.target).toBe(conv.id);
			expect(programs.get(program.id)?.mailFilter).toBeNull();
			expect(programs.proposals.approve(mailBody.proposalId, "app").kind).toBe("activated");
			const filtered = programs.get(program.id)!;
			expect(filtered.mailFilter).toBe("from:builds@ci");
			expect(filtered.target).toBe(`resp:${responsibility.responsibilityId}`);
			expect(filtered.responsibilityId).toBe(responsibility.responsibilityId);

			// Hook enable stages there too — no credential exists while
			// the proposal pends — and activates under approval.
			const enable = await call(`/api/app/programs/${program.id}/hook`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: "enable" }),
			});
			expect(enable.status).toBe(200);
			const staged = (await enable.json()) as { status: string; proposalId: number };
			expect(staged.status).toBe("proposal");
			expect(programs.proposals.get(staged.proposalId)?.target).toBe(conv.id);
			expect(programs.get(program.id)?.hookHash).toBeNull();
			expect(programs.proposals.approve(staged.proposalId, "app", { hookHash: "h1" }).kind).toBe(
				"activated",
			);
			expect(programs.get(program.id)?.hookHash).toBe("h1");
			expect(programs.get(program.id)?.target).toBe(`resp:${responsibility.responsibilityId}`);
		} finally {
			http.stop();
			programs.close();
		}
	});

	test("a responsibility on a rolling-DM conversation presents at the canonical dm target", async () => {
		const { http, call, store, projects, programs, resps } = wiredResp();
		try {
			const project = projects.create({ name: "rig" });
			const conv = store.rollDm(42, "/w"); // dm:42:1 — a rolling id
			expect(conv.id).toBe("dm:42:1");
			const { responsibility } = resps().create({
				projectId: project.id,
				coordinationConversationId: conv.id,
				handoverKey: "k1",
				understanding,
			});
			const program = programs.create({
				name: "check-in",
				charter: "check in",
				cron: "0 9 * * 1",
				responsibilityId: responsibility.responsibilityId,
			});
			const res = await patch(call, program.id, { charter: "wider" });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { status: string; proposalId: number };
			expect(body.status).toBe("proposal");
			// The canonical rolling-DM address, not one concrete row.
			expect(programs.proposals.get(body.proposalId)?.target).toBe("dm:42");
		} finally {
			http.stop();
			programs.close();
		}
	});

	test("a resp-target program without resolvable wiring refuses the grant — never a 500", async () => {
		const { http, call, store, projects, programs, posted, resps } = wiredResp();
		try {
			const project = projects.create({ name: "rig" });
			const conv = store.resolve(
				{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
				project.dir,
			);
			// Missing row: the responsibility id names nothing.
			const ghost = programs.create({
				name: "ghost",
				charter: "check in",
				cron: "0 9 * * 1",
				responsibilityId: "resp-missing",
			});
			// Missing coordination conversation: the row exists, its lane
			// is gone.
			const { responsibility: orphan } = resps().create({
				projectId: project.id,
				coordinationConversationId: conv.id,
				handoverKey: "k1",
				understanding,
			});
			const orphanProgram = programs.create({
				name: "orphan",
				charter: "check in",
				cron: "0 9 * * 1",
				hookHash: "h0",
				responsibilityId: orphan.responsibilityId,
			});
			store.db.run("PRAGMA foreign_keys = OFF");
			store.db.run("DELETE FROM conversations WHERE id = ?", [conv.id]);
			store.db.run("PRAGMA foreign_keys = ON");
			for (const id of [ghost.id, orphanProgram.id]) {
				const res = await patch(call, id, { charter: "wider" });
				expect(res.status).toBe(422);
				const body = (await res.json()) as { status: string; message: string };
				expect(body.status).toBe("error");
				expect(body.message).toContain("no destination");
				const hook = await call(`/api/app/programs/${id}/hook`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ op: "enable" }),
				});
				expect(hook.status).toBe(422);
			}
			expect(posted).toEqual([]);
			expect(programs.proposals.pending()).toHaveLength(0);
			// Addressless paths never needed presentation: rename and hook
			// disable apply directly on the unresolvable program.
			const renamed = await patch(call, orphanProgram.id, { name: "renamed" });
			expect(renamed.status).toBe(200);
			expect(programs.get(orphanProgram.id)?.name).toBe("renamed");
			const disabled = await call(`/api/app/programs/${orphanProgram.id}/hook`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: "disable" }),
			});
			expect(disabled.status).toBe(200);
			expect(programs.get(orphanProgram.id)?.hookHash).toBeNull();
		} finally {
			http.stop();
			programs.close();
		}
	});

	test("an unwired resp-target program refuses the grant; addressless edits still apply", async () => {
		const { http, call, programs, posted } = wired();
		try {
			const program = programs.create({
				name: "check-in",
				charter: "check in",
				cron: "0 9 * * 1",
				responsibilityId: "resp-ghost",
			});
			const res = await patch(call, program.id, { charter: "wider" });
			expect(res.status).toBe(422);
			const body = (await res.json()) as { status: string; message: string };
			expect(body.status).toBe("error");
			expect(body.message).toContain("no destination");
			const hook = await call(`/api/app/programs/${program.id}/hook`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ op: "enable" }),
			});
			expect(hook.status).toBe(422);
			expect(posted).toEqual([]);
			expect(programs.proposals.pending()).toHaveLength(0);
			// Rename and reschedule never needed presentation.
			const renamed = await patch(call, program.id, { name: "renamed", cron: "0 10 * * 2" });
			expect(renamed.status).toBe(200);
			expect(programs.get(program.id)).toMatchObject({ name: "renamed", cron: "0 10 * * 2" });
		} finally {
			http.stop();
			programs.close();
		}
	});

	test("missing program operation wiring answers 503", async () => {
		const { http, call } = setup();
		try {
			const res = await call("/api/app/programs/1/toggle", { method: "POST" });
			expect(res.status).toBe(503);
		} finally {
			http.stop();
		}
	});
});

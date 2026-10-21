import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPrograms, type ProgramsStore } from "../programs.ts";
import { startProgramOps } from "../program-ops.ts";
import { hookTokenHash } from "../program-hook.ts";
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

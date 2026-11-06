// Queued authority: an autonomous development stamps the responsibility
// state it acted on; when its wake's trigger is appended, a lapsed
// stamp (pause, close, correction, detach, re-bind) is still delivered
// but framed as superseded history. Operator-origin and unlinked
// events are never re-checked, and the appended text never changes
// after commit.

import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { openProjects } from "./projects.ts";
import { type AttachmentTarget, openResponsibilities } from "./responsibilities.ts";
import {
	authorityStamp,
	makeAuthorityRecheck,
	stillAuthorized,
} from "./responsibility-authority.ts";
import { tmpDir, useHome } from "./testkit.ts";
import { openWakeStore } from "./wake-store.ts";

setLogFile(null);

const target: AttachmentTarget = {
	server: "local",
	session: "goblin-probe",
	agentName: "worker-1",
	paneId: "pane-7",
	terminalId: "term-9",
	agentSession: "sess-abc",
	kind: "pi",
	cwd: "/w",
};

function rig() {
	const home = useHome(`goblin-authority-${tmpDir().slice(-6)}-`);
	mkdirSync(join(home, "state"), { recursive: true });
	const store = openStore(join(home, "state", "goblin.sqlite"));
	const project = openProjects(store).create({ name: "rig" });
	const conv = store.resolve(
		{ kind: "app", appId: project.slug, chatId: 0, threadId: 0 },
		project.dir,
	);
	const resps = openResponsibilities(store.db);
	const understanding = {
		outcome: "kernel upgraded",
		situation: "",
		nextAction: "",
		checkpoints: [],
		completionEvidence: [],
	};
	const { responsibility } = resps.create({
		projectId: project.id,
		coordinationConversationId: conv.id,
		handoverKey: "k1",
		understanding,
	});
	const att = resps.attach({
		responsibilityId: responsibility.responsibilityId,
		target,
		baseline: {},
	});
	const wakes = openWakeStore(store.db);
	const id = responsibility.responsibilityId;
	let n = 0;
	const record = (opts: { stamp?: boolean; withAtt?: boolean; linked?: boolean } = {}) => {
		n += 1;
		const resp = resps.get(id)!;
		return wakes.record({
			sourceKey: `dev:${n}`,
			conversationId: conv.id,
			kind: "observation",
			text: `development ${n}`,
			facts: null,
			origin: "observer",
			...(opts.linked === false ? {} : { responsibilityId: id }),
			...(opts.stamp === false
				? {}
				: {
						authority: authorityStamp(
							resp,
							opts.withAtt === false ? undefined : resps.getAttachment(att.attachmentId)!,
						),
					}),
		});
	};
	const commit = (wakeId: number) => {
		const appended: string[] = [];
		const rec = wakes.commit(
			wakeId,
			({ id: mid, text }) => {
				appended.push(text);
				store.append(conv.id, [{ id: mid, role: "user", parts: [{ type: "text", text }] }]);
			},
			makeAuthorityRecheck(resps),
		);
		return { rec, text: appended[0]! };
	};
	return { store, resps, wakes, id, att, understanding, record, commit };
}

describe("stillAuthorized", () => {
	const stamp = { status: "active", revision: 2, attachmentId: 5, attachmentGeneration: 1 };
	const live = { status: "active" as const, revision: 2 };
	const att = { generation: 1, health: "attached" as const };

	test("holds while lifecycle, revision and binding are unchanged", () => {
		expect(stillAuthorized(live, att, stamp)).toBeNull();
		expect(stillAuthorized(live, null, { status: "active", revision: 2 })).toBeNull();
	});

	test("names each lapse", () => {
		expect(stillAuthorized(null, att, stamp)).toMatch(/no longer exists/);
		expect(stillAuthorized({ ...live, status: "paused" }, att, stamp)).toMatch(/active → paused/);
		expect(stillAuthorized({ ...live, revision: 3 }, att, stamp)).toMatch(/rev 2 → 3/);
		expect(stillAuthorized(live, { ...att, health: "detached" }, stamp)).toMatch(/detached/);
		expect(stillAuthorized(live, null, stamp)).toMatch(/detached/);
		expect(stillAuthorized(live, { ...att, generation: 2 }, stamp)).toMatch(/generation 1 → 2/);
	});
});

describe("queued authority at dispatch", () => {
	test("a development that still holds is delivered unmarked", () => {
		const r = rig();
		const { wakeId } = r.record();
		const { text } = r.commit(wakeId);
		expect(text).toBe("development 1");
	});

	test("a pause between record and append marks it superseded, still delivered", () => {
		const r = rig();
		const { wakeId } = r.record();
		r.resps.setStatus(r.id, "paused");
		const { rec, text } = r.commit(wakeId);
		expect(text).toBe(
			"[superseded — responsibility active → paused since recorded; history only, not authority to act]\ndevelopment 1",
		);
		// Stable after commit: resuming does not rewrite what was appended,
		// and a retried submit reads the same text.
		r.resps.setStatus(r.id, "active");
		expect(r.wakes.get(wakeId)!.text).toBe(text);
		expect(rec.state).toBe("claimed");
	});

	test("a correction and a re-bind each lapse their own stamps; others in the wake stay unmarked", () => {
		const r = rig();
		const before = r.record({ withAtt: false });
		r.resps.revise(r.id, { ...r.understanding, nextAction: "reboot first" });
		const after = r.record();
		r.resps.detach(r.att.attachmentId);
		r.resps.reattach(r.att.attachmentId, { ...target, agentSession: "sess-new" }, {});
		const unstamped = r.record({ stamp: false });
		const unlinked = r.record({ linked: false });
		expect(new Set([before.wakeId, after.wakeId, unstamped.wakeId, unlinked.wakeId]).size).toBe(1);
		const { text } = r.commit(before.wakeId);
		expect(text.split("\n")).toEqual([
			"[superseded — operator corrected the responsibility (rev 1 → 2) since recorded; history only, not authority to act]",
			"development 1",
			`[superseded — attachment ${r.att.attachmentId} re-bound (generation 1 → 2) since recorded; history only, not authority to act]`,
			"development 2",
			"development 3",
			"development 4",
		]);
	});

	test("a malformed stamp aborts the commit — nothing appended, the wake stays pending", () => {
		const r = rig();
		const { wakeId } = r.wakes.record({
			sourceKey: "bad",
			conversationId: r.resps.get(r.id)!.coordinationConversationId,
			kind: "observation",
			text: "bad stamp",
			facts: null,
			origin: "observer",
			responsibilityId: r.id,
			authority: { revision: "one" },
		});
		expect(() => r.commit(wakeId)).toThrow(/malformed authority stamp/);
		expect(r.wakes.get(wakeId)!.state).toBe("pending");
	});
});

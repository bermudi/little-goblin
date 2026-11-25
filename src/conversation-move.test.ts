import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appAddress } from "./conversation-address.ts";
import type { Config } from "./config-schema.ts";
import { openStore } from "./conversation.ts";
import { moveIntoProject } from "./conversation-move.ts";
import { openNotes } from "./notes.ts";
import { openProjects } from "./projects.ts";
import { useHome } from "./testkit.ts";

function fixture() {
	const home = useHome("goblin-move-");
	mkdirSync(join(home, "state"), { recursive: true });
	const store = openStore(join(home, "state", "goblin.sqlite"));
	const projects = openProjects(store);
	const notes = openNotes(store, { projects });
	const runtime = { busy: (_id: string) => false };
	const rollingConfig = {
		model: "zai/m",
		thinking: "medium",
		providers: { zai: { kind: "openai-compatible", baseUrl: "https://example.com", auth: "zai" } },
	} as unknown as Config;
	const deps = {
		store,
		projects,
		notes,
		runtime,
		workspace: join(home, "workspace"),
		rollingConfig,
	};
	return { home, store, projects, notes, runtime, rollingConfig, deps };
}

describe("moveIntoProject", () => {
	test("moves in place, appends one notice, and is unchanged on a repeat", () => {
		const f = fixture();
		const conv = f.store.resolve(appAddress("move-1"), f.deps.workspace);
		const project = f.projects.create({ name: "Ship It", instructions: "Ship the thing." });
		f.store.append(conv.id, [{ id: "prior", role: "user", parts: [{ type: "text", text: "before" }] }]);
		const moved = moveIntoProject(f.deps, conv.id, project.id);
		expect(moved.kind).toBe("moved");
		expect(f.store.get(conv.id)?.projectId).toBe(project.id);
		expect(f.store.history(conv.id).map((m) => m.id)).toEqual(["prior", expect.any(String)]);
		const notice = f.store.history(conv.id)[1]!;
		expect(notice.role).toBe("user");
		const noticeText = notice.parts.find(
			(part): part is Extract<(typeof notice.parts)[number], { type: "text" }> =>
				part.type === "text" && part.text.includes("[project: moved into Ship It]"),
		)?.text;
		expect(typeof noticeText).toBe("string");
		expect(noticeText?.includes(project.dir)).toBe(true);
		expect(noticeText?.includes("Ship the thing.")).toBe(true);
		expect(moveIntoProject(f.deps, conv.id, project.id).kind).toBe("unchanged");
		expect(f.store.history(conv.id)).toHaveLength(2);
		f.store.close();
	});

	test("a memory-off project gates the conversation and the notice event", () => {
		const f = fixture();
		const conv = f.store.resolve(appAddress("move-private"), f.deps.workspace);
		const project = f.projects.create({ name: "Private", memory: "off" });
		expect(moveIntoProject(f.deps, conv.id, project.id).kind).toBe("moved");
		const moved = f.store.get(conv.id)!;
		expect(moved.memoryExcluded).toBe(true);
		expect(moved.memoryExcludedByProject).toBe(true);
		expect(f.store.memoryEligibility(conv.id).eligibleSeqs.size).toBe(0);
		f.store.close();
	});

	test("returns refusal outcomes in the specified precedence", () => {
		const f = fixture();
		const loose = f.store.resolve(appAddress("move-loose"), f.deps.workspace);
		const first = f.projects.create({ name: "First" });
		const second = f.projects.create({ name: "Second" });
		const archived = f.projects.create({ name: "Archived" });
		f.projects.patch(archived.id, { archived: true });
		expect(moveIntoProject(f.deps, "app/missing", first.id).kind).toBe("notFound");
		expect(moveIntoProject(f.deps, loose.id, "missing").kind).toBe("noProject");
		expect(moveIntoProject(f.deps, loose.id, archived.id).kind).toBe("projectArchived");
		expect(moveIntoProject(f.deps, loose.id, first.id).kind).toBe("moved");
		expect(moveIntoProject(f.deps, loose.id, first.id).kind).toBe("unchanged");
		expect(moveIntoProject(f.deps, loose.id, second.id).kind).toBe("alreadyBound");

		const telegram = f.store.resolve({ kind: "dm", chatId: 49 }, f.deps.workspace);
		expect(moveIntoProject(f.deps, telegram.id, first.id).kind).toBe("notApp");

		const child = f.store.resolve(appAddress("move-child"), f.deps.workspace);
		f.store.db.run("UPDATE conversations SET parent_conversation_id = ? WHERE id = ?", [
			loose.id,
			child.id,
		]);
		expect(moveIntoProject(f.deps, child.id, first.id).kind).toBe("child");
		const olderRoll = f.store.rollApp(f.rollingConfig);
		f.store.rollApp(f.rollingConfig);
		expect(moveIntoProject(f.deps, olderRoll.id, first.id).kind).toBe("rolling");
		expect(f.store.get(olderRoll.id)?.projectId).toBeNull();
		expect(f.store.isAppRoll(olderRoll.id)).toBe(true);
		expect(f.store.history(olderRoll.id)).toHaveLength(0);
		f.store.close();
	});

	test("moves the current roll in place and mints a fresh rolling conversation", () => {
		const f = fixture();
		const roll = f.store.rollApp(f.rollingConfig);
		f.store.append(roll.id, [{ id: "prior", role: "user", parts: [{ type: "text", text: "before" }] }]);
		const project = f.projects.create({ name: "Ship It", instructions: "Ship the thing." });

		expect(moveIntoProject(f.deps, roll.id, project.id).kind).toBe("moved");

		const moved = f.store.get(roll.id)!;
		expect(moved.projectId).toBe(project.id);
		expect(f.store.isAppRoll(roll.id)).toBe(false);
		expect(f.store.history(roll.id).map((m) => m.id)).toEqual(["prior", expect.any(String)]);
		const fresh = f.store.currentAppRoll();
		expect(fresh).not.toBeNull();
		expect(fresh!.id).not.toBe(roll.id);
		expect(fresh!.projectId).toBeNull();
		expect(f.store.appRollChain(10).map((row) => row.id)).toEqual([fresh!.id]);
		expect(f.store.listAppConversations().some((row) => row.id === roll.id)).toBe(true);
		expect(f.store.appRollDestination(roll.id)).toBe(roll.id);

		expect(moveIntoProject(f.deps, roll.id, project.id).kind).toBe("unchanged");
		expect(f.store.currentAppRoll()?.id).toBe(fresh!.id);
		f.store.close();
	});

	test("a busy current roll refuses before minting its replacement", () => {
		const f = fixture();
		const roll = f.store.rollApp(f.rollingConfig);
		const project = f.projects.create({ name: "Busy" });
		f.runtime.busy = (id: string) => id === roll.id;
		expect(moveIntoProject(f.deps, roll.id, project.id).kind).toBe("busy");
		expect(f.store.currentAppRoll()?.id).toBe(roll.id);
		expect(f.store.get(roll.id)?.projectId).toBeNull();
		expect(f.store.isAppRoll(roll.id)).toBe(true);
		f.store.close();
	});

	test("rechecks busy at the synchronous move boundary", () => {
		const f = fixture();
		const conv = f.store.resolve(appAddress("move-busy"), f.deps.workspace);
		const project = f.projects.create({ name: "Busy" });
		f.runtime.busy = (id: string) => id === conv.id;
		expect(moveIntoProject(f.deps, conv.id, project.id).kind).toBe("busy");
		expect(f.store.get(conv.id)?.projectId).toBeNull();
		expect(f.store.history(conv.id)).toHaveLength(0);
		f.store.close();
	});
});

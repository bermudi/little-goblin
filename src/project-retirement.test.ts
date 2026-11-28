import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { systemPromptFor } from "./agent/prompt.ts";
import { CHAT_NOTE_NOTICE_PART } from "./chat-note-pins.ts";
import { appAddress } from "./conversation-address.ts";
import { conversationWorkdir } from "./conversation-workdir.ts";
import { openStore } from "./conversation.ts";
import { LITTLE_GOBLIN_NOTE_OWNER } from "./note-owner.ts";
import { openNotes } from "./notes.ts";
import { applyProjectRetirement, previewProjectRetirement, requireRetiredProjects } from "./project-retirement.ts";
import { openProjects } from "./projects.ts";
import { openTestStore, tmpDir } from "./testkit.ts";

const now = new Date("2026-11-28T07:00:00Z");
const user = (id: string) => ({ id, role: "user" as const, parts: [{ type: "text" as const, text: id }] });

test("a checked project retirement migrates every project, preserves history, and backs up the previous state", () => {
	const { store, dbPath } = openTestStore("project-retirement-");
	let fixture;
	try {
		const projects = openProjects(store);
		const notes = openNotes(store, { projects });
		const botProject = projects.create({ name: "Workshop", instructions: "Keep an inventory.", memory: "off" });
		const looseProject = projects.create({ name: "Garden", instructions: "Plants for dry shade." });
		const archivedProject = projects.create({ name: "Old house" });
		const botChat = store.resolve(appAddress("tools"), "old-default");
		const littleChat = store.resolve(appAddress("garden"), "old-default");
		const archivedChat = store.resolve(appAddress("keys"), "old-default");
		store.bindProject(botChat.id, botProject.id);
		store.bindProject(littleChat.id, looseProject.id);
		store.bindProject(archivedChat.id, archivedProject.id);
		store.setMeta(littleChat.id, { memoryExcluded: true, pinned: true });
		store.setMeta(archivedChat.id, { pinned: true });
		projects.patch(archivedProject.id, { archived: true });
		const frozen = "## project — Workshop\nKeep an inventory.";
		store.savePromptSnapshot(botChat.id, frozen, ["project"]);
		store.saveLastTurnTools(botChat.id, botChat.epoch, '[{"name":"bash","description":"old declaration"}]');
		const botNote = notes.create({ title: "Tools", body: "One saw", projectId: botProject.id });
		const littleNote = notes.create({ title: "Seeds", body: "Two bags", projectId: looseProject.id });
		expect(store.chatNotePins.set(botChat.id, botNote.id, true)).toBe(true);
		expect(store.chatNotePins.set(littleChat.id, littleNote.id, true)).toBe(true);
		store.append(botChat.id, [user("Before")]);
		store.append(littleChat.id, [user("Garden before")]);
		expect(() => requireRetiredProjects(store.db)).toThrow("Projects must be retired");
		const earlierChat = store.resolve(appAddress("earlier"), "old-default");
		expect(store.chatNotePins.set(earlierChat.id, botNote.id, true)).toBe(false);
		store.db.run(`INSERT INTO chat_note_pins (conversation_id, note_id, pinned_rev)
			VALUES (?, ?, ?)`, [earlierChat.id, botNote.id, botNote.rev]);
		fixture = {
			botProject, looseProject, archivedProject, botChat, littleChat, archivedChat, earlierChat,
			botNote, littleNote, snapshot: store.promptSnapshot(botChat.id),
			tools: store.lastTurnTools(botChat.id), history: store.history(botChat.id),
		};
	} finally {
		store.close();
	}
	const { botProject, looseProject, archivedProject, botChat, littleChat, archivedChat,
		earlierChat, botNote, littleNote, snapshot, tools, history } = fixture;
	const selected = [botProject.id];
	const plan = previewProjectRetirement(dbPath, selected);
	expect(plan.projects).toHaveLength(3);
	expect(plan.projects).toContainEqual(expect.objectContaining({
		projectId: botProject.id,
		targetBotId: botProject.id,
		sideChats: [{ id: botChat.id, archivedAt: null, memoryExcluded: true }],
	}));
	expect(readdirSync(dirname(dbPath)).some((name) => name.startsWith("before-project-retirement-"))).toBe(false);
	expect(() => applyProjectRetirement(dbPath, [], plan.approval, now)).toThrow("plan changed");
	const result = applyProjectRetirement(dbPath, selected, plan.approval, now);
	expect(result.backup).not.toBeNull();
	using backup = new Database(result.backup!, { readonly: true });
	expect(backup.query("SELECT project_id FROM notes WHERE id = ?").get(botNote.id)).toEqual({
		project_id: botProject.id,
	});
	expect(() => requireRetiredProjects(backup)).toThrow("Projects must be retired");
	const retry = applyProjectRetirement(dbPath, selected, plan.approval, now);
	expect(retry).toMatchObject({ projects: [], backup: null });

	const migrated = openStore(dbPath);
	try {
		requireRetiredProjects(migrated.db);
		const projects = openProjects(migrated);
		const notes = openNotes(migrated, { projects });
		const id = `app/project-${botProject.id}`;
		expect(migrated.bots.get(botProject.id)).toEqual({
			id: botProject.id, name: "Workshop", instructions: "Keep an inventory.",
			folder: botProject.dir, mainConversationId: id, sideConversationIds: [botChat.id], canMoveBack: false,
		});
		expect(migrated.history(id)).toEqual([]);
		expect(migrated.promptSnapshot(id)).toBeNull();
		const main = migrated.get(id)!;
		const bot = migrated.bots.get(botProject.id)!;
		const workdir = conversationWorkdir(migrated, projects, main);
		const prompt = systemPromptFor(migrated, main, ["bash"], null, undefined, { bot, workdir });
		expect(prompt.text).toContain("Keep an inventory.");
		expect(prompt.text).toContain(`Working directory: ${botProject.dir}`);
		migrated.bots.patch(bot.id, { instructions: "Use a new list.", folder: tmpDir() });
		const changed = migrated.bots.get(bot.id)!;
		expect(conversationWorkdir(migrated, projects, main)).toBe(workdir);
		expect(systemPromptFor(migrated, main, ["bash"], null, undefined, { bot: changed, workdir: changed.folder! }).text)
			.toBe(prompt.text);
		expect(migrated.bots.membership(littleChat.id)).toBeNull();
		expect(migrated.get(littleChat.id)).toMatchObject({ projectId: null, memoryExcluded: true, pinnedAt: expect.any(String) });
		expect(migrated.get(botChat.id)).toMatchObject({ projectId: null, memoryExcluded: true, memoryExcludedByProject: false });
		expect(migrated.get(archivedChat.id)).toMatchObject({
			archivedAt: projects.get(archivedProject.id)?.archivedAt, pinnedAt: null, projectId: null,
		});
		expect(conversationWorkdir(migrated, projects, migrated.get(botChat.id)!)).toBe(botProject.dir);
		expect(conversationWorkdir(migrated, projects, migrated.get(littleChat.id)!)).toBe(looseProject.dir);
		expect(conversationWorkdir(migrated, projects, migrated.get(id)!)).toBe(botProject.dir);
		expect(migrated.promptSnapshot(botChat.id)).toEqual(snapshot);
		expect(migrated.lastTurnTools(botChat.id)).toEqual(tools);
		expect(migrated.history(botChat.id)).toEqual(history);
		expect(notes.get(botNote.id)).toMatchObject({ projectId: null, botId: botProject.id, body: "One saw", rev: botNote.rev + 1 });
		expect(notes.get(littleNote.id)).toMatchObject({ projectId: null, botId: LITTLE_GOBLIN_NOTE_OWNER });
		expect(notes.get(`project-instructions-${looseProject.id}`)).toMatchObject({
			botId: LITTLE_GOBLIN_NOTE_OWNER, body: "Plants for dry shade.",
		});
		expect(notes.listEdits(botNote.id).edits[0]).toMatchObject({ what: "Moved from a retired project" });
		expect(migrated.chatNotePins.view(botChat.id, null).pins.map(({ id }) => id)).toEqual([botNote.id]);
		expect(migrated.chatNotePins.view(littleChat.id, null).pins.map(({ id }) => id)).toEqual([littleNote.id]);
		expect(migrated.db.query("SELECT removed FROM chat_note_pins WHERE conversation_id = ?").get(earlierChat.id))
			.toEqual({ removed: "unavailable" });
		const notice = [user("After retirement"), user("Later")].flatMap((message) => {
			const [seq] = migrated.append(earlierChat.id, [message]);
			return migrated.chatNotePins.capture(earlierChat.id, seq!, message).parts
				.filter((part) => part.type === CHAT_NOTE_NOTICE_PART);
		});
		expect(notice).toHaveLength(1);
		expect(JSON.stringify(notice[0])).toContain("is no longer available");
	} finally {
		migrated.close();
	}
});

test("an occupied fresh main chat rolls back all project work", () => {
	const { store, dbPath } = openTestStore("project-retirement-rollback-");
	let projectIds: string[];
	try {
		const projects = openProjects(store);
		projectIds = [projects.create({ name: "One" }).id, projects.create({ name: "Two" }).id].sort();
		const second = projectIds[1]!;
		store.resolve(appAddress(`project-${second}`), tmpDir());
	} finally {
		store.close();
	}
	const plan = previewProjectRetirement(dbPath, projectIds);
	expect(() => applyProjectRetirement(dbPath, projectIds, plan.approval, now)).toThrow("UNIQUE constraint failed");
	expect(previewProjectRetirement(dbPath, projectIds)).toEqual(plan);
	const after = openStore(dbPath);
	try {
		expect(after.bots.list()).toEqual([]);
		expect(after.db.query("SELECT COUNT(*) AS n FROM project_retirements").get()).toEqual({ n: 0 });
	} finally {
		after.close();
	}
});

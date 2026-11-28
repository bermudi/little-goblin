import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteTool } from "../agent/tools/note.ts";
import { appAddress, appIdOf } from "../conversation-address.ts";
import { LITTLE_GOBLIN_NOTE_OWNER } from "../note-owner.ts";
import { deferred, waitUntil } from "../testkit.ts";
import { sdkScript } from "../testkit/turn-script-sdk.ts";
import { handleBotsRoute } from "./app-bots.ts";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";
import type { AppBot, ChatNotePinsView } from "./app-wire.ts";

const jsonHeaders = { "content-type": "application/json" };

test("chat note pins lost on promotion stay removed after move back", async () => {
	const script = sdkScript();
	for (let i = 0; i < 3; i++) script.script({ kind: "reply", parts: [{ type: "text", text: "ok" }] });
	const { call, store, notes, runtime, http } = setup({ token: APP_TOKEN_NAME, scriptedModel: script });
	try {
		const chat = store.resolve(appAddress("pin-desk"), "/workshop");
		const path = "/api/app/conversations/pin-desk";
		const local = notes.create({ title: "Local reading list" });
		const global = notes.create({ title: "Global checklist" });
		notes.batch([{ id: global.id, stateRev: global.stateRev }], { action: "move", owner: { botId: null } });
		const pin = (noteId: string) => call(`${path}/note-pins`, {
			method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ noteId, pinned: true }),
		});
		const pins = async () => {
			const list = await (await call(`${path}/note-pins`)).json() as ChatNotePinsView;
			return list.pins.map(({ id }) => id);
		};
		const turn = async (n: number, text: string) => {
			const response = await call("/api/app/chat", {
				method: "POST", headers: jsonHeaders, body: JSON.stringify({
					conversationId: chat.id,
					message: { id: `u${n}`, role: "user", parts: [{ type: "text", text }] },
				}),
			});
			expect(response.status).toBe(202);
			await waitUntil(() => store.history(chat.id).length === n * 2 && !runtime.busy(chat.id), "reply persisted");
			return script.requests().at(-1)!;
		};
		expect((await pin(local.id)).status).toBe(200);
		expect((await pin(global.id)).status).toBe(200);
		const first = await turn(1, "Before promotion");
		expect(first).toContain("Local reading list");
		expect(first).toContain("Global checklist");
		expect(first.match(/Note pinned\./g)).toHaveLength(2);
		const converted = await call(`${path}/convert-to-bot`, {
			method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: "Desk" }),
		});
		expect(converted.status).toBe(201);
		const bot = (await converted.json()) as AppBot;
		expect(await pins()).toEqual([global.id]);
		expect((await call(`/api/app/bots/${bot.id}/move-back`, {
			method: "POST", headers: jsonHeaders, body: "{}",
		})).status).toBe(200);
		expect(await pins()).toEqual([global.id]);
		const second = await turn(2, "After move back");
		expect(second.match(/is no longer available/g)).toHaveLength(1);
		expect(second).toContain(`${local.id}\\" is no longer available`);
		expect(second.match(/Note pinned\./g)).toHaveLength(2);
		const third = await turn(3, "One more turn");
		expect(third.match(/is no longer available/g)).toHaveLength(1);
		expect(third.match(/Note pinned\./g)).toHaveLength(2);
		expect(await pins()).toEqual([global.id]);
		expect((await pin(local.id)).status).toBe(200);
		expect(await pins()).toEqual([global.id, local.id]);
	} finally {
		http.stop();
		await runtime.shutdown();
		store.close();
	}
});

test("converting a side chat keeps its transcript, prompt, and settings through retries", async () => {
	const { call, store, http, projects } = setup({ token: APP_TOKEN_NAME });
	try {
		const chat = store.resolve(appAddress("workshop"), "/workshop", { model: "zai/m", thinking: "high" });
		store.setMeta(chat.id, { title: "Workshop", pinned: true, memoryExcluded: true });
		store.append(chat.id, [{ id: "u1", role: "user", parts: [{ type: "text", text: "Set a date." }] }]);
		store.savePromptSnapshot(chat.id, "Frozen prompt\n", ["SOUL.md"]);
		const metadata = store.get(chat.id);
		const snapshot = store.promptSnapshot(chat.id);
		const historyPath = "/api/app/conversations/workshop/messages";
		const messages = await (await call(historyPath)).text();
		const path = "/api/app/conversations/workshop/convert-to-bot";
		const convert = (name: string) => call(path, {
			method: "POST",
			headers: jsonHeaders,
			body: JSON.stringify({ name }),
		});
		const [first, second] = await Promise.all([convert(" Workshop "), convert(" Workshop ")]);
		expect([first.status, second.status].sort()).toEqual([200, 201]);
		const bot = (await first.json()) as AppBot;
		expect(bot).toEqual({
			id: expect.stringMatching(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/),
			name: "Workshop",
			instructions: "",
			folder: null,
			model: null,
			thinking: null,
			mainConversationId: chat.id,
			sideConversationIds: [],
			canMoveBack: true,
		});
		expect(await second.json()).toEqual(bot);
		const list = await call("/api/app/conversations");
		expect(await list.json()).toMatchObject({ bots: [bot] });
		expect(await (await call(historyPath)).text()).toBe(messages);
		expect(store.promptSnapshot(chat.id)).toEqual(snapshot);
		expect(store.get(chat.id)).toEqual(metadata);

		const project = projects.create({ name: "Old project" });
		expect((await call("/api/app/conversations/workshop", {
			method: "PATCH",
			headers: jsonHeaders,
			body: JSON.stringify({ projectId: project.id }),
		})).status).toBe(409);
		expect((await call("/api/app/conversations/workshop", {
			method: "PATCH",
			headers: jsonHeaders,
			body: JSON.stringify({ archived: true }),
		})).status).toBe(409);
		expect((await call("/api/app/conversations/workshop", { method: "DELETE" })).status).toBe(409);
		expect(await (await convert("Other name")).json()).toEqual(bot);

		const botPath = `/api/app/bots/${bot.id}`;
		const rename = await call(botPath, {
			method: "PATCH",
			headers: jsonHeaders,
			body: JSON.stringify({ name: " Repair desk " }),
		});
		expect(await rename.json()).toEqual({ ...bot, name: "Repair desk" });
		const undo = () => call(`${botPath}/move-back`, {
			method: "POST", headers: jsonHeaders, body: "{}",
		});
		const response = await undo();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ conversationId: chat.id });
		expect(store.bots.membership(chat.id)).toBeNull();
		expect(await (await call("/api/app/conversations")).json()).toMatchObject({ bots: [] });
		expect(await (await call(historyPath)).text()).toBe(messages);
		expect(store.promptSnapshot(chat.id)).toEqual(snapshot);
		expect(store.get(chat.id)).toEqual(metadata);
		expect((await undo()).status).toBe(404);

		const convertedAgain = await convert("Workshop");
		expect(convertedAgain.status).toBe(201);
		expect(((await convertedAgain.json()) as AppBot).id).not.toBe(bot.id);
	} finally {
		http.stop();
		store.close();
	}
});

test("a bot's instructions and folder round-trip without a rename", async () => {
	const { call, store, http } = setup({ token: APP_TOKEN_NAME });
	try {
		store.resolve(appAddress("bot-settings"), "/workshop");
		const converted = await call("/api/app/conversations/bot-settings/convert-to-bot", {
			method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: "Workshop" }),
		});
		expect(converted.status).toBe(201);
		const bot = (await converted.json()) as AppBot;
		const update = (body: object) => call(`/api/app/bots/${bot.id}`, {
			method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body),
		});
		expect((await update({ folder: "../relative" })).status).toBe(422);
		expect((await update({})).status).toBe(422);
		const patch = { instructions: "  Keep the inventory.\n", folder: "/workshop/bot" };
		const changed = await update(patch);
		expect(changed.status).toBe(200);
		expect(await changed.json()).toEqual({ ...bot, ...patch });
		expect(await (await call("/api/app/conversations")).json()).toMatchObject({
			bots: [{ ...bot, ...patch }],
		});
		const cleared = await update({ folder: null });
		expect(cleared.status).toBe(200);
		expect(await cleared.json()).toEqual({ ...bot, instructions: patch.instructions });
	} finally {
		http.stop();
		store.close();
	}
});

test("bot model and thinking settings validate, list, and clear", async () => {
	const { call, store, http } = setup({ token: APP_TOKEN_NAME });
	try {
		store.resolve(appAddress("bot-model"), "/workshop");
		const converted = await call("/api/app/conversations/bot-model/convert-to-bot", {
			method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: "Model bot" }),
		});
		const bot = await converted.json() as AppBot;
		const patch = (body: object) => call(`/api/app/bots/${bot.id}`, {
			method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body),
		});
		expect((await patch({ model: "zai/m", thinking: "high" })).status).toBe(200);
		expect(await (await call("/api/app/conversations")).json()).toMatchObject({
			bots: [{ id: bot.id, model: "zai/m", thinking: "high" }],
		});
		expect((await patch({ model: "ghost/nope" })).status).toBe(422);
		expect(store.bots.get(bot.id)?.model).toBe("zai/m");
		expect((await patch({ thinking: "invalid" })).status).toBe(422);
		expect((await patch({ model: null, thinking: null })).status).toBe(200);
	} finally {
		http.stop();
		store.close();
	}
});

test("bot memory returns null for an absent file and reads a present file", async () => {
	const { call, store, http } = setup({ token: APP_TOKEN_NAME });
	const root = mkdtempSync(join(tmpdir(), "goblin-bot-memory-"));
	try {
		store.resolve(appAddress("bot-memory"), "/workshop");
		const converted = await call("/api/app/conversations/bot-memory/convert-to-bot", {
			method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: "Memory bot" }),
		});
		const bot = await converted.json() as AppBot;
		const memory = () => call(`/api/app/bots/${bot.id}/memory`);
		expect(await (await memory()).json()).toEqual({ path: null, text: null });
		const update = await call(`/api/app/bots/${bot.id}`, {
			method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ folder: root }),
		});
		expect(update.status).toBe(200);
		expect(await (await memory()).json()).toEqual({ path: join(root, "MEMORY.md"), text: null });
		writeFileSync(join(root, "MEMORY.md"), "Remember the stockroom.");
		expect(await (await memory()).json()).toEqual({
			path: join(root, "MEMORY.md"), text: "Remember the stockroom.",
		});
		writeFileSync(join(root, "MEMORY.md"), "x".repeat(70 * 1024));
		const truncated = await (await memory()).json() as { path: string; text: string };
		expect(Buffer.byteLength(truncated.text)).toBe(64 * 1024);
	} finally {
		http.stop();
		store.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test("move back checks current ownership after reading the request", async () => {
	const { call, store, appDeps, http } = setup({ token: APP_TOKEN_NAME });
	try {
		const main = store.resolve(appAddress("desk"), "/workshop");
		store.append(main.id, [{ id: "u1", role: "user", parts: [{ type: "text", text: "Make a plan." }] }]);
		const converted = await call("/api/app/conversations/desk/convert-to-bot", {
			method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: "Desk" }),
		});
		expect(converted.status).toBe(201);
		const bot = (await converted.json()) as AppBot;
		const path = `/api/app/bots/${bot.id}/move-back`;
		const url = new URL(path, "http://localhost");
		const reading = deferred();
		const resume = deferred();
		const moving = handleBotsRoute(new Request(url.href, {
			method: "POST",
			headers: jsonHeaders,
			body: new ReadableStream<Uint8Array>({
				async pull(controller) {
					reading.resolve();
					await resume.promise;
					controller.enqueue(new TextEncoder().encode("{}"));
					controller.close();
				},
			}),
		}), url, appDeps);
		await reading.promise;
		const branch = await call("/api/app/conversations/desk/branch", {
			method: "POST", headers: jsonHeaders, body: JSON.stringify({ messageId: "u1" }),
		});
		resume.resolve();
		expect(branch.status).toBe(201);
		const { id } = (await branch.json()) as { id: string };
		expect(await (await call("/api/app/conversations")).json()).toMatchObject({
			bots: [{ ...bot, sideConversationIds: [id], canMoveBack: false }],
		});
		expect((await moving)?.status).toBe(409);
		expect(store.bots.membership(main.id)?.botId).toBe(bot.id);
	} finally {
		http.stop();
		store.close();
	}
});

test("a note created through the chat tool follows its bot and blocks move back", async () => {
	const { call, store, notes, projects, http } = setup({ token: APP_TOKEN_NAME });
	try {
		const chat = store.resolve(appAddress("desk"), "/workshop");
		const tool = noteTool({ notes, projects, conversation: chat.id, projectId: chat.projectId });
		const create = (title: string) => tool.execute({ action: "create", title }, { toolCallId: title });
		expect(await create("Before conversion")).toMatchObject({ created: true });
		const converted = await call("/api/app/conversations/desk/convert-to-bot", {
			method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: "Desk" }),
		});
		expect(converted.status).toBe(201);
		const bot = (await converted.json()) as AppBot;
		expect(bot.canMoveBack).toBe(true);
		expect(await create("After conversion")).toMatchObject({ created: true });
		const [before] = notes.list({ q: "Before conversion" });
		const [after] = notes.list({ q: "After conversion" });
		const pinPath = "/api/app/conversations/desk/note-pins";
		const pin = await call(pinPath, {
			method: "PATCH", headers: jsonHeaders, body: JSON.stringify({ noteId: after!.id, pinned: true }),
		});
		expect(pin.status).toBe(200);
		expect(await tool.execute({ action: "append", id: before!.id, text: "Added from Desk" }, { toolCallId: "append" }))
			.toEqual({ error: `note ${before!.id} belongs to another bot; this chat can't use it` });
		expect((await (await call(`/api/app/notes/${before!.id}/edits`)).json())).toMatchObject({ edits: [
			{ rev: 1, author: { botId: LITTLE_GOBLIN_NOTE_OWNER, name: "Little Goblin" } },
		] });
		expect((await (await call(`/api/app/notes/${after!.id}/edits`)).json())).toMatchObject({ edits: [
			{ rev: 1, author: { botId: bot.id, name: "Desk" } },
		] });

		const listed = await (await call("/api/app/notes")).json();
		expect(listed).toMatchObject({ notes: expect.arrayContaining([
			expect.objectContaining({ title: "Before conversion", botId: LITTLE_GOBLIN_NOTE_OWNER }),
			expect.objectContaining({ title: "After conversion", botId: bot.id }),
		]) });
		expect(await (await call("/api/app/conversations")).json()).toMatchObject({
			bots: [{ ...bot, canMoveBack: false }],
		});
		const refused = await call(`/api/app/bots/${bot.id}/move-back`, {
			method: "POST", headers: jsonHeaders, body: "{}",
		});
		expect(refused.status).toBe(409);
		expect(await (await call(pinPath)).json()).toMatchObject({ pins: [{ id: after!.id }] });
		notes.batch([{ id: after!.id, stateRev: after!.stateRev }], { action: "move", owner: { botId: null } });
		const moved = await call(`/api/app/bots/${bot.id}/move-back`, {
			method: "POST", headers: jsonHeaders, body: "{}",
		});
		expect(moved.status).toBe(200);
		expect(await (await call(pinPath)).json()).toMatchObject({ pins: [{ id: after!.id, owner: "Global" }] });
	} finally {
		http.stop();
		store.close();
	}
});

test("saving a note card in a bot chat uses that chat's current owner", async () => {
	const { call, store, http } = setup({ token: APP_TOKEN_NAME });
	try {
		const chat = store.resolve(appAddress("card"), "/workshop");
		const converted = await call("/api/app/conversations/card/convert-to-bot", {
			method: "POST", headers: jsonHeaders, body: JSON.stringify({ name: "Desk" }),
		});
		expect(converted.status).toBe(201);
		const bot = (await converted.json()) as AppBot;
		const save = (conversation?: string) => call("/api/app/notes", {
			method: "POST", headers: jsonHeaders,
			body: JSON.stringify({ title: "Parts list", body: "A spool", conversation }),
		});
		const response = await save(chat.id);
		expect(response.status).toBe(201);
		expect(await response.json()).toMatchObject({ botId: bot.id, body: "A spool" });
		expect(await (await call("/api/app/conversations")).json()).toMatchObject({
			bots: [{ ...bot, canMoveBack: false }],
		});
		expect((await save("dm:1")).status).toBe(422);
		expect((await save("app/missing")).status).toBe(404);
		expect(await (await save()).json()).toMatchObject({ botId: LITTLE_GOBLIN_NOTE_OWNER });
	} finally {
		http.stop();
		store.close();
	}
});

test("conversion validates the source and rechecks eligibility after reading the request", async () => {
	const { call, store, projects, configRef, appDeps, http } = setup({ token: APP_TOKEN_NAME });
	try {
		const chat = store.resolve(appAddress("race"), "/workshop");
		const projectChat = store.resolve(appAddress("project-chat"), "/workshop");
		const project = projects.create({ name: "Workshop" });
		store.bindProject(projectChat.id, project.id);
		const rolling = store.rollApp(configRef.current);
		const body = JSON.stringify({ name: "Workshop" });
		const post = (id: string, name: string = body) => call(
			`/api/app/conversations/${appIdOf(id)}/convert-to-bot`,
			{ method: "POST", headers: jsonHeaders, body: name },
		);
		expect((await post(chat.id, JSON.stringify({ name: "   " }))).status).toBe(422);
		expect((await post("app/missing")).status).toBe(404);
		expect((await post(rolling.id)).status).toBe(409);
		expect((await post(projectChat.id)).status).toBe(409);

		const reading = deferred();
		const resume = deferred();
		const url = new URL("http://localhost/api/app/conversations/race/convert-to-bot");
		const conversion = handleBotsRoute(new Request(url.href, {
			method: "POST",
			headers: jsonHeaders,
			body: new ReadableStream<Uint8Array>({
				async pull(controller) {
					reading.resolve();
					await resume.promise;
					controller.enqueue(new TextEncoder().encode(body));
					controller.close();
				},
			}),
		}), url, appDeps);
		await reading.promise;
		const archived = await call("/api/app/conversations/race", {
			method: "PATCH",
			headers: jsonHeaders,
			body: JSON.stringify({ archived: true }),
		});
		resume.resolve();
		expect(archived.status).toBe(200);
		const result = await conversion;
		expect(result?.status).toBe(409);
		expect(await result?.json()).toEqual({ error: "Unarchive this chat before converting it." });
		expect(store.bots.membership(chat.id)).toBeNull();
	} finally {
		http.stop();
		store.close();
	}
});

import { expect, test } from "bun:test";
import { noteTool } from "../agent/tools/note.ts";
import { appAddress, appIdOf } from "../conversation-address.ts";
import { LITTLE_GOBLIN_NOTE_OWNER } from "../note-owner.ts";
import { deferred } from "../testkit.ts";
import { handleBotsRoute } from "./app-bots.ts";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";
import type { AppBot } from "./app-wire.ts";

const jsonHeaders = { "content-type": "application/json" };

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

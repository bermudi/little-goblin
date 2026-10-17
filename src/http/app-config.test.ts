import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appAddress, openStore } from "../conversation.ts";
import { handleAppApi } from "./app-channel.ts";

import { APP_TOKEN_NAME, setup } from "./app-test-util.ts";

describe("app channel http", () => {
	test("config GET reports the live knobs; POST patches model and thinking", async () => {
		const { http, call, configRef, configWrites, home } = setup({ token: APP_TOKEN_NAME });
		try {
			const view = (await (await call("/api/app/config")).json()) as {
				model: string;
				thinking: string;
				favorites: string[];
				thinkingLevels: string[];
			};
			expect(view.model).toBe("zai/m");
			expect(view.thinking).toBe("medium");
			expect(view.thinkingLevels).toContain("medium");

			const write = await call("/api/app/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ thinking: "high" }),
			});
			expect(write.status).toBe(200);
			expect(configRef.current.thinking).toBe("high");
			expect(configWrites.count).toBe(1);
			// The write is durable — the file under GOBLIN_HOME carries it.
			expect(readFileSync(join(home, "goblin.json5"), "utf8")).toContain("'high'");

			const model = await call("/api/app/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "zai/m2" }),
			});
			expect(model.status).toBe(200);
			expect(configRef.current.model).toBe("zai/m2");

			// A ref naming an unconfigured provider fails validation.
			const badModel = await call("/api/app/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "ghost/x" }),
			});
			expect(badModel.status).toBe(422);
			// An empty patch and a bogus level are client bugs, not writes.
			expect(
				(
					await call("/api/app/config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({}),
					})
				).status,
			).toBe(422);
			expect(
				(
					await call("/api/app/config", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ thinking: "ultra" }),
					})
				).status,
			).toBe(422);
		} finally {
			http.stop();
		}
	});
});
test("conversation settings are isolated, durable, validated, and only future chats use changed app defaults", async () => {
	const { http, call, store, configRef, configWrites, home } = setup();
	const patch = (path: string, body: unknown) =>
		call(path, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	try {
		// Legacy row never read through settings: changing defaults still
		// freezes it against the previous selection before writing.
		const legacy = store.resolve(appAddress("legacy-settings"), "/work");
		const create = (id: string) =>
			call("/api/app/conversations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id }),
			});
		await create("settings-a");
		await create("settings-b");
		const a = "/api/app/conversations/settings-a/config";
		const epoch = store.get("app/settings-a")!.epoch;
		expect((await patch(a, { model: "zai/personal", thinking: "high" })).status).toBe(200);
		expect(store.get("app/settings-a")!.epoch).toBe(epoch);
		expect(configWrites.count).toBe(0);
		expect(store.get("app/settings-b")).toMatchObject({ model: "zai/m", thinking: "medium" });
		expect((await patch(a, { model: "missing/x" })).status).toBe(422);
		expect((await patch(a, { model: "bare" })).status).toBe(422);
		const sentinel = "CONFIG_FAKE_SECRET_SENTINEL";
		for (const path of [a, "/api/app/config"]) {
			const refused = await patch(path, { model: sentinel });
			expect(refused.status).toBe(422);
			expect(await refused.text()).not.toContain(sentinel);
		}
		expect((await patch(a, { thinking: "invalid" })).status).toBe(422);
		expect((await patch(a, {})).status).toBe(422);
		expect(
			(await patch("/api/app/conversations/not-created/config", { model: "zai/x" })).status,
		).toBe(404);
		expect(store.get("app/not-created")).toBeNull();
		store.resolve({ kind: "dm", chatId: 42 }, "/work");
		expect((await patch("/api/app/conversations/dm%3A42/config", { model: "zai/x" })).status).toBe(
			404,
		);
		expect(
			(await patch("/api/app/conversations/app%2Fsettings-a/config", { model: "zai/x" })).status,
		).toBe(404);
		expect((await patch("/api/app/config", { model: "zai/future", thinking: "low" })).status).toBe(
			200,
		);
		expect(configRef.current.telegram).toMatchObject({ model: "zai/m", thinking: "medium" });
		expect(store.get(legacy.id)).toMatchObject({ model: "zai/m", thinking: "medium" });
		await create("settings-future");
		await create("settings-a"); // idempotent create never resets settings
		expect(store.get("app/settings-future")).toMatchObject({
			model: "zai/future",
			thinking: "low",
		});
		const view = await (await call(a)).json();
		expect(view).toMatchObject({
			model: "zai/personal",
			thinking: "high",
			favorites: [],
			thinkingLevels: expect.any(Array),
		});
		store.close();
		const reopened = openStore(join(home, "goblin.sqlite"));
		try {
			expect(reopened.get("app/settings-a")).toMatchObject({
				model: "zai/personal",
				thinking: "high",
			});
		} finally {
			reopened.close();
		}
	} finally {
		http.stop();
	}
});

test("conversation PATCH rechecks the live registry and row after awaiting its request body", async () => {
	const { http, store, configRef, appDeps } = setup();
	const row = store.resolve(appAddress("held-config"), "/work", configRef.current);
	async function heldPatch(body: unknown, mutate: () => void): Promise<Response> {
		let release: () => void = () => {};
		let entered: () => void = () => {};
		const waiting = new Promise<void>((r) => {
			release = r;
		});
		const reading = new Promise<void>((r) => {
			entered = r;
		});
		class HeldRequest extends Request {
			override json = async (): Promise<unknown> => {
				entered();
				await waiting;
				return body;
			};
		}
		const url = new URL("http://localhost/api/app/conversations/held-config/config");
		const pending = handleAppApi(
			new HeldRequest(url.href, {
				method: "PATCH",
				// The route's wire contract: JSON mutations must claim
				// application/json (#75) — the held json() below is reached
				// only past that line.
				headers: { "content-type": "application/json" },
			}),
			url,
			undefined,
			appDeps,
		);
		await reading;
		mutate();
		release();
		return pending;
	}
	try {
		configRef.current.providers.other = { kind: "codex" };
		expect(
			(
				await heldPatch({ model: "other/chat" }, () => {
					delete configRef.current.providers.other;
				})
			).status,
		).toBe(422);
		expect(store.get(row.id)!.model).toBe("zai/m");
		expect(
			(await heldPatch({ thinking: "high" }, () => store.deleteConversation(row.id))).status,
		).toBe(404);
		expect(store.get(row.id)).toBeNull();
	} finally {
		http.stop();
		store.close();
	}
});

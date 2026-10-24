import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_TOKEN_NAME, setup } from "./app-testing.ts";

describe("app config", () => {
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
			expect(readFileSync(join(home, "goblin.json5"), "utf8")).toContain("'high'");

			const model = await call("/api/app/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "zai/m2" }),
			});
			expect(model.status).toBe(200);
			expect(configRef.current.model).toBe("zai/m2");

			// glm-5.3 has no xhigh — the write persists the rung the wire
			// clamp would send. The pinned telegram pair keeps its own
			// model's ladder, where its stored medium is real.
			const clamped = await call("/api/app/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "zai/glm-5.3", thinking: "xhigh" }),
			});
			expect(clamped.status).toBe(200);
			expect(configRef.current.model).toBe("zai/glm-5.3");
			expect(configRef.current.thinking).toBe("max");
			expect(configRef.current.telegram).toMatchObject({ model: "zai/m", thinking: "medium" });

			const badModel = await call("/api/app/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "ghost/x" }),
			});
			expect(badModel.status).toBe(422);
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

	test("config GET carries the providers' model catalogs", async () => {
		const { http, call } = setup({ token: APP_TOKEN_NAME });
		try {
			const view = (await (await call("/api/app/config")).json()) as {
				catalog: { provider: string; models: unknown[] }[];
			};
			// The rig's models.dev cache is cold — the provider lists, with
			// no options; a warm cache would fill `models` the same way.
			expect(view.catalog).toEqual([{ provider: "zai", models: [] }]);
		} finally {
			http.stop();
		}
	});

	test("POST /api/app/favorites adds and removes refs idempotently", async () => {
		const { http, call, configRef, configWrites, home } = setup({ token: APP_TOKEN_NAME });
		try {
			const toggle = (body: unknown) =>
				call("/api/app/favorites", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});

			const add = await toggle({ ref: "zai/glm-5.3", on: true });
			expect(add.status).toBe(200);
			expect(((await add.json()) as { favorites: string[] }).favorites).toEqual(["zai/glm-5.3"]);
			expect(configRef.current.favorites).toEqual(["zai/glm-5.3"]);
			expect(readFileSync(join(home, "goblin.json5"), "utf8")).toContain("zai/glm-5.3");

			// Re-adding is a no-op write, not a duplicate.
			const again = await toggle({ ref: "zai/glm-5.3", on: true });
			expect(again.status).toBe(200);
			expect(((await again.json()) as { favorites: string[] }).favorites).toEqual(["zai/glm-5.3"]);

			const second = await toggle({ ref: "zai/m", on: true });
			expect(((await second.json()) as { favorites: string[] }).favorites).toEqual([
				"zai/glm-5.3",
				"zai/m",
			]);

			const remove = await toggle({ ref: "zai/glm-5.3", on: false });
			expect(remove.status).toBe(200);
			expect(((await remove.json()) as { favorites: string[] }).favorites).toEqual(["zai/m"]);
			// Removing what isn't there is still a 200 — the list is truth.
			const removeAbsent = await toggle({ ref: "zai/glm-5.3", on: false });
			expect(removeAbsent.status).toBe(200);
			expect(((await removeAbsent.json()) as { favorites: string[] }).favorites).toEqual(["zai/m"]);
			expect(configWrites.count).toBe(5);

			// The app config view reports the same list back.
			const view = (await (await call("/api/app/config")).json()) as {
				favorites: string[];
			};
			expect(view.favorites).toEqual(["zai/m"]);
		} finally {
			http.stop();
		}
	});

	test("POST /api/app/favorites refuses bad refs but lets them leave", async () => {
		const { http, call, configRef, home } = setup({ token: APP_TOKEN_NAME });
		try {
			const toggle = (body: unknown) =>
				call("/api/app/favorites", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				});

			// Adds validate: a configured provider and a real ref shape.
			expect((await toggle({ ref: "ghost/x", on: true })).status).toBe(422);
			expect((await toggle({ ref: "no-slash", on: true })).status).toBe(422);
			expect((await toggle({ ref: "", on: true })).status).toBe(422);
			expect((await toggle({ ref: "zai/m" })).status).toBe(422);
			expect(configRef.current.favorites).toEqual([]);

			// A malformed stale entry already in the file is removable —
			// the off path takes any string.
			writeFileSync(
				join(home, "goblin.json5"),
				`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.example.com",auth:"zai"}},model:"zai/m",favorites:["bogus","zai/m"],operators:[42]}\n`,
			);
			const removed = await toggle({ ref: "bogus", on: false });
			expect(removed.status).toBe(200);
			expect(((await removed.json()) as { favorites: string[] }).favorites).toEqual(["zai/m"]);
			expect(configRef.current.favorites).toEqual(["zai/m"]);
		} finally {
			http.stop();
		}
	});

	test("a disabled telegram pin survives app config writes untouched", async () => {
		const { http, call, configRef, home } = setup({ token: APP_TOKEN_NAME });
		try {
			// The dormant pin points at a provider still present; a removed one
			// would parse too — the write path just must not re-validate or
			// re-clamp it.
			writeFileSync(
				join(home, "goblin.json5"),
				`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.example.com",auth:"zai"},gone:{kind:"openai-compatible",baseUrl:"https://api.example.com",auth:"gone"}},model:"zai/m",operators:[],telegram:{enabled:false,model:"gone/glm-5.3",thinking:"xhigh"}}\n`,
			);
			const write = await call("/api/app/config", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: "zai/glm-5.3", thinking: "xhigh" }),
			});
			expect(write.status).toBe(200);
			// The live app model still clamps onto its own ladder…
			expect(configRef.current.thinking).toBe("max");
			// …but the dormant pin is dormant state — model and thinking
			// pass through untouched until re-enable.
			expect(configRef.current.telegram).toMatchObject({
				enabled: false,
				model: "gone/glm-5.3",
				thinking: "xhigh",
			});
		} finally {
			http.stop();
		}
	});
});

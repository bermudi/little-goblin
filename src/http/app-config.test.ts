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

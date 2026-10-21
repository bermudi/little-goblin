import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
});

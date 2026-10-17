// Read-only drift check: GET /openapi.json only, never banks, memories, auth
// resolution, provider calls or writes. Run after a Hindsight upgrade:
// GOBLIN_MEMORY_LIVE=1 bun test src/hindsight.live.test.ts
import { expect, test } from "bun:test";
import { z } from "zod";
import { hindsightConnectionSchema } from "./hindsight.ts";

const schema = z.object({
	info: z.object({ version: z.string() }),
	paths: z.record(z.string(), z.unknown()),
	components: z.object({
		schemas: z.record(
			z.string(),
			z.object({
				properties: z.record(z.string(), z.unknown()).optional(),
			}),
		),
	}),
});

test.skipIf(process.env.GOBLIN_MEMORY_LIVE !== "1")(
	"live Hindsight memory wire contract",
	async () => {
		const base = hindsightConnectionSchema.shape.baseUrl.safeParse(
			process.env.GOBLIN_MEMORY_URL ?? "http://127.0.0.1:8888",
		);
		if (!base.success) throw new Error("Invalid memory drift-check URL");
		const response = await fetch(`${base.data.replace(/\/+$/, "")}/openapi.json`, {
			redirect: "error",
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) throw new Error(`Memory OpenAPI returned HTTP ${response.status}`);
		const contract = schema.parse(await response.json());
		expect(contract.paths).toHaveProperty("/v1/default/banks/{bank_id}/reflect");
		const models = contract.components.schemas;
		expect(models.RecallRequest?.properties).toHaveProperty("prefer_observations");
		expect(models.RecallRequest?.properties).toHaveProperty("min_scores");
		expect(models.RecallResult?.properties).toHaveProperty("scores");
		expect(models.RecallScores?.properties).toHaveProperty("semantic");
		expect(models.ReflectRequest?.properties).toHaveProperty("include");
		expect(models.ReflectIncludeOptions?.properties).toHaveProperty("facts");
		expect(models.FactsIncludeOptions?.properties).toEqual({});
		expect(models.ReflectResponse?.properties).toHaveProperty("based_on");
		expect(models.ReflectBasedOn?.properties).toHaveProperty("memories");
	},
);

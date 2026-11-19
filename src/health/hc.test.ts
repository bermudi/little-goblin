import { expect, test } from "bun:test";
import { join } from "node:path";
import { hcCore } from "./hc.ts";

test("hc health skips when delegation is disabled", async () => {
	const result = await hcCore("/missing/home", false);
	expect(result).toMatchObject({
		id: "delegation.hc",
		status: "skip",
	});
});

test("hc health fails when the pinned binary is missing", async () => {
	const result = await hcCore(join("/missing", "home"), true);
	expect(result).toMatchObject({
		id: "delegation.hc",
		status: "fail",
	});
	expect(result.detail).toContain("Pinned herdr-core binary is missing");
});

// Live drift check for the codex model catalog — run after a codex
// backend change, a CODEX_CLIENT_VERSION bump, or an adapter change to
// the catalog path:
//
//   GOBLIN_CODEX_LIVE=1 bun test src/agent/codex/models.live.test.ts
//
// One read-only GET on the operator's own codex auth — no generation,
// nothing billed, nothing written. It pins the wire fields
// src/agent/codex/models.ts consumes: a non-empty models array whose
// entries carry slug/display_name/priority/visibility/supported_in_api
// in the expected types, at least one visibility:"list" row, and the
// client_version gate answering (a too-old version must answer 200
// with an empty list — the field exists, not the models). Never print
// tokens or account ids; assertions are on shapes only. Red means the
// contract moved: re-pin the endpoint and headers against the codex
// CLI's own request, then fix the adapter.

import { expect, test } from "bun:test";
import { codexCredentials, resolveCodexAuthFile } from "./auth.ts";
import { CODEX_CLIENT_VERSION } from "./models.ts";

const LIVE = process.env.GOBLIN_CODEX_LIVE === "1";

test("the codex models endpoint answers the pinned shape (live)", async () => {
	if (!LIVE) return;
	const auth = await codexCredentials(resolveCodexAuthFile(undefined).path);
	const headers = {
		authorization: `Bearer ${auth.tokens.access_token}`,
		...(auth.tokens.account_id ? { "chatgpt-account-id": auth.tokens.account_id } : {}),
		"OpenAI-Beta": "responses=experimental",
		originator: "codex_cli_rs",
	};
	const get = (v: string) =>
		fetch(`https://chatgpt.com/backend-api/codex/models?client_version=${v}`, {
			headers,
			signal: AbortSignal.timeout(15_000),
		});

	const res = await get(CODEX_CLIENT_VERSION);
	expect(res.status).toBe(200);
	const body = (await res.json()) as { models?: Record<string, unknown>[] };
	expect(Array.isArray(body.models)).toBe(true);
	expect(body.models!.length).toBeGreaterThan(0);
	for (const m of body.models!) {
		expect(typeof m.slug).toBe("string");
		expect(typeof m.priority).toBe("number");
		expect(typeof m.visibility).toBe("string");
		expect(typeof m.supported_in_api).toBe("boolean");
	}
	expect(body.models!.some((m) => m.visibility === "list")).toBe(true);
	// display_name may be absent on rows — where present it is a string.
	for (const m of body.models!.filter((m) => m.display_name !== undefined)) {
		expect(typeof m.display_name).toBe("string");
	}

	// The gate is real: an ancient client version lists nothing.
	const gated = await get("0.62.0");
	expect(gated.status).toBe(200);
	const gatedBody = (await gated.json()) as { models?: unknown[] };
	expect(gatedBody.models).toEqual([]);
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useHome } from "../../testkit.ts";
import {
	_resetCodexModelsForTest,
	CODEX_CLIENT_VERSION,
	codexContextWindow,
	codexModelOptions,
	ensureCodexModels,
} from "./models.ts";

// A plain string token parses as non-JWT → never expired → no refresh
// dance inside a test. account_id rides the request header.
function writeAuth(dir: string, account = "acct-test"): string {
	mkdirSync(join(dir, "state"), { recursive: true });
	const path = join(dir, "state", "codex-auth.json");
	writeFileSync(path, JSON.stringify({ tokens: { access_token: "test-token", account_id: account } }));
	return path;
}

const WIRE = {
	models: [
		{ slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", priority: 1, visibility: "list", supported_in_api: true, context_window: 500000, input_modalities: ["text", "image"], supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
		{ slug: "gpt-reserve", visibility: "hide", supported_in_api: true },
		{ slug: "gpt-6-astra", display_name: "GPT-6 Astra", priority: 2, visibility: "list", supported_in_api: true },
		{ slug: "gpt-api-off", visibility: "list", supported_in_api: false },
		{ slug: "gpt-5.6-luna", priority: 9, visibility: "list" },
	],
};

function fakeFetch(onRequest?: (url: string, headers: Record<string, string>) => void) {
	const prev = globalThis.fetch;
	const calls: { url: string; headers: Record<string, string> }[] = [];
	globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
		calls.push({ url: String(url), headers });
		onRequest?.(String(url), headers);
		return Promise.resolve(new Response(JSON.stringify(WIRE)));
	}) as unknown as typeof fetch;
	return {
		calls,
		restore() {
			globalThis.fetch = prev;
		},
	};
}

describe("codex model catalog", () => {
	afterEach(() => {
		_resetCodexModelsForTest();
	});

	test("the fetch sends codex-cli headers and the client_version gate", async () => {
		const dir = useHome();
		writeAuth(dir);
		const fx = fakeFetch();
		try {
			const models = await ensureCodexModels();
			expect(models?.length).toBe(3);
			expect(fx.calls).toHaveLength(1);
			expect(fx.calls[0]!.url).toBe(
				`https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLIENT_VERSION}`,
			);
			expect(fx.calls[0]!.headers.authorization).toBe("Bearer test-token");
			expect(fx.calls[0]!.headers["chatgpt-account-id"]).toBe("acct-test");
			expect(fx.calls[0]!.headers["openai-beta"]).toBe("responses=experimental");
			expect(fx.calls[0]!.headers.originator).toBe("codex_cli_rs");
		} finally {
			fx.restore();
		}
	});

	test("options keep list+api rows, sorted by priority, with display names", async () => {
		const dir = useHome();
		writeAuth(dir);
		const fx = fakeFetch();
		try {
			await ensureCodexModels();
			expect(codexModelOptions()).toEqual([
				{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol", releaseDate: null },
				{ id: "gpt-6-astra", name: "GPT-6 Astra", releaseDate: null },
				{ id: "gpt-5.6-luna", name: null, releaseDate: null },
			]);
		} finally {
			fx.restore();
		}
	});

	test("the disk cache serves a cold read without a fetch", async () => {
		const dir = useHome();
		writeAuth(dir);
		const fx = fakeFetch();
		try {
			await ensureCodexModels();
			_resetCodexModelsForTest();
			fx.calls.length = 0;
			globalThis.fetch = (() => {
				throw new Error("offline — memory cleared, disk must serve");
			}) as unknown as typeof fetch;
			// readDisk answers the cold read; no ensure is kicked, so the
			// throwing fetch must never fire at all.
			const options = codexModelOptions();
			expect(options.map((o) => o.id)).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-luna"]);
		} finally {
			fx.restore();
		}
	});

	test("a missing login degrades to an empty list and arms the backoff", async () => {
		const dir = useHome();
		mkdirSync(join(dir, "state"), { recursive: true });
		const prev = globalThis.fetch;
		globalThis.fetch = (() => Promise.reject(new Error("must not be called"))) as unknown as typeof fetch;
		try {
			expect(await ensureCodexModels()).toBeNull();
			expect(codexModelOptions()).toEqual([]);
			// Backoff armed: a second read kicks no second auth attempt.
			expect(codexModelOptions()).toEqual([]);
		} finally {
			globalThis.fetch = prev;
		}
	});

	test("codexContextWindow reads the account's own context_window", async () => {
		const dir = useHome();
		writeAuth(dir);
		const fx = fakeFetch();
		try {
			// Cold memory and disk: null, and the fetch is kicked for next turn.
			expect(codexContextWindow("gpt-6.1-sol")).toBeNull();
			await ensureCodexModels();
			expect(codexContextWindow("gpt-6.1-sol")).toBe(500_000);
			// A listed row without a context_window is unknown, not a guess.
			expect(codexContextWindow("gpt-6-astra")).toBeNull();
			// An unlisted slug is unknown too.
			expect(codexContextWindow("gpt-9-ghost")).toBeNull();
		} finally {
			fx.restore();
		}
	});

	test("codexContextWindow serves the disk cache without a fetch", async () => {
		const dir = useHome();
		writeAuth(dir);
		const fx = fakeFetch();
		try {
			await ensureCodexModels();
			_resetCodexModelsForTest();
			fx.calls.length = 0;
			globalThis.fetch = (() => {
				throw new Error("offline — memory cleared, disk must serve");
			}) as unknown as typeof fetch;
			// readDisk answers the cold read; no ensure is kicked, so the
			// throwing fetch must never fire at all.
			expect(codexContextWindow("gpt-6.1-sol")).toBe(500_000);
		} finally {
			fx.restore();
		}
	});

	test("each auth file gets its own cache file and in-memory lane", async () => {
		const dir = useHome();
		const a = writeAuth(dir);
		const b = join(dir, "state", "other-auth.json");
		writeFileSync(b, JSON.stringify({ tokens: { access_token: "test-token" } }));
		const fx = fakeFetch();
		try {
			await ensureCodexModels(a);
			await ensureCodexModels(b);
			expect(fx.calls).toHaveLength(2);
			// No account_id in b's file → the header is omitted, not empty.
			expect("chatgpt-account-id" in fx.calls[1]!.headers).toBe(false);
			const caches = readdirSync(join(dir, "state")).filter((f) => f.startsWith("codex-models-"));
			expect(caches).toHaveLength(2);
		} finally {
			fx.restore();
		}
	});
});

// The step builder's context-window source: a codex slug reads the
// account's own /codex/models catalog (its context_window replaces the
// models.dev borrow — models.dev has no codex key); the models.dev
// borrow stays the fallback for a cold codex catalog, in buildStep and
// in the compaction pass's window lookup alike.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAuth } from "../auth.ts";
import { openCacheObservation } from "../cache-observation.ts";
import type { Config } from "../config.ts";
import { captureConversationSettings } from "../conversation.ts";
import { _resetModelsDevForTest } from "./models-dev.ts";
import { openNotes } from "../notes.ts";
import { openProjects } from "../projects.ts";
import { openTestStore, useHome } from "../testkit.ts";
import { _resetCodexModelsForTest, ensureCodexModels } from "./codex/models.ts";
import { makeStepBuilder } from "./step.ts";

function writeCodexAuth(dir: string): string {
	mkdirSync(join(dir, "state"), { recursive: true });
	const path = join(dir, "state", "codex-auth.json");
	writeFileSync(
		path,
		JSON.stringify({ tokens: { access_token: "test-token", account_id: "acct-test" } }),
	);
	return path;
}

// models.dev's cache file — readDisk serves it after a failed fetch
// (a cold in-memory catalog always attempts the network once).
function primeModelsDev(dir: string, catalog: unknown): void {
	mkdirSync(join(dir, "state"), { recursive: true });
	writeFileSync(join(dir, "state", "models.dev.json"), JSON.stringify(catalog));
}

// models.dev's fetch must fail so the primed disk cache is read; the
// codex catalog fetch is served (codexModels) or fails (undefined —
// the cold-catalog case, which arms the backoff).
function fakeFetch(codexModels: unknown): { restore(): void } {
	const prev = globalThis.fetch;
	globalThis.fetch = ((url: string | URL | Request) => {
		const u = String(url);
		if (u.startsWith("https://models.dev/")) return Promise.reject(new Error("offline"));
		if (u.startsWith("https://chatgpt.com/backend-api/codex/models")) {
			if (codexModels === undefined) return Promise.reject(new Error("codex offline"));
			return Promise.resolve(new Response(JSON.stringify(codexModels)));
		}
		return Promise.reject(new Error(`unexpected fetch: ${u}`));
	}) as unknown as typeof fetch;
	return {
		restore() {
			globalThis.fetch = prev;
		},
	};
}

function rig(authFile: string, model: string) {
	// The store lives outside GOBLIN_HOME — openTestStore's own temp dir;
	// catalogs and auth read the home useHome() set for this test.
	const { store } = openTestStore("goblin-step-");
	const cfg: Config = {
		providers: { codex: { kind: "codex", authFile } },
		model,
		tts: false,
		favorites: [],
		thinking: "medium",
		operators: [1],
		allowedUsers: [1],
		telegram: { enabled: true, dmGapMinutes: 45, richReplies: true, showReasoning: false },
		http: { port: 8787 },
		logLevel: "info",
	};
	const projects = openProjects(store);
	const builder = makeStepBuilder({
		configRef: { current: cfg, ttsDown: false },
		auth: loadAuth(),
		store,
		projects,
		notes: openNotes(store, { projects }),
		observation: openCacheObservation(store.db),
	});
	const conv = captureConversationSettings(
		store,
		store.resolve({ kind: "dm", chatId: 1 }, "/w"),
		cfg,
	);
	return { store, ...builder, conv };
}

describe("step builder context window — codex catalog vs models.dev", () => {
	afterEach(() => {
		_resetCodexModelsForTest();
		_resetModelsDevForTest();
	});

	test("a codex conversation reads its account catalog's context_window", async () => {
		const dir = useHome();
		const authFile = writeCodexAuth(dir);
		const fx = fakeFetch({
			models: [
				{
					slug: "gpt-6.1-sol",
					display_name: "GPT-6.1-Sol",
					priority: 1,
					visibility: "list",
					supported_in_api: true,
					context_window: 500_000,
				},
			],
		});
		try {
			await ensureCodexModels(authFile);
			// models.dev does not know the slug at all — the borrow must not fire.
			primeModelsDev(dir, { openai: { models: {} } });
			const r = rig(authFile, "codex/gpt-6.1-sol");
			try {
				const step = await r.buildStep(r.conv, {});
				expect(step.contextWindow).toBe(500_000);
				expect(await r.compaction!.contextWindow(r.conv)).toBe(500_000);
			} finally {
				r.store.close();
			}
		} finally {
			fx.restore();
		}
	});

	test("a cold codex catalog falls back to the models.dev borrow", async () => {
		const dir = useHome();
		const authFile = writeCodexAuth(dir);
		const fx = fakeFetch(undefined);
		try {
			primeModelsDev(dir, {
				openai: { models: { "gpt-6.1-sol": { limit: { context: 400_000 } } } },
			});
			const r = rig(authFile, "codex/gpt-6.1-sol");
			try {
				const step = await r.buildStep(r.conv, {});
				expect(step.contextWindow).toBe(400_000);
				expect(await r.compaction!.contextWindow(r.conv)).toBe(400_000);
			} finally {
				r.store.close();
			}
		} finally {
			fx.restore();
		}
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "grammy";
import type { Config } from "../config.ts";
import { openStore } from "../conversation.ts";
import type { Runtime } from "../runtime.ts";
import { handleCommand, type CommandDeps } from "./commands.ts";

let dirs: string[] = [];
function tmpdb(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-cmd-"));
	dirs.push(dir);
	return join(dir, "goblin.sqlite");
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const config: Config = {
	providers: {
		zai: { kind: "openai-compatible", baseUrl: "https://api.z.ai/v4", auth: "zai" },
	},
	model: "zai/glm-4.6",
	favorites: ["zai/glm-4.6"],
	thinking: "medium",
	allowedUsers: [1],
	telegram: {},
	http: { port: 8787 },
	logLevel: "info",
};

function setup() {
	const store = openStore(tmpdb());
	const conv = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const sent: string[] = [];
	const stopped: string[] = [];
	const deps: CommandDeps = {
		api: {
			sendMessage: async (_chat: number, text: string) => {
				sent.push(text);
				return { message_id: sent.length };
			},
		} as unknown as Api,
		configRef: { current: config },
		store,
		runtime: { stop: (id: string) => stopped.push(id) } as unknown as Runtime,
	};
	return { store, conv, sent, stopped, deps };
}

describe("commands", () => {
	test("/model rejects a ref without provider/model shape", () => {
		const { store, conv, sent, deps } = setup();
		expect(handleCommand(deps, conv, "/model zai")).toBe(true);
		expect(store.get(conv.id)!.model).toBeNull();
		expect(sent[0]).toContain("<provider>/<model-id>");
		store.close();
	});

	test("/model sets an override and bumps the epoch", () => {
		const { store, conv, deps } = setup();
		expect(handleCommand(deps, conv, "/model zai/glm-4.5")).toBe(true);
		const after = store.get(conv.id)!;
		expect(after.model).toBe("zai/glm-4.5");
		expect(after.epoch).toBe(1);
		store.close();
	});

	test("/model rejects an unknown provider", () => {
		const { store, conv, sent, deps } = setup();
		expect(handleCommand(deps, conv, "/model other/x")).toBe(true);
		expect(store.get(conv.id)!.model).toBeNull();
		expect(sent[0]).toContain("unknown provider");
		store.close();
	});

	test("/model reset clears the override", () => {
		const { store, conv, sent, deps } = setup();
		handleCommand(deps, conv, "/model zai/glm-4.5");
		expect(store.get(conv.id)!.model).toBe("zai/glm-4.5");
		handleCommand(deps, conv, "/model reset");
		const after = store.get(conv.id)!;
		expect(after.model).toBeNull();
		expect(sent.at(-1)).toContain("default");
		store.close();
	});

	test("/think reset clears the override", () => {
		const { store, conv, deps } = setup();
		handleCommand(deps, conv, "/think high");
		expect(store.get(conv.id)!.thinking).toBe("high");
		handleCommand(deps, conv, "/think reset");
		expect(store.get(conv.id)!.thinking).toBeNull();
		store.close();
	});

	test("/think rejects a bad level", () => {
		const { store, conv, deps } = setup();
		handleCommand(deps, conv, "/think turbo");
		expect(store.get(conv.id)!.thinking).toBeNull();
		store.close();
	});

	test("/stop fences the conversation", () => {
		const { store, conv, stopped, deps } = setup();
		expect(handleCommand(deps, conv, "/stop")).toBe(true);
		expect(stopped).toEqual([conv.id]);
		store.close();
	});

	test("/cd rejects a missing directory", () => {
		const { store, conv, sent, deps } = setup();
		handleCommand(deps, conv, "/cd /nonexistent-path-xyz");
		expect(store.get(conv.id)!.cwd).toBe("/w");
		expect(sent[0]).toContain("not a directory");
		store.close();
	});
});


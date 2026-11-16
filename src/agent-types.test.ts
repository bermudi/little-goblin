import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openStore } from "./conversation.ts";
import {
	agentChildSystemPrompt,
	GENERAL_AGENT_TYPE,
	loadAgentTypes,
} from "./agent-types.ts";
import { tmpDb, tmpDir, useHome } from "./testkit.ts";

function typeDir(): string {
	const dir = join(tmpDir("goblin-agent-types-"), "agents");
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("agent types", () => {
	test("missing dir is the built-in catalog", () => {
		useHome("goblin-agent-types-");
		const types = loadAgentTypes(join(tmpDir("goblin-agent-types-"), "absent"));
		expect([...types.keys()]).toEqual(["general"]);
		expect(types.get("general")).toBe(GENERAL_AGENT_TYPE);
	});

	test("operator files load and a general.md replaces the built-in", () => {
		const dir = typeDir();
		writeFileSync(
			join(dir, "code-reader.md"),
			"---\ndescription: Reads code.\n---\nYou read code.",
		);
		writeFileSync(
			join(dir, "general.md"),
			"---\ndescription: My own generalist.\nmodel: openrouter/x\ntools: [read, bash]\n---\nCustom body.",
		);
		const types = loadAgentTypes(dir);
		expect(types.get("code-reader")).toMatchObject({
			name: "code-reader",
			description: "Reads code.",
			systemPrompt: "You read code.",
		});
		expect(types.get("general")).toMatchObject({
			description: "My own generalist.",
			model: "openrouter/x",
			tools: ["read", "bash"],
			systemPrompt: "Custom body.",
		});
	});

	test("a bad file fails loud naming the file", () => {
		const dir = typeDir();
		writeFileSync(join(dir, "broken.md"), "---\ndescription: x\nunknown: 1\n---\nBody.");
		expect(() => loadAgentTypes(dir)).toThrow(/agents\/broken\.md/);
	});

	test("missing description fails loud", () => {
		const dir = typeDir();
		writeFileSync(join(dir, "nodesc.md"), "---\nmodel: a/b\n---\nBody.");
		expect(() => loadAgentTypes(dir)).toThrow(/nodesc\.md: description/);
	});

	test("a malformed model ref fails loud", () => {
		const dir = typeDir();
		writeFileSync(join(dir, "badmodel.md"), "---\ndescription: d\nmodel: no-slash\n---\nBody.");
		expect(() => loadAgentTypes(dir)).toThrow(/badmodel\.md: model/);
	});

	test("an empty body and a bad name fail loud", () => {
		const dir = typeDir();
		writeFileSync(join(dir, "empty.md"), "---\ndescription: d\n---\n  \n");
		expect(() => loadAgentTypes(dir)).toThrow(/empty\.md: empty system prompt body/);
		const dir2 = typeDir();
		writeFileSync(join(dir2, "Bad_Name.md"), "---\ndescription: d\n---\nBody.");
		expect(() => loadAgentTypes(dir2)).toThrow(/Bad_Name\.md: type name/);
	});
});

describe("agent child system prompt", () => {
	test("freezes per conversation and rebuilds after a clear", () => {
		const home = useHome("goblin-agent-prompt-");
		const store = openStore(tmpDb("goblin-agent-prompt-"));
		const parent = store.resolve({ kind: "dm", chatId: 1 }, join(home, "w"));
		const child = store.resolveAgentChild(parent, "general", { model: "a/b", thinking: "low" }, "2026-11-16T00:00:00.000Z");
		const first = agentChildSystemPrompt(store, child, "/absent-dir");
		expect(first.text).toBe(GENERAL_AGENT_TYPE.systemPrompt);
		expect(first.sources).toEqual(["agent-type:general"]);
		// Frozen: a second build with a CHANGED type file still serves the
		// snapshot byte-identically (cache stability, like prompt.ts).
		const dir = typeDir();
		writeFileSync(
			join(dir, "general.md"),
			"---\ndescription: changed.\n---\nChanged body.",
		);
		expect(agentChildSystemPrompt(store, child, dir).text).toBe(first.text);
		// A compaction clear is the sanctioned rebuild boundary: the type
		// file as it stands now rebuilds it.
		store.clearPromptSnapshot(child.id);
		expect(agentChildSystemPrompt(store, child, dir).text).toBe("Changed body.");
	});

	test("a child whose type vanished fails loud naming the file", () => {
		const home = useHome("goblin-agent-prompt-");
		const store = openStore(tmpDb("goblin-agent-prompt-"));
		const parent = store.resolve({ kind: "dm", chatId: 1 }, join(home, "w"));
		const child = store.resolveAgentChild(parent, "gone", { model: "a/b", thinking: "low" }, "2026-11-16T00:00:00.000Z");
		expect(() => agentChildSystemPrompt(store, child, "/absent-dir")).toThrow(
			/\/absent-dir\/gone\.md/,
		);
	});
});

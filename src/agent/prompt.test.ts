// The system prompt is the head of the provider prefix cache — these tests
// guard the invariant from DESIGN.md (Cache stability): nothing in the
// prompt varies turn-to-turn on its own. A test failing here usually means
// someone added a clock, counter, or random value to the prompt.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "../config.ts";
import type { Conversation } from "../conversation.ts";
import { buildSystemPrompt } from "./prompt.ts";

let dirs: string[] = [];
function useHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-prompt-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

const conv: Conversation = {
	id: "dm-1",
	chatId: 1,
	threadId: null,
	title: null,
	titleImplicit: false,
	model: null,
	thinking: null,
	voice: false,
	epoch: 0,
	createdAt: new Date().toISOString(),
};

describe("buildSystemPrompt", () => {
	test("no clock — the prompt carries no date and points at `date` instead", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			const { text } = buildSystemPrompt(conv);
			// An ISO date anywhere in the prompt would invalidate the whole
			// prefix cache every midnight.
			expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
			expect(text).toContain("run `date` via");
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});

	test("stable across calls — same inputs, identical bytes", () => {
		const home = useHome();
		process.env.GOBLIN_HOME = home;
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			writeFileSync(paths.soul(), "You are goblin.");
			const a = buildSystemPrompt(conv);
			const b = buildSystemPrompt(conv);
			expect(a.text).toBe(b.text);
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});
});

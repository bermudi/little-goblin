import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The approval owners and per-turn mount policy are channel-neutral.
// A Telegram import here would make the PWA depend on the companion
// adapter again — keep the boundary mechanical, not conventional.
const CHANNEL_NEUTRAL = [
	"src/mail-approval.ts",
	"src/program-approval.ts",
	"src/program-ops.ts",
	"src/app-push.ts",
	"src/http/app-push.ts",
	"src/agent/turn-tools.ts",
	"src/http/app-conversations.ts",
	"src/http/app-programs.ts",
	"src/http/app-shared.ts",
] as const;

describe("channel dependency boundary", () => {
	test("shared approval and app modules never import the Telegram adapter", () => {
		for (const path of CHANNEL_NEUTRAL) {
			const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
			expect(source).not.toMatch(/from ["'](?:\.\.?\/)*tg\//);
			expect(source).not.toMatch(/from ["']grammy["']/);
		}
	});
});

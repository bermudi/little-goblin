import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { buildSystemPrompt, PROMPT_SECTIONS } from "../agent/prompt.ts";
import { paths } from "../config.ts";
import type { ModelMessage } from "ai";
import { useHome } from "../testkit.ts";
import { measurePrompt, splitSystemPrompt } from "./itemize.ts";

const conv = {
	id: "dm-1",
	chatId: 1,
	threadId: null,
	title: null,
	titleImplicit: false,
	model: null,
	thinking: null,
	voice: false,
	memoryExcluded: false,
	projectId: null,
	persona: "personal" as const,
	archivedAt: null,
	pinnedAt: null,
	epoch: 0,
	createdAt: new Date().toISOString(),
};

// Marker text in builder order — every section present, exactly once.
const fullSystem = [
	"soul text here",
	"",
	PROMPT_SECTIONS.environment,
	"",
	"- Tools: bash.",
	"",
	`${PROMPT_SECTIONS.project}goblin`,
	"",
	"project instructions",
	"",
	PROMPT_SECTIONS.agents,
	"",
	"operating notes",
	"",
	PROMPT_SECTIONS.user,
	"",
	"operator model",
	"",
	PROMPT_SECTIONS.skills,
	"",
	"skills catalog",
].join("\n");

describe("splitSystemPrompt", () => {
	test("sections account for every character of the text", () => {
		const s = splitSystemPrompt(fullSystem);
		expect(
			s.identity + s.environment + s.project + s.agentsMd + s.userMd + s.skills,
		).toBe(fullSystem.length);
	});

	test("each chunk lands on the section that opened it", () => {
		const s = splitSystemPrompt(fullSystem);
		// identity is everything before the environment heading
		expect(fullSystem.slice(0, s.identity)).toBe("soul text here\n");
		// skills owns the tail from its heading to EOF
		expect(fullSystem.slice(fullSystem.length - s.skills)).toBe(
			`\n${PROMPT_SECTIONS.skills}\n\nskills catalog`,
		);
		expect(fullSystem.slice(s.identity, s.identity + s.environment)).toContain("- Tools: bash.");
		expect(fullSystem.slice(fullSystem.length - s.skills - s.userMd, fullSystem.length - s.skills)).toContain(
			"operator model",
		);
	});

	test("absent sections read zero and their would-be content joins the previous section", () => {
		const text = ["soul", "", PROMPT_SECTIONS.environment, "", "- Tools: bash."].join("\n");
		const s = splitSystemPrompt(text);
		expect(s.identity + s.environment).toBe(text.length);
		expect(s.project).toBe(0);
		expect(s.agentsMd).toBe(0);
		expect(s.userMd).toBe(0);
		expect(s.skills).toBe(0);
		expect(s.environment).toBeGreaterThan("soul\n".length);
	});

	test("a text with no markers is all identity", () => {
		const s = splitSystemPrompt("just a persona");
		expect(s.identity).toBe("just a persona".length);
		expect(s.environment + s.project + s.agentsMd + s.userMd + s.skills).toBe(0);
	});

	test("the real builder's output splits without residue", () => {
		const home = useHome("goblin-itemize-");
		process.env.GOBLIN_HOME = home;
		try {
			mkdirSync(paths.workspace(), { recursive: true });
			writeFileSync(paths.soul(), "I am goblin.\n");
			writeFileSync(paths.agents(), "Operating notes.\n");
			writeFileSync(paths.user(), "The operator.\n");
			const { text } = buildSystemPrompt(conv, ["bash"]);
			const s = splitSystemPrompt(text);
			expect(s.identity + s.environment + s.project + s.agentsMd + s.userMd + s.skills).toBe(
				text.length,
			);
			expect(s.agentsMd).toBeGreaterThan(0);
			expect(s.userMd).toBeGreaterThan(0);
		} finally {
			delete process.env.GOBLIN_HOME;
		}
	});
});

describe("measurePrompt", () => {
	const probe = tool({
		description: "probe things",
		inputSchema: z.object({ cmd: z.string() }),
		execute: async () => "probe-result",
	});

	test("tool definitions cost more than their descriptions alone", () => {
		const messages: ModelMessage[] = [{ role: "user", content: "hi" }];
		const bare = measurePrompt("sys", {}, messages);
		const withTool = measurePrompt("sys", { probe }, messages);
		expect(bare.toolDefs).toBe(0);
		expect(withTool.toolDefs).toBeGreaterThan("probe".length + "probe things".length);
	});

	test("tool-call inputs and tool results land in the history subset", () => {
		const messages: ModelMessage[] = [
			{ role: "user", content: "hello" },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "running" },
					{ type: "tool-call", toolCallId: "c1", toolName: "probe", input: { cmd: "ls" } },
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "c1",
						toolName: "probe",
						output: { type: "text", value: "file.txt" },
					},
				],
			},
		];
		const s = measurePrompt("sys", {}, messages);
		expect(s.history).toBeGreaterThan(s.toolResults);
		expect(s.toolResults).toBe(JSON.stringify({ cmd: "ls" }).length + "file.txt".length);
		expect(s.history).toBe(
			"hello".length +
				"running".length +
				JSON.stringify({ cmd: "ls" }).length +
				"file.txt".length,
		);
	});

	test("binary media is charged at its base64 size, not JSON-of-bytes", () => {
		const messages: ModelMessage[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "file", mediaType: "image/png", data: new Uint8Array(30) },
				],
			},
		];
		const s = measurePrompt("sys", {}, messages);
		expect(s.history).toBe("look".length + Math.ceil((30 * 4) / 3));
	});

	test("segments compose: system split + tools + history", () => {
		const messages: ModelMessage[] = [{ role: "user", content: "hi" }];
		const s = measurePrompt(fullSystem, { probe }, messages);
		expect(s.identity + s.environment + s.project + s.agentsMd + s.userMd + s.skills).toBe(
			fullSystem.length,
		);
		expect(s.history).toBe(2);
		expect(s.toolResults).toBe(0);
	});
});

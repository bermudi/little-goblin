// Prompt names must reflect every combination of optional dependencies.
import { describe, expect, test } from "bun:test";
import type { HindsightClient } from "../../hindsight.ts";
import type { ProgramsStore } from "../../programs.ts";
import type { Config } from "../../config.ts";
import type { AuthStore } from "../../auth.ts";
import { z } from "zod";
import { makeTools, toolNames } from "./mod.ts";

const programs = {} as unknown as ProgramsStore;
const memoryClient = {} as unknown as HindsightClient;

describe("toolNames ↔ makeTools", () => {
	for (const voice of [false, true]) {
		for (const program of [false, true]) {
			for (const file of [false, true]) {
				for (const memory of [false, true]) {
					for (const transcribe of [false, true]) {
						test(`voice=${voice}, program=${program}, file=${file}, memory=${memory}, transcribe=${transcribe}`, () => {
							const tools = makeTools(
								"/tmp",
								voice ? { synthesize: async () => [], deliver: async () => {} } : undefined,
								program
									? {
											programs,
											chatId: 1,
											threadId: null,
											publicUrl: () => "https://g.ts.net",
											sendPrivate: async () => {},
										}
									: undefined,
								file ? { deliver: async () => {} } : undefined,
								memory
									? {
											client: memoryClient,
											maxTokens: 256,
											budget: "low",
											isExcluded: () => false,
											noteRecall: () => {},
										}
									: undefined,
								undefined,
								transcribe ? { transcribe: async () => null } : undefined,
							);
							expect(toolNames(tools)).toEqual([
								"read_file", "write_file", "edit_file", "bash",
								...(voice ? ["speak"] : []),
								...(transcribe ? ["transcribe"] : []),
								...(program ? ["program"] : []),
								...(file ? ["send_file"] : []),
								...(memory ? ["memory_search"] : []),
							]);
						});
					}
				}
			}
		}
	}
	test("every tool's wire schema is a root-level object (unions break providers)", () => {
		// Some providers cannot generate arguments against a root-level
		// oneOf — every call arrives as `{}` and fails validation. That
		// silently killed mail, then program, then delegate and
		// history_search. Per-tool tests pin the shapes we know; this one
		// pins the invariant for every tool that will ever join the set.
		const tools = makeTools(
			"/tmp",
			{ synthesize: async () => [], deliver: async () => {} },
			{
				programs,
				chatId: 1,
				threadId: null,
				publicUrl: () => "https://g.ts.net",
				sendPrivate: async () => {},
			},
			{ deliver: async () => {} },
			{
				client: memoryClient,
				maxTokens: 256,
				budget: "low",
				isExcluded: () => false,
				noteRecall: () => {},
			},
			{
				// makeTools reads configRef.current.search even when merely
				// deciding whether to mount the search tool.
				configRef: { current: {} as Config },
				auth: {} as AuthStore,
			},
			{ transcribe: async () => null },
			// delegateTool's description lists the configured harnesses,
			// so the dep needs a real config block even in a shape test.
			{
				config: { maxRunning: 3, harnesses: { codex: { kind: "codex" } } },
				lifecycle: {},
				pin: () => ({ address: { chatId: 0, threadId: null } }),
				workspaceDir: "/tmp",
			} as unknown as Parameters<typeof makeTools>[7],
			{} as unknown as Parameters<typeof makeTools>[8],
			{} as unknown as Parameters<typeof makeTools>[9],
		);
		for (const [name, t] of Object.entries(tools)) {
			const schema = (t as unknown as { inputSchema?: unknown }).inputSchema;
			expect(schema, `${name} exposes an input schema`).toBeDefined();
			const wire = z.toJSONSchema(schema as z.ZodType);
			expect(wire.type, `${name} wire schema must be an object, got ${wire.type}`)
				.toBe("object");
		}
	});
});

// Prompt names must reflect every combination of optional dependencies.
import { describe, expect, test } from "bun:test";
import type { HindsightClient } from "../../hindsight.ts";
import type { ProgramsStore } from "../../programs.ts";
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
								program ? { programs, chatId: 1, threadId: null } : undefined,
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
});

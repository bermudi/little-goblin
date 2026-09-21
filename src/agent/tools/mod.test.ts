// Prompt names must reflect every combination of optional dependencies.
import { describe, expect, test } from "bun:test";
import type { JobsStore } from "../../jobs.ts";
import { makeTools, toolNames } from "./mod.ts";

const jobs = {} as unknown as JobsStore;

describe("toolNames ↔ makeTools", () => {
	for (const voice of [false, true]) {
		for (const schedule of [false, true]) {
			for (const file of [false, true]) {
				test(`voice=${voice}, schedule=${schedule}, file=${file}`, () => {
					const tools = makeTools(
						"/tmp",
						voice ? { synthesize: async () => [], deliver: async () => {} } : undefined,
						schedule ? { jobs, chatId: 1, threadId: null } : undefined,
						file ? { deliver: async () => {} } : undefined,
					);
					expect(toolNames(tools)).toEqual([
						"read_file", "write_file", "edit_file", "bash",
						...(voice ? ["speak"] : []),
						...(schedule ? ["schedule"] : []),
						...(file ? ["send_file"] : []),
					]);
				});
			}
		}
	}
});

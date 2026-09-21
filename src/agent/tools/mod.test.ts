// The prompt advertises toolNames(); makeTools() registers the tools.
// These must be the same list in the same order — this test is the pin
// that keeps the advertised line from drifting from the real toolset.

import { describe, expect, test } from "bun:test";
import type { JobsStore } from "../../jobs.ts";
import { makeTools, toolNames } from "./mod.ts";

const jobs = {} as unknown as JobsStore;

describe("toolNames ↔ makeTools", () => {
	test("advertised names equal registered keys, with and without TTS", () => {
		const noVoice = makeTools(
			"/tmp",
			undefined,
			{ jobs, chatId: 1, threadId: null },
			{ deliver: async () => {} },
		);
		expect(Object.keys(noVoice)).toEqual(toolNames(false));

		const voice = makeTools(
			"/tmp",
			{
				synthesize: async () => [new Uint8Array()],
				deliver: async () => {},
			},
			{ jobs, chatId: 1, threadId: null },
			{ deliver: async () => {} },
		);
		expect(Object.keys(voice)).toEqual(toolNames(true));
	});
});

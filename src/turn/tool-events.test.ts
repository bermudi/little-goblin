import { describe, expect, test } from "bun:test";
import { openToolEvents, noteToolInput, noteToolOutput } from "./tool-events.ts";

describe("nested bash command records", () => {
	test("expands recorded command calls and ignores a bash output without records", () => {
		const state = openToolEvents({ toolCalls: [], digest: [] });
		const deps = {
			convId: "c1",
			evidence: { calls: 10, argChars: 200, outChars: 300 },
			skillWatch: undefined,
			onCompleted: () => {},
		};
		noteToolInput(state, { convId: "c1", evidence: deps.evidence }, "b1", "bash", { command: "goblin note list" });
		noteToolOutput(state, deps, "b1", {
			exit_code: 0,
			output: "{}",
			calls: [{ tool: "note", args: '{"action":"list"}', ok: true, result: "notes" }],
		});
		expect(state.toolCalls).toEqual(["bash", "bash.note"]);
		expect(state.digestRing.map((row) => row.id)).toEqual(["b1", "b1/1"]);
		expect(state.digestRing[1]!.entry).toMatchObject({
			tool: "bash.note",
			args: '{"action":"list"}',
			result: "notes",
			ok: true,
		});

		const clean = openToolEvents({ toolCalls: [], digest: [] });
		noteToolInput(clean, { convId: "c1", evidence: deps.evidence }, "b2", "bash", { command: "echo hello" });
		noteToolOutput(clean, deps, "b2", { exit_code: 0, output: "hello" });
		expect(clean.toolCalls).toEqual(["bash"]);
	});
});

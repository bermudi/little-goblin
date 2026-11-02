import { expect, test } from "bun:test";
import { CONSERVATIVE_POLICY, TOOL_NAMES, TOOL_POLICY, policyOf } from "./tool-policy.ts";

const names = (pick: (p: (typeof TOOL_POLICY)[keyof typeof TOOL_POLICY]) => boolean): string[] =>
	TOOL_NAMES.filter((n) => pick(TOOL_POLICY[n])).sort();

test("descriptors reproduce the former name lists", () => {
	expect(names((p) => p.replay === "safe")).toEqual([
		"history_search",
		"memory_search",
		"read_file",
	]);
	expect(names((p) => p.scriptable)).toEqual(
		[
			"read_file",
			"write_file",
			"edit_file",
			"bash",
			"fetch",
			"search",
			"memory_search",
			"history_search",
			"transcribe",
			"sandbox",
			"artifact",
		].sort(),
	);
	expect(names((p) => p.guestSandbox)).toEqual(["search", "web_search"]);
	expect(names((p) => !p.guestChannel)).toEqual(
		[
			"subagent",
			"desktop",
			"program",
			"mail",
			"delegate",
			"herdr",
			"memory_search",
			"memory_reflect",
			"history_search",
			"note",
			"speak",
			"send_file",
			"generate_image",
		].sort(),
	);
	expect(names((p) => p.output === "untrusted")).toEqual(["fetch", "search", "web_search"]);
	expect(names((p) => p.writesFiles)).toEqual(["edit_file", "script", "write_file"]);
	expect(names((p) => p.composes)).toEqual(["script"]);
});

test("unknown (dynamic) tools get the conservative default", () => {
	expect(policyOf("mcp__x")).toEqual(CONSERVATIVE_POLICY);
	expect(policyOf("toString")).toEqual(CONSERVATIVE_POLICY);
});

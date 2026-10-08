import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkMcpConfig, checkMcpConfigFile } from "./check-mcp-config.ts";

// The gate's one invariant: goblin's mcporter config must carry
// `"imports": []`, or mcporter silently merges the operator's editor
// servers (DESIGN.md, "Web access" → "MCP").
describe("checkMcpConfig", () => {
	test("an empty server set with imports [] passes", () => {
		expect(checkMcpConfig('{"mcpServers": {}, "imports": []}')).toEqual({ ok: true });
	});

	test("JSONC comments pass — mcporter.json accepts them", () => {
		expect(checkMcpConfig('{\n// seed comment\n"mcpServers": {},\n"imports": [],\n}')).toEqual({
			ok: true,
		});
	});

	test("a missing imports key fails — omission means the editor defaults", () => {
		const checked = checkMcpConfig('{"mcpServers": {}}');
		expect(checked.ok).toBe(false);
		if (!checked.ok) expect(checked.reason).toContain('"imports": []');
	});

	test("a non-empty imports list fails — mcporter appends the omitted defaults after it", () => {
		const checked = checkMcpConfig('{"mcpServers": {}, "imports": ["cursor"]}');
		expect(checked.ok).toBe(false);
		if (!checked.ok) expect(checked.reason).toContain("exactly []");
	});

	test("a non-array imports key fails", () => {
		expect(checkMcpConfig('{"mcpServers": {}, "imports": "none"}').ok).toBe(false);
	});

	test("unparsable and non-object configs fail without echoing contents", () => {
		for (const text of ["{oops", "[]", "42"]) {
			const checked = checkMcpConfig(text);
			expect(checked.ok).toBe(false);
			if (!checked.ok) expect(checked.reason).not.toContain("oops");
		}
	});
});

describe("checkMcpConfigFile", () => {
	test("a missing file fails with the recovery, not a stack", () => {
		const checked = checkMcpConfigFile(
			join(mkdtempSync(join(tmpdir(), "goblin-mcp-")), "mcporter.json"),
		);
		expect(checked.ok).toBe(false);
		if (!checked.ok) expect(checked.reason).toContain("seeds an empty one");
	});

	test("a valid file passes", () => {
		const dir = mkdtempSync(join(tmpdir(), "goblin-mcp-"));
		const path = join(dir, "mcporter.json");
		writeFileSync(path, '{"mcpServers": {}, "imports": []}');
		expect(checkMcpConfigFile(path)).toEqual({ ok: true });
	});
});

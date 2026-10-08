// Call-time gate (DESIGN.md: "Web access" → "MCP"): goblin's mcporter
// must never see the host's servers. mcporter merges editor imports
// (Cursor, Claude, Codex, …) unless the config carries `"imports": []`
// — an omitted or non-empty key silently widens goblin's tool surface
// to the operator's editors. scripts/mcp runs this before every call
// so a widened config fails loud instead of leaking.
//
// Silent on success (exit 0). On failure prints the reason — structural
// facts only, never file contents — to stderr and exits 1.
import { readFileSync } from "node:fs";
import JSON5 from "json5";
import { paths } from "../src/config.ts";

export type McpConfigCheck = { ok: true } | { ok: false; reason: string };

export function checkMcpConfig(text: string): McpConfigCheck {
	let parsed: unknown;
	try {
		parsed = JSON5.parse(text);
	} catch (err) {
		return { ok: false, reason: `mcporter.json does not parse: ${(err as Error).message}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, reason: "mcporter.json must be an object with mcpServers and imports" };
	}
	const imports = (parsed as Record<string, unknown>).imports;
	if (!Array.isArray(imports)) {
		return {
			ok: false,
			reason:
				'mcporter.json must carry "imports": [] — without it mcporter merges the operator\'s editor servers',
		};
	}
	if (imports.length > 0) {
		return {
			ok: false,
			reason: `mcporter.json imports must be exactly [] (found ${imports.length} entr${imports.length === 1 ? "y" : "ies"}) — a non-empty list appends the remaining editor defaults after it`,
		};
	}
	return { ok: true };
}

export function checkMcpConfigFile(path: string): McpConfigCheck {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return {
				ok: false,
				reason: `no mcporter config at ${path} — start goblin once (it seeds an empty one) or create it`,
			};
		}
		return {
			ok: false,
			reason: `cannot read mcporter config at ${path}: ${(err as Error).message}`,
		};
	}
	return checkMcpConfig(text);
}

if (import.meta.main) {
	const checked = checkMcpConfigFile(paths.mcporter());
	if (!checked.ok) {
		process.stderr.write(`${checked.reason}\n`);
		process.exit(1);
	}
}

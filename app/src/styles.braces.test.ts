import { expect, test } from "bun:test";

// Merge conflict resolutions dropped closing braces twice; vite build then fails.
test("styles.css braces balance and never go negative", async () => {
	const css = await Bun.file(new URL("./styles.css", import.meta.url)).text();
	let depth = 0;
	let line = 1;
	for (const ch of css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ""))) {
		if (ch === "\n") line++;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			expect(depth, `extra } at line ${line}`).toBeGreaterThanOrEqual(0);
		}
	}
	expect(depth, "unclosed {").toBe(0);
});

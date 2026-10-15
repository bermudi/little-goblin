import { resolve } from "node:path";
import { checkAppAssets } from "../src/health.ts";

try {
	if (process.argv.length !== 3) throw new Error("usage");
	const result = checkAppAssets(resolve(process.argv[2]!));
	// The detail carries the typed failure (path-escape, missing dist,
	// bad refs) — the category is the diagnosis, not the exit code.
	if (result.status !== "pass") throw new Error(result.detail);
	process.stderr.write("install: app assets verified\n");
} catch (error) {
	const detail = error instanceof Error ? `: ${error.message}` : "";
	process.stderr.write(`install: app asset verification failed${detail}\n`);
	process.exitCode = 1;
}

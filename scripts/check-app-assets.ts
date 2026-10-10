import { resolve } from "node:path";
import { checkAppAssets } from "../src/health.ts";

try {
	if (process.argv.length !== 3) throw new Error("usage");
	const result = checkAppAssets(resolve(process.argv[2]!));
	if (result.status !== "pass") throw new Error("assets-unavailable");
	process.stderr.write("install: app assets verified\n");
} catch {
	process.stderr.write("install: app asset verification failed\n");
	process.exitCode = 1;
}

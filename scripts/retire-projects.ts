import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { setLogStream } from "../src/log.ts";
import { applyProjectRetirement, previewProjectRetirement } from "../src/project-retirement.ts";

try {
	setLogStream(process.stderr);
	const { values } = parseArgs({
		options: {
			database: { type: "string" },
			"to-bot": { type: "string", multiple: true },
			"dry-run": { type: "boolean" },
			apply: { type: "string" },
		},
	});
	if (values.database === undefined || Boolean(values["dry-run"]) === (values.apply !== undefined)) {
		throw new Error("Usage: bun scripts/retire-projects.ts --database <sqlite> [--to-bot <project-id>]... (--dry-run | --apply <approval>)");
	}
	const path = resolve(values.database);
	const toBot = values["to-bot"] ?? [];
	const plan = values.apply === undefined
		? previewProjectRetirement(path, toBot)
		: applyProjectRetirement(path, toBot, values.apply, new Date());
	process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
} catch (error) {
	process.stderr.write(`Project retirement failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}

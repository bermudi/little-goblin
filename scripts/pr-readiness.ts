// One read-only observation, without a Goblin home, service, model, or watcher.
import { z } from "zod";
import { makeGithubReadiness } from "../src/github.ts";
import { setLogStream } from "../src/log.ts";
import { githubIssueSchema, prWatchSchema } from "../src/pr-readiness.ts";

setLogStream(process.stderr);
const args = z.tuple([z.string(), z.coerce.number().int().positive()]).rest(z.string()).safeParse(process.argv.slice(2));
if (!args.success) {
	process.stderr.write("Usage: bun --no-env-file scripts/pr-readiness.ts owner/repo ISSUE_NUMBER [CHECK_NAME…]\n");
	process.exit(2);
}
const issue = githubIssueSchema.parse({ repository: args.data[0], number: args.data[1] });
const watch = prWatchSchema.parse({ issue, checks: args.data.slice(2) });
const observation = await makeGithubReadiness()(watch);
process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
if (observation.result.kind === "unavailable") process.exitCode = 1;

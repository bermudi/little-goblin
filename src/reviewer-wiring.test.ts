import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAuth } from "./auth.ts";
import { openCacheObservation } from "./cache-observation.ts";
import { loadConfig } from "./config.ts";
import { openStore } from "./conversation.ts";
import { setLogFile } from "./log.ts";
import { wireReviewer } from "./reviewer-wiring.ts";
import { useHome } from "./testkit.ts";

function wiredThresholds(reviewer: string): unknown {
	const home = useHome("goblin-reviewer-wiring-");
	writeFileSync(
		join(home, "goblin.json5"),
		`{providers:{zai:{kind:"openai-compatible",baseUrl:"https://api.z.ai/v4",auth:"zai"}},model:"zai/glm-4.6",operators:[7],reviewer:${reviewer}}`,
	);
	const config = loadConfig();
	if (config === null) throw new Error("fixture config did not parse");
	const store = openStore(join(home, "goblin.sqlite"));
	const db = new Database(":memory:");
	const logFile = join(home, "goblin.log");
	setLogFile(logFile);
	try {
		wireReviewer({
			configRef: { current: config, ttsDown: false },
			auth: loadAuth(),
			store,
			observation: openCacheObservation(db),
			paths: {
				workspace: () => join(home, "ws"),
				skills: () => join(home, "ws", "skills"),
				skillsProposed: () => join(home, "ws", "skills-proposed"),
			},
			notify: async () => {},
			recordSources: () => {},
		});
	} finally {
		setLogFile(null);
		store.close();
		db.close();
	}
	return readFileSync(logFile, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>)
		.find((e) => e.msg === "reviewer enabled")?.thresholds;
}

test.each([
	["default", `{auth:"or"}`, { correction: 0.8, procedure: 0.8, reuse: 0.6 }],
	[
		"a shared threshold does not move it",
		`{auth:"or",threshold:0.9,thresholds:{procedure:0.7}}`,
		{ correction: 0.9, procedure: 0.7, reuse: 0.6 },
	],
	[
		"its own key does",
		`{auth:"or",thresholds:{reuse:0.4}}`,
		{ correction: 0.8, procedure: 0.8, reuse: 0.4 },
	],
])("reuse threshold: %s", (_label, reviewer, expected) => {
	expect(wiredThresholds(reviewer)).toEqual(expected);
});

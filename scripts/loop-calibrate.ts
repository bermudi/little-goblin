// Loop-watchdog calibration (design/model.md → "No step budget"): replays
// the longest stored tool turns plus synthetic loops through system1 and
// prints each checkpoint's "stuck" score, so the cut threshold is set
// from observed separation, not a guess.
//
//   bun scripts/loop-calibrate.ts [model ...]
//
// Read-only over goblin.sqlite. Defaults to the configured system1 model.
// Prints via process.stdout.write (CLI convention, see check-auth.ts).

import { Database } from "bun:sqlite";
import { loadAuth } from "../src/auth.ts";
import { loadConfig, paths } from "../src/config.ts";
import { JevClient, JEV_MODEL } from "../src/jev.ts";
import { LOOP_QUESTIONS, loopState } from "../src/loop-watchdog.ts";
import { summarize, toolOk, type ToolCallDigest } from "../src/reviewer.ts";

const CHECK_EVERY = 16;

interface Case {
	name: string;
	expect: "stuck" | "progress" | "?";
	request: string;
	calls: ToolCallDigest[];
}

function textOf(parts: unknown): string {
	if (!Array.isArray(parts)) return "";
	return parts
		.flatMap((p: unknown) => {
			const o = p as Record<string, unknown>;
			return o.type === "text" && typeof o.text === "string" ? [o.text] : [];
		})
		.join("\n");
}

function storedCases(db: Database, ids: { id: number; expect: Case["expect"] }[]): Case[] {
	return ids.map(({ id, expect }) => {
		const row = db.query("select conversation_id, seq, data from events where id = ?").get(id) as {
			conversation_id: string;
			seq: number;
			data: string;
		};
		const parts = (JSON.parse(row.data) as { message: { parts: Record<string, unknown>[] } }).message.parts;
		const calls: ToolCallDigest[] = parts
			.filter((p) => typeof p.type === "string" && p.type.startsWith("tool-"))
			.map((p) => {
				const failed = p.state === "output-error";
				const out = failed ? p.errorText : p.output;
				return {
					tool: (p.type as string).slice(5),
					args: summarize(p.input, 300),
					result: summarize(out ?? "(no result)", 300),
					ok: !failed && toolOk(out),
				};
			});
		const users = db
			.query("select data from events where conversation_id = ? and seq < ? and role = 'user' order by seq desc limit 5")
			.all(row.conversation_id, row.seq) as { data: string }[];
		const request =
			users.map((u) => textOf((JSON.parse(u.data) as { message: { parts: unknown } }).message.parts)).find((t) => t !== "") ??
			"(attachment only)";
		return { name: `event ${id}`, expect, request, calls };
	});
}

const rep = (n: number, f: (i: number) => ToolCallDigest): ToolCallDigest[] => Array.from({ length: n }, (_, i) => f(i));

const synthetic: Case[] = [
	{
		name: "exact repeat",
		expect: "stuck",
		request: "Why does the build fail?",
		calls: rep(16, () => ({ tool: "bash", args: '{"command":"bun run build"}', result: "error: Could not resolve \"./missing.ts\"", ok: false })),
	},
	{
		name: "cosmetic retry, same error",
		expect: "stuck",
		request: "Install faster-whisper and transcribe the voice note.",
		calls: rep(16, (i) => ({
			tool: "bash",
			args: JSON.stringify({ command: ["pip install faster-whisper", "pip3 install faster-whisper", "python3 -m pip install faster-whisper", "pip install --user faster-whisper"][i % 4] }),
			result: "error: externally-managed-environment × This environment is externally managed",
			ok: false,
		})),
	},
	{
		name: "rephrased searches, nothing new",
		expect: "stuck",
		request: "What is the new Zorblax framework everyone is talking about this week?",
		calls: rep(16, (i) => ({
			tool: "search",
			args: JSON.stringify({ query: `${["Zorblax framework", "\"Zorblax\" release", "Zorblax announcement 2026", "zorblax github", "Zorblax JS framework news"][i % 5]} ${i}` }),
			result: "<web>\n1. Zorbl — https://zorbl.example/ — a Hungarian bakery\n2. Blax Industries — https://blax.example/",
			ok: true,
		})),
	},
	{
		name: "ping-pong edit/revert",
		expect: "stuck",
		request: "Make the tests pass.",
		calls: rep(16, (i) =>
			i % 2 === 0
				? { tool: "edit", args: '{"path":"src/a.ts","old":"x + 1","new":"x - 1"}', result: "ok", ok: true }
				: { tool: "bash", args: '{"command":"bun test"}', result: "1 fail: expected 3, got 1", ok: false },
		),
	},
	{
		name: "distinct file reads",
		expect: "progress",
		request: "Audit every module under src/ for console.log use.",
		calls: rep(16, (i) => ({
			tool: "bash",
			args: JSON.stringify({ command: `sed -n 1,200p src/module${i}.ts` }),
			result: `// module${i}: ${["config loader", "telegram intake", "delivery", "runtime lanes", "jev client", "auth", "mail", "programs"][i % 8]} … export function f${i}() { log.info(\"m${i}\") }`,
			ok: true,
		})),
	},
	{
		name: "fix loop, errors change",
		expect: "progress",
		request: "Make the typecheck pass.",
		calls: rep(16, (i) =>
			i % 2 === 0
				? { tool: "edit", args: JSON.stringify({ path: `src/f${i}.ts`, old: `a${i}`, new: `b${i}` }), result: "ok", ok: true }
				: { tool: "bash", args: '{"command":"bun run typecheck"}', result: `${16 - i} errors remaining; first: src/f${i + 1}.ts(3,1) TS2322`, ok: false },
		),
	},
];

const config = loadConfig();
if (config === null) throw new Error("no goblin config");
const auth = loadAuth();
const authRef = config.system1?.auth ?? config.reviewer?.auth;
if (authRef === undefined) throw new Error("no system1/reviewer auth ref in config");
const models = process.argv.length > 2 ? process.argv.slice(2) : [config.system1?.model ?? JEV_MODEL];

const db = new Database(paths.db(), { readonly: true });
const cases = [
	...storedCases(db, [
		{ id: 182, expect: "progress" },
		{ id: 123, expect: "?" },
		{ id: 105, expect: "?" },
		{ id: 121, expect: "?" },
		{ id: 169, expect: "progress" },
		{ id: 153, expect: "?" },
	]),
	...synthetic,
];
db.close();

for (const model of models) {
	const client = new JevClient({ model, auth: () => auth.resolve(authRef), ...(config.system1?.baseUrl ? { baseUrl: config.system1.baseUrl } : {}) });
	process.stdout.write(`\n== ${model}\n`);
	for (const c of cases) {
		const checkpoints = [CHECK_EVERY, ...(c.calls.length > CHECK_EVERY ? [c.calls.length] : [])].filter((n) => n <= c.calls.length);
		if (checkpoints.length === 0) checkpoints.push(c.calls.length);
		for (const at of checkpoints) {
			const scores: string[] = [];
			for (let r = 0; r < 3; r++) {
				const d = await client.decide(loopState(c.request, at, c.calls.slice(0, at)), LOOP_QUESTIONS);
				scores.push((d.answers.stuck ?? NaN).toFixed(3));
			}
			process.stdout.write(`${c.expect.padEnd(8)} ${c.name.padEnd(32)} @${String(at).padEnd(3)} ${scores.join(" ")}\n`);
		}
	}
}

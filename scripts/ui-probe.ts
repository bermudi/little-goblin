// ui-probe — replayable measurement of how well a model writes the ui
// tool's input. For each prompt × trial it forces a ui tool call through
// goblin's own provider path (resolveModel over goblin.json5 + auth.jsonl,
// read-only), records the RAW tool-call input as the provider emitted it
// (a wrapGenerate middleware capture — the SDK's parsed steps lose the
// wire text), then scores it twice: rawValid (the input as sent, no
// repair) and finalValid (after the same repairToolCall stream.ts wires,
// when the module exists — imported dynamically so before/after runs are
// comparable).
//
//   bun scripts/ui-probe.ts --model <ref> [--model <ref>] --n <trials> --out <dir>
//
// One JSONL row per call lands in <out>/<model-slug>.jsonl; a per-model
// summary prints on stdout. Provider failures (4xx schema rejections,
// rate limits after retries) are recorded as provider errors, never
// model failures; a 401/403 auth failure stops the model entirely.
// Log lines go to stderr so stdout stays a clean report.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	APICallError,
	InvalidToolInputError,
	asSchema,
	generateText,
	stepCountIs,
	wrapLanguageModel,
	type LanguageModelMiddleware,
	type ToolCallRepairFunction,
	type ToolSet,
} from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import JSON5 from "json5";
import { resolveModel } from "../src/agent/providers.ts";
import { uiTool } from "../src/agent/tools/ui.ts";
import { normalizeUiInput, uiInputSchema } from "../src/agent/tools/ui-schema.ts";
import { loadAuth } from "../src/auth.ts";
import { loadConfig } from "../src/config.ts";
import { setLogStream } from "../src/log.ts";

setLogStream(process.stderr);

const PROMPTS: { id: string; text: string }[] = [
	{
		id: "p1",
		text: "Compare the Trek FX 3, Specialized Sirrus 4.0 and Cannondale Quick 3 hybrid bikes for commuting — price, weight, gearing, and who each suits.",
	},
	{
		id: "p2",
		text: "Walk me through renewing a Mexican passport from abroad, step by step.",
	},
	{
		id: "p3",
		text: "Show my running last month: total 112 km over 14 runs, avg pace 5:32/km, longest 21.1 km; weekly km were 22, 31, 27, 32.",
	},
	{
		id: "p4",
		text: "Help me decide where to eat tonight: sushi, tacos, or ramen. Give me a quick take on each and let me pick.",
	},
	{
		id: "p5",
		text: "I want to plan a weekend trip — ask me what you need to know (dates, budget, who's coming, vibe) with a form.",
	},
	{
		id: "p6",
		text: "Build me a tip calculator I can play with: bill amount, tip percentage slider, number of people.",
	},
	{
		id: "p7",
		text: "Give me an overview of three cloud database options — Postgres on Neon, PlanetScale, and Convex — with a tab per option, and inside each tab put pros and cons side by side plus a short verdict.",
	},
	{
		id: "p8",
		text: "Lay out a 4-week beginner strength plan: one tab per week; each week shows the three workouts as columns, and each workout lists its exercises as steps.",
	},
];

const TOOL_CHOICES = [
	{ type: "tool", toolName: "ui" },
	"required",
	"auto",
] as const;
type ToolChoiceUsed = (typeof TOOL_CHOICES)[number];

// ---------- args ----------

function parseArgs(): { models: string[]; n: number; out: string; rescore: string[] } {
	const args = process.argv.slice(2);
	const models: string[] = [];
	const rescore: string[] = [];
	let n: number | null = null;
	let out: string | null = null;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === "--model") models.push(args[++i] ?? "");
		else if (a === "--rescore") rescore.push(args[++i] ?? "");
		else if (a === "--n") n = Number.parseInt(args[++i] ?? "", 10);
		else if (a === "--out") out = args[++i] ?? "";
		else throw new Error(`unknown arg ${a}`);
	}
	if (out === null || out === "") throw new Error("--out expects a directory");
	if (rescore.length > 0) return { models, n: n ?? 0, out, rescore };
	if (models.length === 0 || models.some((m) => !m.includes("/")))
		throw new Error("needs --model <provider>/<model> (repeatable)");
	if (n === null || !Number.isInteger(n) || n < 1) throw new Error("--n expects a positive integer");
	return { models, n, out, rescore: [] };
}

// ---------- optional generic repair (Phase 1+) ----------

type RepairFactory = (convId: string) => ToolCallRepairFunction<ToolSet>;
// Non-literal specifier: the module may not exist yet — its absence is
// data ("generic repair absent"), not a script error.
const repairSpecifier = "../src/agent/tool-repair.ts";
const makeToolCallRepair: RepairFactory | null = await import(repairSpecifier)
	.then((m) => (m as { makeToolCallRepair?: RepairFactory }).makeToolCallRepair ?? null)
	.catch(() => null);

// ---------- helpers ----------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryable(error: unknown): boolean {
	if (APICallError.isInstance(error)) {
		const s = error.statusCode;
		return s === 429 || s === undefined || s >= 500;
	}
	return !(error instanceof APICallError);
}

function isAuthFailure(error: unknown): boolean {
	return APICallError.isInstance(error) && (error.statusCode === 401 || error.statusCode === 403);
}

function providerErrorFields(error: unknown): Record<string, unknown> {
	if (APICallError.isInstance(error)) {
		return {
			kind: "api",
			status: error.statusCode ?? null,
			message: error.message.slice(0, 300),
		};
	}
	return {
		kind: error instanceof Error ? error.name : "unknown",
		status: null,
		message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
	};
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false } {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false };
	}
}

// Which generic-repair rules fired, derived from the input diff — the
// repair function itself only logs them.
function repairFixes(rawText: string, fixedText: string): string[] {
	const fixes: string[] = [];
	const raw = tryJson(rawText);
	const fixed = tryJson(fixedText);
	if (!raw.ok) fixes.push("json5");
	if (raw.ok && fixed.ok && typeof raw.value === "object" && raw.value !== null) {
		const rawObj = raw.value as Record<string, unknown>;
		const fixedObj = (fixed.value ?? {}) as Record<string, unknown>;
		for (const [key, val] of Object.entries(rawObj)) {
			if (JSON.stringify(val) === JSON.stringify(fixedObj[key])) continue;
			fixes.push(
				typeof val === "string" && typeof fixedObj[key] === "object"
					? `stringified:${key}`
					: `changed:${key}`,
			);
		}
	}
	if (fixes.length === 0) fixes.push("reserialized");
	return fixes;
}

interface Row {
	promptId: string;
	trial: number;
	toolChoiceUsed: string | null;
	toolCallCount: number;
	rawInput: unknown;
	rawValid: boolean;
	repairs: {
		generic: "absent" | "declined" | "applied";
		fixes: string[];
		normalize: unknown;
	};
	finalValid: boolean;
	issues: string[];
	finalIssues: string[];
	providerError: Record<string, unknown> | null;
	latencyMs: number;
	tokens: { input: number | undefined; output: number | undefined } | null;
	attempts: number;
}

interface Stats {
	rawValid: number;
	finalValid: number;
	providerErrors: number;
	total: number;
}

const emptyStats = (): Stats => ({ rawValid: 0, finalValid: 0, providerErrors: 0, total: 0 });

const { models, n, out, rescore } = parseArgs();
mkdirSync(out, { recursive: true });
const out_ = (s: string) => process.stdout.write(`${s}\n`);

function summary(perPrompt: Map<string, Stats>, totals: Stats) {
	out_(`\n   ${"prompt".padEnd(6)} ${"raw".padStart(6)} ${"final".padStart(6)} ${"errors".padStart(7)}`);
	for (const [id, s] of perPrompt) {
		out_(
			`   ${id.padEnd(6)} ${`${s.rawValid}/${s.total}`.padStart(6)} ${`${s.finalValid}/${s.total}`.padStart(6)} ${String(s.providerErrors).padStart(7)}`,
		);
	}
	out_(
		`   ${"TOTAL".padEnd(6)} ${`${totals.rawValid}/${totals.total}`.padStart(6)} ${`${totals.finalValid}/${totals.total}`.padStart(6)} ${String(totals.providerErrors).padStart(7)}`,
	);
}

// --rescore: replay stored rawInput rows through the CURRENT generic
// repair (InvalidToolInputError path fires whenever strict JSON fails
// or the schema rejects) + normalizeUiInput + uiInputSchema — no model
// calls. Same row shape, same summary.
if (rescore.length > 0) {
	const wireSchema = asSchema(uiTool().inputSchema).jsonSchema;
	const repairBase = makeToolCallRepair?.("ui-probe/rescore");
	for (const file of rescore) {
		const { readFileSync } = await import("node:fs");
		const rows = readFileSync(file, "utf8")
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => JSON.parse(l) as Row);
		const perPrompt = new Map<string, Stats>();
		for (const p of PROMPTS) perPrompt.set(p.id, emptyStats());
		const totals = emptyStats();
		const outRows: Row[] = [];
		for (const row of rows) {
			const stats = perPrompt.get(row.promptId) ?? emptyStats();
			if (!perPrompt.has(row.promptId)) perPrompt.set(row.promptId, stats);
			stats.total++;
			totals.total++;
			if (row.providerError !== null || row.rawInput === null || row.rawInput === undefined) {
				outRows.push(row);
				stats.providerErrors += row.providerError !== null ? 1 : 0;
				totals.providerErrors += row.providerError !== null ? 1 : 0;
				continue;
			}
			const raw = String(row.rawInput);
			const parsed = tryJson(raw);
			const rawCheck = parsed.ok ? uiInputSchema.safeParse(parsed.value) : null;
			const rawValid = rawCheck?.success ?? false;
			// The repair path runs on any InvalidToolInputError — strict-JSON
			// failure or schema rejection both qualify.
			let generic: "absent" | "declined" | "applied" = "absent";
			let fixes: string[] = [];
			let text = raw;
			if (!rawValid && repairBase !== undefined) {
				const error = new InvalidToolInputError({
					toolInput: raw,
					toolName: "ui",
					cause: null,
				});
				const outCall = await repairBase({
					instructions: undefined,
					system: undefined,
					messages: [],
					toolCall: { type: "tool-call", toolCallId: `rescore-${row.promptId}-${row.trial}`, toolName: "ui", input: raw },
					tools: {},
					inputSchema: async () => wireSchema,
					error,
				});
				generic = outCall === null ? "declined" : "applied";
				fixes = outCall === null ? [] : repairFixes(raw, outCall.input);
				if (outCall !== null) text = outCall.input;
			}
			const finalParsed = tryJson(text);
			const normalized = finalParsed.ok
				? normalizeUiInput(finalParsed.value)
				: (() => {
						try {
							return normalizeUiInput(JSON5.parse(text));
						} catch {
							return null;
						}
					})();
			const finalCheck =
				normalized === null ? null : uiInputSchema.safeParse(normalized.value);
			const finalValid = finalCheck?.success ?? false;
			const outRow: Row = {
				...row,
				rawValid,
				repairs: {
					generic,
					fixes,
					normalize: normalized === null ? null : normalized.report,
				},
				finalValid,
				issues: (rawCheck && !rawCheck.success ? rawCheck.error.issues : [])
					.slice(0, 5)
					.map((i) => `${i.path.join(".")}: ${i.message}`),
				finalIssues:
					finalCheck !== null && !finalCheck.success
						? finalCheck.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`)
						: [],
			};
			outRows.push(outRow);
			if (outRow.rawValid) stats.rawValid++;
			if (outRow.finalValid) stats.finalValid++;
			totals.rawValid += outRow.rawValid ? 1 : 0;
			totals.finalValid += outRow.finalValid ? 1 : 0;
		}
		const base = file.split("/").at(-1)!;
		const outFile = join(out, base);
		const { writeFileSync } = await import("node:fs");
		writeFileSync(outFile, outRows.map((r) => JSON.stringify(r)).join("\n") + "\n");
		out_(`\n== rescore ${file}`);
		summary(perPrompt, totals);
		out_(`   wrote ${outFile}`);
	}
	process.exit(0);
}

const config = loadConfig();
if (config === null) throw new Error("no goblin config");
const auth = loadAuth();

out_(
	`ui-probe: ${models.length} model(s) × ${PROMPTS.length} prompts × ${n} trial(s); generic repair ${makeToolCallRepair === null ? "ABSENT" : "present"}`,
);

for (const modelRef of models) {
	const slug = modelRef.replace(/[^a-zA-Z0-9.-]/g, "_");
	const file = join(out, `${slug}.jsonl`);
	const write = (row: Row) => appendFileSync(file, `${JSON.stringify(row)}\n`);
	const perPrompt = new Map<string, Stats>();
	for (const p of PROMPTS) perPrompt.set(p.id, emptyStats());
	const totals = emptyStats();

	out_(`\n== ${modelRef}`);
	let model;
	try {
		model = await resolveModel(config, auth, modelRef);
	} catch (error) {
		out_(`   model resolution failed: ${error instanceof Error ? error.message : String(error)}`);
		continue;
	}

	let aborted = false;
	for (const prompt of PROMPTS) {
		if (aborted) break;
		for (let trial = 0; trial < n; trial++) {
			const stats = perPrompt.get(prompt.id)!;
			stats.total++;
			totals.total++;

			// Raw wire capture: the middleware sees LanguageModelV4Content
			// where tool-call input is still the provider's exact text.
			let rawInputs: string[] = [];
			const capture: LanguageModelMiddleware = {
				wrapGenerate: async ({ doGenerate }) => {
					const result = await doGenerate();
					rawInputs = result.content
						.filter((c) => c.type === "tool-call")
						.map((c) => c.input);
					return result;
				},
			};
			// resolveModel's LanguageModel union includes `string` for callers
			// that pass model ids straight through; this path never does.
			const wrapped = wrapLanguageModel({
				model: model as LanguageModelV4,
				middleware: capture,
			});

			let genericRepair: "absent" | "declined" | "applied" = "absent";
			let fixes: string[] = [];
			const repairToolCall: ToolCallRepairFunction<ToolSet> | undefined =
				makeToolCallRepair === null
					? undefined
					: (() => {
							const base = makeToolCallRepair(`ui-probe/${modelRef}`);
							return async (opts) => {
								const out2 = await base(opts);
								genericRepair = out2 === null ? "declined" : "applied";
								fixes = out2 === null ? [] : repairFixes(opts.toolCall.input, out2.input);
								return out2;
							};
						})();

			let row: Row | null = null;
			let attempts = 0;
			let fatal = false;

			for (const choice of TOOL_CHOICES) {
				let lastError: unknown = null;
				let retryableSeen = false;
				for (let attempt = 0; attempt < 4; attempt++) {
					attempts++;
					const t0 = Date.now();
					try {
						const result = await generateText({
							model: wrapped,
							tools: { ui: uiTool() },
							toolChoice: choice,
							prompt: prompt.text,
							stopWhen: stepCountIs(1),
							maxRetries: 0,
							...(repairToolCall !== undefined ? { repairToolCall } : {}),
						});
						const latencyMs = Date.now() - t0;
						const call = result.steps[0]?.toolCalls.find((t) => t.toolName === "ui");
						const rawInput = rawInputs[0] ?? null;
						const rawParsed = rawInput !== null ? tryJson(rawInput) : { ok: false as const };
						const rawCheck = rawParsed.ok ? uiInputSchema.safeParse(rawParsed.value) : null;
						const finalCheck =
							call === undefined || call.invalid !== true
								? null
								: (() => {
										try {
											return uiInputSchema.safeParse(
												typeof call.input === "string"
													? JSON5.parse(call.input)
													: call.input,
											);
										} catch {
											return null;
										}
									})();
						row = {
							promptId: prompt.id,
							trial,
							toolChoiceUsed: typeof choice === "string" ? choice : `tool:${choice.toolName}`,
							toolCallCount: rawInputs.length,
							rawInput,
							rawValid: rawCheck?.success ?? false,
							repairs: {
								generic: genericRepair,
								fixes,
								normalize: (() => {
									if (!rawParsed.ok) {
										try {
											return normalizeUiInput(JSON5.parse(rawInput!));
										} catch {
											return null;
										}
									}
									return normalizeUiInput(rawParsed.value);
								})(),
							},
							finalValid: call !== undefined && call.invalid !== true,
							issues: (rawCheck && !rawCheck.success ? rawCheck.error.issues : [])
								.slice(0, 5)
								.map((i) => `${i.path.join(".")}: ${i.message}`),
							finalIssues:
								finalCheck !== null && !finalCheck.success
									? finalCheck.error.issues
											.slice(0, 5)
											.map((i) => `${i.path.join(".")}: ${i.message}`)
									: [],
							providerError: null,
							latencyMs,
							tokens: {
								input: result.usage.inputTokens,
								output: result.usage.outputTokens,
							},
							attempts,
						};
						lastError = null;
						break;
					} catch (error) {
						lastError = error;
						if (isAuthFailure(error)) {
							fatal = true;
							break;
						}
						if (!isRetryable(error)) break; // try the next toolChoice on 4xx rejections
						retryableSeen = true;
						await sleep(Math.min(3000 * 2 ** attempt, 30_000));
					}
				}
				if (row !== null || fatal) break;
				// Retryable errors still failing after all attempts are a
				// provider fault — record them, don't try the next toolChoice.
				if (lastError !== null && retryableSeen) {
					row = {
						promptId: prompt.id,
						trial,
						toolChoiceUsed: typeof choice === "string" ? choice : `tool:${choice.toolName}`,
						toolCallCount: 0,
						rawInput: null,
						rawValid: false,
						repairs: { generic: "absent", fixes: [], normalize: null },
						finalValid: false,
						issues: [],
						finalIssues: [],
						providerError: providerErrorFields(lastError),
						latencyMs: 0,
						tokens: null,
						attempts,
					};
					break;
				}
			}

			if (row === null) {
				// Every toolChoice rejected (4xx) — a provider-side refusal,
				// recorded as such.
				row = {
					promptId: prompt.id,
					trial,
					toolChoiceUsed: null,
					toolCallCount: 0,
					rawInput: null,
					rawValid: false,
					repairs: { generic: "absent", fixes: [], normalize: null },
					finalValid: false,
					issues: [],
					finalIssues: [],
					providerError: { kind: "all-toolChoices-rejected", status: null, message: "" },
					latencyMs: 0,
					tokens: null,
					attempts,
				};
			}
			if (fatal && row.providerError === null) {
				row.providerError = { kind: "auth", status: 403, message: "auth/endpoint failure" };
			}
			write(row);
			if (row.providerError !== null) stats.providerErrors++;
			else {
				if (row.rawValid) stats.rawValid++;
				if (row.finalValid) stats.finalValid++;
			}
			totals.providerErrors += row.providerError !== null ? 1 : 0;
			if (row.providerError === null) {
				totals.rawValid += row.rawValid ? 1 : 0;
				totals.finalValid += row.finalValid ? 1 : 0;
			}
			out_(
				`   ${prompt.id}#${trial} choice=${row.toolChoiceUsed ?? "-"} raw=${row.rawValid} final=${row.finalValid} ${row.providerError !== null ? `PROVIDER-ERR ${JSON.stringify(row.providerError)}` : ""}`,
			);
			if (fatal) {
				out_(`   !! auth/endpoint failure — stopping ${modelRef}`);
				aborted = true;
				break;
			}
			await sleep(1000); // gentle on rate-limited providers
		}
	}

	summary(perPrompt, totals);
	out_(`   wrote ${file}`);
}

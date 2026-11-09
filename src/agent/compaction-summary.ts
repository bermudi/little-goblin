// What a compaction summary must contain (design/compaction.md → The
// summary, Quality audit): the model's five required headings, then
// code-made parts the model never touches — verbatim operator messages
// and an identifier index — so a later fold cannot paraphrase them away.

import type { UIMessage } from "ai";
import { isMachineryText } from "../tags.ts";

export const REQUIRED_HEADINGS = [
	"## Decisions",
	"## Open TODOs",
	"## Constraints/Rules",
	"## Pending user asks",
	"## Exact identifiers",
] as const;

// Token budgets (chars/4), design/compaction.md → Budgets.
export const VERBATIM_TOKEN_BUDGET = 4_000;
export const IDENTIFIER_TOKEN_BUDGET = 1_000;
export const AUDIT_RETRIES = 2;

// Everything after this line is code-made and carried forward by code.
const CODE_MADE_MARKER = "<!-- code-made below: carried verbatim across folds, never summarized -->";
const QUOTES_HEADING = "## Operator messages, verbatim (newest first)";
const INDEX_HEADING = "## Identifier index";

export const SUMMARY_SYSTEM = `You are summarizing your own conversation history so you can continue seamlessly with only this summary plus the recent messages that follow it. Write in the operator's dominant language.
Produce a compact, factual summary with these exact section headings, in this order:
${REQUIRED_HEADINGS.join("\n")}
Under ## Decisions: what was decided and done, with rationale. Under ## Open TODOs: unfinished multi-step work and its state. Under ## Constraints/Rules: standing instructions and preferences the operator gave. Under ## Pending user asks: every unresolved operator request — never omit one; record completed requests elsewhere. Under ## Exact identifiers: literal values exactly as seen (IDs, URLs, file paths, ports, hashes, dates, times).
When a previous summary is present, re-distill it with the new messages and drop stale duplicates. Omit small talk and process chatter. Never invent anything not present in the span.`;

// A real operator message: user role, not a resume request, not
// machinery speech (program fires, delegation and subagent notices).
export function operatorText(message: UIMessage): string | null {
	if (message.role !== "user") return null;
	const meta = message.metadata;
	if (typeof meta === "object" && meta !== null && "goblinResume" in meta) return null;
	const text = message.parts
		.flatMap((p) => (p.type === "text" ? [p.text] : []))
		.join("\n")
		.trim();
	if (text === "" || isMachineryText(text)) return null;
	return text;
}

// ---------- code-made parts ----------

export interface CodeMade {
	quotes: string[];
	identifiers: string[];
}

const IDENTIFIER_PATTERNS: RegExp[] = [
	/\bhttps?:\/\/[^\s<>"'`)\]]+/g,
	/(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)+/g,
	/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
	/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g,
	/(?<![\w#])#\d+\b/g,
	/\b\d+(?:\.\d+)?\s?(?:ms|s|min|h|KB|MB|GB|TB|kB|k|M|%|px|tokens)\b/g,
	/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b/g,
	/\b(?:E[A-Z]{3,}|[A-Z][a-zA-Z]+Error)\b/g,
	/`([^`\n]{2,120})`/g,
	/"([^"\n]{2,80})"/g,
];

// Newest-first identifier pass over rendered event texts (oldest first
// in, so the caller passes the span in store order).
export function extractIdentifiers(texts: readonly string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (let i = texts.length - 1; i >= 0; i--) {
		for (const pattern of IDENTIFIER_PATTERNS) {
			for (const m of texts[i]!.matchAll(pattern)) {
				const value = (m[1] ?? m[0]).replace(/[.,;:]+$/, "").trim();
				if (value.length < 2 || seen.has(value)) continue;
				seen.add(value);
				out.push(value);
			}
		}
	}
	return out;
}

function withinBudget(items: readonly string[], tokenBudget: number): string[] {
	const out: string[] = [];
	let chars = 0;
	for (const item of items) {
		const line = JSON.stringify(item).length + 3;
		if (chars + line > tokenBudget * 4) {
			// One oversized newest item still rides, cut — never an empty list
			// because the latest operator message was long.
			if (out.length === 0) out.push(`${item.slice(0, tokenBudget * 4 - 40)}… [truncated]`);
			break;
		}
		out.push(item);
		chars += line;
	}
	return out;
}

function dedupe(items: readonly string[]): string[] {
	return [...new Set(items)];
}

// New span's parts first (newest first), then what the previous fold
// carried, deduped and cut to budget.
export function mergeCodeMade(fresh: CodeMade, previous: CodeMade): CodeMade {
	return {
		quotes: withinBudget(dedupe([...fresh.quotes, ...previous.quotes]), VERBATIM_TOKEN_BUDGET),
		identifiers: withinBudget(
			dedupe([...fresh.identifiers, ...previous.identifiers]),
			IDENTIFIER_TOKEN_BUDGET,
		),
	};
}

export function composeSummary(modelText: string, parts: CodeMade): string {
	const section = (heading: string, items: string[]) =>
		items.length === 0 ? [] : [heading, ...items.map((s) => `- ${JSON.stringify(s)}`)];
	const code = [
		...section(QUOTES_HEADING, parts.quotes),
		...section(INDEX_HEADING, parts.identifiers),
	];
	return code.length === 0 ? modelText : `${modelText}\n\n${CODE_MADE_MARKER}\n${code.join("\n")}`;
}

// The inverse: a stored summary back into the model's text (what the next
// fold's summarizer sees) and the code-made parts (what code carries).
// A pre-stage-2 summary has no marker: all of it is model text.
export function parseSummary(stored: string): { modelText: string; parts: CodeMade } {
	const at = stored.indexOf(`\n\n${CODE_MADE_MARKER}\n`);
	if (at < 0) return { modelText: stored, parts: { quotes: [], identifiers: [] } };
	const parts: CodeMade = { quotes: [], identifiers: [] };
	let into: string[] | null = null;
	for (const line of stored.slice(at + CODE_MADE_MARKER.length + 3).split("\n")) {
		if (line === QUOTES_HEADING) into = parts.quotes;
		else if (line === INDEX_HEADING) into = parts.identifiers;
		else if (into !== null && line.startsWith("- ")) {
			const value: unknown = JSON.parse(line.slice(2));
			if (typeof value !== "string") throw new Error(`code-made summary line is not a string: ${line}`);
			into.push(value);
		}
	}
	return { modelText: stored.slice(0, at), parts };
}

// ---------- quality audit (OpenClaw compaction-safeguard-quality) ----------

const STOP_WORDS = new Set(
	"a an and are as at be but by can could do does for from have how i if in is it its me my no not of on or our please so that the their them then there this to us was we what when where which who why will with would you your".split(
		" ",
	),
);

function tokens(text: string): string[] {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		// A 40+ char run is a blob (hash, base64, a pasted wall), not a word
		// a summary would restate.
		.filter((t) => t.length > 0 && t.length <= 40);
}

// OpenClaw's rule: up to 12 distinct meaningful words of the ask; 3 or more
// need 2 matches in the summary, fewer need 1.
function hasAskOverlap(summary: string, ask: string): boolean {
	const all = [...new Set(tokens(ask))].slice(0, 12);
	if (all.length === 0) return true;
	const meaningful = all.filter((t) => t.length > 1 && !STOP_WORDS.has(t));
	const check = meaningful.length > 0 ? meaningful : all;
	const have = new Set(tokens(summary));
	const need = check.length >= 3 ? 2 : 1;
	return check.filter((t) => have.has(t)).length >= need;
}

export function auditSummary(modelText: string, latestAsk: string | null): string[] {
	const lines = new Set(modelText.split(/\r?\n/).map((l) => l.trim()));
	const reasons: string[] = REQUIRED_HEADINGS.filter((h) => !lines.has(h)).map(
		(h) => `missing section ${h}`,
	);
	if (latestAsk !== null && !hasAskOverlap(modelText, latestAsk)) {
		reasons.push("the latest operator request is not reflected");
	}
	return reasons;
}

export function correctiveInstruction(reasons: readonly string[], latestAsk: string | null): string {
	return [
		"[your previous summary failed the quality check — rewrite it]",
		...reasons.map((r) => `- ${r}`),
		`Use exactly these headings, in order: ${REQUIRED_HEADINGS.join(", ")}.`,
		...(latestAsk !== null
			? [`The latest operator request, to reflect (under ## Pending user asks if unresolved): ${JSON.stringify(latestAsk.slice(0, 2_000))}`]
			: []),
	].join("\n");
}

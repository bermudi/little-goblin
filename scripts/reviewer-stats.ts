// Reviewer calibration report (DESIGN.md, "Skill reviewer" →
// instrumentation): reads goblin.log JSONL and answers, from the log
// alone, the questions the gate experiment needs — how often the gate
// fires and on what, what reviews cost, and what became of each save
// (validated, published, skipped, rejected, cancelled, dropped, and
// whether the published skill dir is still on disk — the closest thing
// to an undo label that exists).
//
//   bun scripts/reviewer-stats.ts [logfile]
//
// Defaults to $GOBLIN_HOME/state/goblin.log. Prints a human report via
// process.stdout.write (same convention as check-auth.ts — this is a
// CLI, not a goblin process; `log` is for the daemon).

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Rec = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseArgs(): string {
	const arg = process.argv[2];
	if (arg !== undefined) return arg;
	const home = process.env.GOBLIN_HOME ?? `${process.env.HOME ?? ""}/goblin`;
	return join(home, "state", "goblin.log");
}

const file = parseArgs();
if (!existsSync(file)) {
	process.stdout.write(`no log at ${file}\n`);
	process.exit(1);
}

interface GateLine {
	conv: string;
	review: boolean;
	fallback: boolean;
	streak: number;
	trigger: string | null;
	correction: number | null;
	procedure: number | null;
	cost: number | null;
	tokens: number | null;
	ms: number;
}

interface ReviewRecord {
	reviewId: string;
	conv: string | null;
	trigger: string | null;
	started: boolean;
	model: string | null;
	staged: string | null;
	validated: { skill: string; ok: boolean }[];
	rejected: string | null;
	discarded: string | null;
	published: string[];
	skipped: unknown[];
	cancelled: string | null;
	dropped: boolean;
	done: boolean;
}

const gates: GateLine[] = [];
const skippedMemory = { count: 0 };
const reviews = new Map<string, ReviewRecord>();
let workspaceSeen: string | null = null;

function review(reviewId: string): ReviewRecord {
	let r = reviews.get(reviewId);
	if (r === undefined) {
		r = {
			reviewId,
			conv: null,
			trigger: null,
			started: false,
			model: null,
			staged: null,
			validated: [],
			rejected: null,
			discarded: null,
			published: [],
			skipped: [],
			cancelled: null,
			dropped: false,
			done: false,
		};
		reviews.set(reviewId, r);
	}
	return r;
}

for (const line of readFileSync(file, "utf8").split("\n")) {
	if (line.trim() === "") continue;
	let rec: Rec;
	try {
		rec = JSON.parse(line) as Rec;
	} catch {
		continue;
	}
	const msg = str(rec.msg);
	if (msg === null) continue;
	const rid = str(rec.review_id);
	if (msg === "reviewer gate") {
		gates.push({
			conv: str(rec.conversation) ?? "?",
			review: rec.review === true,
			fallback: rec.fallback === true,
			streak: num(rec.fallbackStreak) ?? 0,
			trigger: str(rec.trigger),
			correction: num(rec.correction),
			procedure: num(rec.procedure),
			cost: num(rec.cost),
			tokens: num(rec.inputTokens),
			ms: num(rec.ms) ?? 0,
		});
		// A dropped review never starts — seed its trigger from the gate.
		if (rid !== null && rec.review === true) {
			const r = review(rid);
			r.trigger = r.trigger ?? str(rec.trigger);
			r.conv = r.conv ?? str(rec.conversation);
		}
		continue;
	}
	if (msg === "reviewer skipped — memory excluded") {
		skippedMemory.count += 1;
		continue;
	}
	if (rid === null) continue;
	const r = review(rid);
	r.conv = str(rec.conversation) ?? r.conv;
	switch (msg) {
		case "reviewer queue full — review dropped":
			r.dropped = true;
			break;
		case "reviewer review started":
			r.started = true;
			r.trigger = str(rec.trigger) ?? r.trigger;
			r.model = str(rec.model) ?? r.model;
			r.staged = str(rec.staged) ?? r.staged;
			if (r.staged !== null && workspaceSeen === null) {
				// staged = <workspace>/.reviewer-staging/<id>
				workspaceSeen = join(r.staged, "..", "..");
			}
			break;
		case "reviewer validation": {
			const skill = str(rec.skill);
			if (skill !== null) r.validated.push({ skill, ok: rec.ok === true });
			break;
		}
		case "reviewer write rejected — skills-ref validate failed":
			r.rejected = "validation";
			break;
		case "reviewer write discarded — model call failed":
			r.discarded = "model-call";
			break;
		case "reviewer write discarded — over the byte budget":
			r.discarded = "byte-budget";
			break;
		case "reviewer review skipped — skills tree over staging budget":
			r.discarded = "staging-budget";
			break;
		case "reviewer publish skipped — live skills changed mid-review":
			r.skipped = arr(rec.skipped);
			break;
		case "reviewer review cancelled — dropped from queue":
		case "reviewer review cancelled — aborting in-flight":
		case "reviewer review cancelled — staging discarded":
			r.cancelled = msg;
			break;
		case "reviewer review done":
			r.done = true;
			for (const s of arr(rec.skills)) {
				const name = str(s);
				if (name !== null) r.published.push(name);
			}
			break;
		default:
			break;
	}
}

const out: string[] = [];
const p = (s: string): void => {
	out.push(s);
};

const fired = gates.filter((g) => g.review);
const fallbacks = gates.filter((g) => g.fallback);
const avg = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const pct = (n: number, d: number): string => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);
const f2 = (n: number): string => n.toFixed(2);

p(`reviewer-stats — ${file}`);
p(`gates: ${gates.length} total · ${fired.length} fired a review (${pct(fired.length, gates.length)}) · ${fallbacks.length} fallback (${pct(fallbacks.length, gates.length)})`);
p(`fallback: max consecutive streak ${gates.reduce((m, g) => Math.max(m, g.streak), 0)} · skipped memory-excluded turns: ${skippedMemory.count}`);
if (gates.length > 0) {
	p(`scores (all gates):   correction avg ${f2(avg(gates.flatMap((g) => (g.correction === null ? [] : [g.correction]))))} · procedure avg ${f2(avg(gates.flatMap((g) => (g.procedure === null ? [] : [g.procedure]))))}`);
}
if (fired.length > 0) {
	const byTrigger = new Map<string, number>();
	for (const g of fired) byTrigger.set(g.trigger ?? "?", (byTrigger.get(g.trigger ?? "?") ?? 0) + 1);
	p(`fired triggers: ${[...byTrigger.entries()].map(([k, v]) => `${k} ${v}`).join(" · ")}`);
	p(`gate cost: avg ${f2(avg(gates.map((g) => g.cost ?? 0)))} (known) · avg ${Math.round(avg(gates.map((g) => g.ms)))}ms`);
}

const rs = [...reviews.values()];
p("");
p(`reviews: ${rs.length}`);
const bucket = (name: string, pred: (r: ReviewRecord) => boolean): number => {
	const n = rs.filter(pred).length;
	p(`  ${name}: ${n}`);
	return n;
};
bucket("dropped (queue full)", (r) => r.dropped);
bucket("cancelled (/stop)", (r) => r.cancelled !== null);
bucket("discarded (model/budget)", (r) => r.discarded !== null);
bucket("rejected (validation)", (r) => r.rejected !== null);
const published = rs.filter((r) => r.published.length > 0);
bucket("published", (r) => r.published.length > 0);

p("");
p("published skills (still-on-disk = not undone):");
if (published.length === 0) {
	p("  (none)");
} else {
	const seen = new Map<string, { onDisk: number; gone: number }>();
	for (const r of published) {
		for (const s of r.published) {
			const e = seen.get(s) ?? { onDisk: 0, gone: 0 };
			if (workspaceSeen !== null) {
				try {
					statSync(join(workspaceSeen, "skills", s));
					e.onDisk += 1;
				} catch {
					e.gone += 1;
				}
			}
			seen.set(s, e);
		}
	}
	for (const [skill, e] of [...seen.entries()].sort()) {
		const disk = workspaceSeen === null ? "?" : `${e.onDisk} on disk, ${e.gone} gone`;
		p(`  ${skill} — ${disk}`);
	}
	if (workspaceSeen === null) p("  (workspace unknown — no started line carried a staged path)");
}

p("");
p("most recent 15 reviews:");
for (const r of rs.slice(-15).reverse()) {
	const state = r.dropped
		? "dropped"
		: r.cancelled !== null
			? "cancelled"
			: r.discarded !== null
				? `discarded(${r.discarded})`
				: r.rejected !== null
					? "rejected(validation)"
					: r.published.length > 0
						? `published: ${r.published.join(", ")}`
						: r.started
							? "ran, saved nothing"
							: "queued";
	const extra = r.skipped.length > 0 ? ` +skipped ${r.skipped.length}` : "";
	p(`  ${r.reviewId.slice(0, 8)} ${r.trigger ?? "?"} ${state}${extra}`);
}

process.stdout.write(`${out.join("\n")}\n`);

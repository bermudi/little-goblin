import { z } from "zod";

const args = z
	.tuple([z.string().min(1), z.coerce.number().int().positive().max(1_000_000).optional()])
	.parse(process.argv.slice(2));
const file = Bun.file(args[0]);
if (file.size > 64 * 1024 * 1024) throw new Error("cache report input exceeds 64 MiB");

const receiptSchema = z.object({
	ts: z.iso.datetime(),
	msg: z.enum(["model call usage", "model step usage"]),
	callId: z.string().optional(),
	routeKey: z
		.string()
		.regex(/^[a-f0-9]{16,64}$/)
		.optional(),
	inputTokens: z.number().int().nonnegative().nullable(),
	cacheReadTokens: z.number().int().nonnegative().nullable(),
	cacheWriteTokens: z.number().int().nonnegative().nullable(),
	idleMs: z.number().finite().nonnegative().nullable().optional(),
	prefixRelation: z.enum(["first", "same", "append", "rewrite"]).optional(),
});
type Receipt = z.infer<typeof receiptSchema>;
type Totals = {
	steps: number;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	inputWithReportedReads: number;
	reportedReads: number;
	zeroReads: number;
	missingReads: number;
	missingWrites: number;
};

function empty(): Totals {
	return {
		steps: 0,
		inputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		inputWithReportedReads: 0,
		reportedReads: 0,
		zeroReads: 0,
		missingReads: 0,
		missingWrites: 0,
	};
}

function add(total: Totals, row: Receipt): void {
	total.steps++;
	total.inputTokens += row.inputTokens ?? 0;
	if (row.cacheReadTokens === null || row.inputTokens === null) total.missingReads++;
	else {
		total.reportedReads++;
		total.inputWithReportedReads += row.inputTokens;
		total.cacheReadTokens += row.cacheReadTokens;
		if (row.cacheReadTokens === 0) total.zeroReads++;
	}
	if (row.cacheWriteTokens === null) total.missingWrites++;
	else total.cacheWriteTokens += row.cacheWriteTokens;
}

function present(total: Totals) {
	return {
		...total,
		tokenWeightedHitRate:
			total.inputWithReportedReads === 0
				? null
				: total.cacheReadTokens / total.inputWithReportedReads,
	};
}

const correlated: Receipt[] = [];
const legacy: Receipt[] = [];
let malformedJsonLines = 0;
let invalidUsageLines = 0;
const seenCalls = new Set<string>();
for (const line of (await file.text()).split("\n")) {
	if (line.trim() === "") continue;
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		malformedJsonLines++;
		continue;
	}
	const marker = z.object({ msg: z.string() }).safeParse(raw);
	if (!marker.success || !["model call usage", "model step usage"].includes(marker.data.msg))
		continue;
	const parsed = receiptSchema.safeParse(raw);
	if (!parsed.success) {
		invalidUsageLines++;
		continue;
	}
	const row = parsed.data;
	if (
		row.inputTokens !== null &&
		row.cacheReadTokens !== null &&
		row.cacheReadTokens > row.inputTokens
	) {
		invalidUsageLines++;
		continue;
	}
	if (row.msg === "model call usage") {
		if (row.callId === undefined || seenCalls.has(row.callId)) {
			invalidUsageLines++;
			continue;
		}
		seenCalls.add(row.callId);
		correlated.push(row);
	} else legacy.push(row);
}

const mode = correlated.length > 0 ? "correlated" : "legacy-unattributed";
const available = correlated.length > 0 ? correlated : legacy;
const rows = args[1] === undefined ? available : available.slice(-args[1]);
const total = empty();
const boundaries = [0, 60_000, 300_000, 600_000, 1_800_000, 3_600_000];
const curves = new Map<
	string,
	{ routeKey: string; lowerMs: number; upperMs: number | null; totals: Totals }
>();
let eligibleCurveSteps = 0;
for (const row of rows) {
	add(total, row);
	if (
		row.routeKey === undefined ||
		row.idleMs === null ||
		row.idleMs === undefined ||
		(row.prefixRelation !== "append" && row.prefixRelation !== "same") ||
		row.inputTokens === null ||
		row.cacheReadTokens === null
	)
		continue;
	eligibleCurveSteps++;
	const index = boundaries.findLastIndex((value) => row.idleMs! >= value);
	const lowerMs = boundaries[index]!;
	const upperMs = boundaries[index + 1] ?? null;
	const key = `${row.routeKey}:${index}`;
	let bucket = curves.get(key);
	if (bucket === undefined) {
		bucket = { routeKey: row.routeKey, lowerMs, upperMs, totals: empty() };
		curves.set(key, bucket);
	}
	add(bucket.totals, row);
}

process.stdout.write(
	JSON.stringify({
		version: 1,
		mode,
		availableSteps: available.length,
		selectedSteps: rows.length,
		firstAt: rows[0]?.ts ?? null,
		lastAt: rows.at(-1)?.ts ?? null,
		malformedJsonLines,
		invalidUsageLines,
		totals: present(total),
		eligibleCurveSteps,
		curve: [...curves.values()].map(({ totals, ...bucket }) => ({
			...bucket,
			...present(totals),
		})),
		expiryConclusion: "not-established",
	}) + "\n",
);

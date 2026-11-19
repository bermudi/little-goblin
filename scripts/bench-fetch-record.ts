// Run records for the fetch-provider benchmark: one JSON file per bench
// run under <repo>/bench-records/ (gitignored local data), read back by
// scripts/bench-fetch-view.ts to build the self-contained HTML viewer.
//
// A record holds names and measurements only — provider kinds, auth
// record NAMES, outcomes, timings, page titles and a short extract
// preview. Never key values or auth-record contents. Zod gates the read
// path: a malformed record fails loud with its path instead of feeding
// the viewer a half-shaped grid.
//
// GOBLIN_BENCH_RECORD_DIR relocates the directory (tests, scratch runs).

import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { durableWriteFile } from "../src/durable.ts";

export const benchCellSchema = z.object({
	outcome: z.enum([
		"ok",
		"pdf",
		"blocked",
		"thin",
		"rejected",
		"error",
		"skipped",
	]),
	chars: z.number().int().nonnegative().optional(),
	status: z.number().int().optional(),
	ms: z.number().int().nonnegative().optional(),
	note: z.string().optional(),
	// Full page title and the first ~1000 chars of extracted text, so the
	// viewer's drill-down can show real content vs a cookie wall.
	title: z.string().optional(),
	textPreview: z.string().optional(),
	// --live cell from a provider with no freshness knob ("~" — may be
	// a cache hit, not a live score).
	maybeCached: z.boolean().optional(),
});

export const benchProviderSchema = z.object({
	kind: z.string().min(1),
	candidate: z.boolean().optional(),
	via: z.string().optional(),
	// Auth record name only — the value never enters a record.
	authName: z.string().optional(),
	// Skip reason when the provider could not run (missing/unresolvable
	// auth record); cells come back "skipped" with the same reason.
	skipped: z.string().optional(),
	// Whether the provider's API exposes a no-cache knob (--live).
	hasLiveKnob: z.boolean(),
});

export const benchRunSchema = z
	.object({
		schema: z.literal(1),
		// ISO timestamp of run start.
		startedAt: z.string().min(1),
		mode: z.enum(["default", "live"]),
		urls: z.array(z.string().min(1)).min(1),
		providers: z.array(benchProviderSchema).min(1),
		// providers[i] × urls[j] → cells[i][j].
		cells: z.array(z.array(benchCellSchema)),
	})
	.refine(
		(run) =>
			run.cells.length === run.providers.length &&
			run.cells.every((row) => row.length === run.urls.length),
		{ message: "cells grid must be providers × urls" },
	);

export type BenchCell = z.infer<typeof benchCellSchema>;
export type BenchProvider = z.infer<typeof benchProviderSchema>;
export type BenchRun = z.infer<typeof benchRunSchema>;

export function recordsDir(): string {
	return process.env.GOBLIN_BENCH_RECORD_DIR ?? join(import.meta.dir, "..", "bench-records");
}

// File name sorts chronologically: run-<startedAt, fs-safe>-<mode>.json.
export function writeRunRecord(run: BenchRun, dir = recordsDir()): string {
	mkdirSync(dir, { recursive: true });
	const stamp = run.startedAt.replace(/[^0-9A-Za-z-]/g, "");
	const path = join(dir, `run-${stamp}-${run.mode}.json`);
	durableWriteFile(path, `${JSON.stringify(run, null, "\t")}\n`);
	return path;
}

// Every run-*.json in dir, oldest first. ENOENT on the dir is an empty
// history; anything else — unreadable file, bad JSON, schema mismatch —
// throws with the offending path.
export function readRunRecords(dir = recordsDir()): BenchRun[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const runs: BenchRun[] = [];
	for (const name of names) {
		if (!name.startsWith("run-") || !name.endsWith(".json")) continue;
		const path = join(dir, name);
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (err) {
			throw new Error(`bench record ${path}: malformed JSON — ${(err as Error).message}`);
		}
		const parsed = benchRunSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(`bench record ${path}: ${parsed.error.message}`);
		}
		runs.push(parsed.data);
	}
	return runs.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

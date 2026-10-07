// The repeat detector (design/model.md → "No step budget — loops are
// caught, not capped"): the deterministic half of loop catching. Every
// completed tool call hashes to a pair — argsHash = sha256(tool +
// stable-JSON(input)), resultHash = sha256(stable-JSON(output |
// errorText)), full values, sorted keys — and the newest pair's count
// over the last LOOP_DETECT_WINDOW records is the signal: WARN at
// LOOP_DETECT_WARN (once per pair), CUT at LOOP_DETECT_CUT. Same call
// AND same result is the definition of no progress: a re-run whose
// output changed is progress, and an A↔B edit/revert ping-pong trips
// too (each side reaches the cut inside the window). The mechanism is
// borrowed from openclaw's tool-loop-detection.ts — the hash, not its
// eight-detector taxonomy.
//
// Pure and synchronous — tests drive it directly, the runtime feeds it
// one record per completed tool call.

import { createHash } from "node:crypto";

export const LOOP_DETECT_WINDOW = 40;
export const LOOP_DETECT_WARN = 10;
export const LOOP_DETECT_CUT = 20;

interface Pair {
	argsHash: string;
	resultHash: string;
}

// Serializable form for TurnRecovery — one logical turn keeps one loop
// history across an overflow resume.
export interface LoopDetectorState {
	records: Pair[];
	warned: string[];
}

export type LoopVerdict = { action: "none" | "warn" | "cut"; count: number };

// Sorted object keys, full values: a reordered argument object is the
// same call, and nothing is truncated before hashing. Unserializable
// input (circular, BigInt) degrades to its String() form rather than
// throwing mid-stream.
function stableStringify(value: unknown): string {
	try {
		return JSON.stringify(sortKeys(value)) ?? "undefined";
	} catch {
		return String(value);
	}
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(value).sort()) {
			out[k] = sortKeys((value as Record<string, unknown>)[k]);
		}
		return out;
	}
	return value;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export class LoopDetector {
	private records: Pair[] = [];
	// Pair keys already warned this turn — the warning is once per pair,
	// never repeated even if eviction lets the count dip and recover.
	private warned = new Set<string>();

	static restore(state?: LoopDetectorState): LoopDetector {
		const d = new LoopDetector();
		if (state !== undefined) {
			d.records = state.records.slice(-LOOP_DETECT_WINDOW);
			d.warned = new Set(state.warned);
		}
		return d;
	}

	snapshot(): LoopDetectorState {
		return { records: [...this.records], warned: [...this.warned] };
	}

	// One completed tool call. `result` is the output on success, the
	// error text on failure — the caller resolves output ?? errorText.
	record(tool: string, input: unknown, result: unknown): LoopVerdict {
		const pair: Pair = {
			argsHash: sha(tool + stableStringify(input)),
			resultHash: sha(stableStringify(result)),
		};
		this.records.push(pair);
		if (this.records.length > LOOP_DETECT_WINDOW) this.records.shift();
		let count = 0;
		for (const r of this.records) {
			if (r.argsHash === pair.argsHash && r.resultHash === pair.resultHash) count++;
		}
		if (count >= LOOP_DETECT_CUT) return { action: "cut", count };
		const key = `${pair.argsHash}:${pair.resultHash}`;
		if (count >= LOOP_DETECT_WARN && !this.warned.has(key)) {
			this.warned.add(key);
			return { action: "warn", count };
		}
		return { action: "none", count };
	}
}

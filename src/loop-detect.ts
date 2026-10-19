import { createHash } from "node:crypto";

export const LOOP_DETECT_WINDOW = 40;
export const LOOP_DETECT_WARN = 10;
export const LOOP_DETECT_CUT = 20;

interface Pair {
	argsHash: string;
	resultHash: string;
}

export interface LoopDetectorState {
	records: Pair[];
	warned: string[];
}

export type LoopVerdict = { action: "none" | "warn" | "cut"; count: number };

export function stableStringify(value: unknown): string {
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

import {
	CACHE_CONTRACT_REVIEWED_AT,
	cacheContractFresh,
	cacheContractSources,
	type CacheSourceId,
} from "../src/agent/cache-contracts.ts";

const PER_SOURCE_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_048_576;
const MAX_REDIRECT_HOPS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

export type SourceCheckStatus = "unchanged" | "changed" | "unavailable" | "unknown";

export interface SourceCheckResult {
	id: CacheSourceId;
	url: string;
	status: SourceCheckStatus;
}

export interface CacheContractReport {
	reviewedAt: string;
	checkedAt: string;
	sources: SourceCheckResult[];
}

function acceptableUrl(url: URL): boolean {
	return url.protocol === "https:" && url.username === "" && url.password === "";
}

async function readCappedBody(response: Response): Promise<string | null> {
	if (response.body === null) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let body = "";
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > MAX_BODY_BYTES) return null;
			body += decoder.decode(value, { stream: true });
		}
		return body + decoder.decode();
	} finally {
		await reader.cancel();
	}
}

async function fetchSource(
	fetchImpl: typeof fetch,
	url: string,
): Promise<Response | "unavailable"> {
	const deadline = Date.now() + PER_SOURCE_TIMEOUT_MS;
	let current = url;
	for (let hop = 0; ; hop++) {
		let parsed: URL;
		try {
			parsed = new URL(current);
		} catch {
			return "unavailable";
		}
		if (!acceptableUrl(parsed)) return "unavailable";
		const remaining = deadline - Date.now();
		if (remaining <= 0) return "unavailable";
		let response: Response;
		try {
			response = await fetchImpl(current, {
				headers: { accept: "text/markdown" },
				redirect: "manual",
				signal: AbortSignal.timeout(remaining),
			});
		} catch {
			return "unavailable";
		}
		if (REDIRECT_STATUSES.has(response.status)) {
			await response.body?.cancel();
			const location = response.headers.get("location");
			if (location === null || hop + 1 >= MAX_REDIRECT_HOPS) return "unavailable";
			try {
				current = new URL(location, current).toString();
			} catch {
				return "unavailable";
			}
			continue;
		}
		if (response.status !== 200) {
			await response.body?.cancel();
			return "unavailable";
		}
		return response;
	}
}

export async function checkCacheContractSources(options?: {
	fetchImpl?: typeof fetch;
	now?: number;
}): Promise<{ report: CacheContractReport; ok: boolean }> {
	const fetchImpl = options?.fetchImpl ?? fetch;
	const now = options?.now ?? Date.now();
	const sources: SourceCheckResult[] = [];
	for (const [id, source] of Object.entries(cacheContractSources) as [
		CacheSourceId,
		{ url: string; fragments: readonly string[] },
	][]) {
		if (source.fragments.length === 0) {
			sources.push({ id, url: source.url, status: "unknown" });
			process.stderr.write(`check-cache-contracts ${id}: unknown (no pinned fragments)\n`);
			continue;
		}
		const response = await fetchSource(fetchImpl, source.url);
		if (response === "unavailable") {
			sources.push({ id, url: source.url, status: "unavailable" });
			process.stderr.write(`check-cache-contracts ${id}: unavailable ${source.url}\n`);
			continue;
		}
		let body: string | null;
		try {
			body = await readCappedBody(response);
		} catch {
			body = null;
		}
		if (body === null) {
			sources.push({ id, url: source.url, status: "unavailable" });
			process.stderr.write(
				`check-cache-contracts ${id}: unavailable ${source.url} (unreadable or oversized body)\n`,
			);
			continue;
		}
		const normalized = normalize(body);
		const missing = source.fragments.filter((f) => !normalized.includes(normalize(f)));
		const status: SourceCheckStatus = missing.length === 0 ? "unchanged" : "changed";
		sources.push({ id, url: source.url, status });
		process.stderr.write(`check-cache-contracts ${id}: ${status} ${source.url}\n`);
	}
	const fresh = cacheContractFresh(now);
	if (!fresh) {
		process.stderr.write(
			`check-cache-contracts: review metadata overdue (reviewedAt ${CACHE_CONTRACT_REVIEWED_AT})\n`,
		);
	}
	const ok = fresh && sources.every((s) => s.status === "unchanged" || s.status === "unknown");
	return {
		report: {
			reviewedAt: CACHE_CONTRACT_REVIEWED_AT,
			checkedAt: new Date(now).toISOString(),
			sources,
		},
		ok,
	};
}

if (import.meta.main) {
	try {
		const { report, ok } = await checkCacheContractSources();
		process.stdout.write(`${JSON.stringify(report)}\n`);
		process.exitCode = ok ? 0 : 1;
	} catch {
		process.stderr.write("check-cache-contracts: failed\n");
		process.exitCode = 2;
	}
}

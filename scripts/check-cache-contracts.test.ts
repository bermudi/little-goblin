import { describe, expect, test } from "bun:test";
import { cacheContractSources } from "../src/agent/cache-contracts.ts";
import { checkCacheContractSources } from "./check-cache-contracts.ts";

const SENTINEL_BODY = "REMOTE-SECRET-BODY-9f31d";

function fakeFetch(
	respond: (
		url: string,
		init: RequestInit | undefined,
	) => Response | Promise<Response> | Promise<never>,
): { impl: typeof fetch; urls: string[]; inits: (RequestInit | undefined)[] } {
	const urls: string[] = [];
	const inits: (RequestInit | undefined)[] = [];
	const impl = (async (url: string | URL, init?: RequestInit) => {
		urls.push(String(url));
		inits.push(init);
		return respond(String(url), init);
	}) as typeof fetch;
	return { impl, urls, inits };
}

// Serve each source exactly its pinned fragments so the whole set lands
// 'unchanged'; callers override per-url.
function bodyFor(url: string): string {
	const source = Object.values(cacheContractSources).find((s) => s.url === url);
	return source ? source.fragments.join("\n\n") : "";
}

describe("checkCacheContractSources", () => {
	test("every pinned fragment present → unchanged, logfare stays unknown and is never fetched", async () => {
		const { impl, urls, inits } = fakeFetch(
			async (url) => new Response(`${SENTINEL_BODY}\n\n${bodyFor(url)}\n\n${SENTINEL_BODY}`),
		);
		const { report, ok } = await checkCacheContractSources({ fetchImpl: impl, now: Date.parse("2026-10-16T00:00:00.000Z") });
		expect(ok).toBe(true);
		const byId = new Map(report.sources.map((s) => [s.id, s]));
		for (const id of Object.keys(cacheContractSources)) expect(byId.has(id as never)).toBe(true);
		expect(byId.get("logfare")!.status).toBe("unknown");
		expect(urls).not.toContain(cacheContractSources.logfare.url);
		for (const init of inits) {
			expect(new Headers(init?.headers).get("accept")).toBe("text/markdown");
			expect(init?.signal).toBeInstanceOf(AbortSignal);
		}
		expect(report.reviewedAt).toBeString();
		expect(report.checkedAt).toBeString();
		// The report carries ids, urls and statuses — never page content.
		expect(JSON.stringify(report)).not.toContain(SENTINEL_BODY);
	});

	test("a drifted fragment is changed, whitespace-normalized both ways", async () => {
		const { impl } = fakeFetch(async (url) => {
			if (url === cacheContractSources.zai.url) {
				// Collapsed whitespace still matches — a missing fragment doesn't.
				const body = cacheContractSources.zai.fragments
					.map((f) => f.replace(/\s+/g, " "))
					.join("   \n  ");
				return new Response(body);
			}
			return new Response(bodyFor(url));
		});
		const { report, ok } = await checkCacheContractSources({ fetchImpl: impl, now: Date.parse("2026-10-16T00:00:00.000Z") });
		expect(report.sources.find((s) => s.id === "zai")!.status).toBe("unchanged");
		expect(ok).toBe(true);

		const drifted = fakeFetch(async (url) =>
			new Response(url === cacheContractSources.anthropic.url ? "new docs page" : bodyFor(url)),
		);
		const out = await checkCacheContractSources({ fetchImpl: drifted.impl, now: Date.parse("2026-10-16T00:00:00.000Z") });
		expect(out.report.sources.find((s) => s.id === "anthropic")!.status).toBe("changed");
		expect(out.ok).toBe(false);
	});

	test("non-200, fetch failures and oversized bodies are unavailable", async () => {
		const { impl } = fakeFetch(async (url) => {
			if (url === cacheContractSources.zai.url) return new Response("down", { status: 503 });
			if (url === cacheContractSources.openrouter.url) throw new Error("DNS exploded");
			if (url === cacheContractSources.anthropic.url)
				return new Response("x".repeat(1_048_577), { status: 200 });
			return new Response(bodyFor(url));
		});
		const { report, ok } = await checkCacheContractSources({ fetchImpl: impl, now: Date.parse("2026-10-16T00:00:00.000Z") });
		expect(ok).toBe(false);
		expect(report.sources.find((s) => s.id === "zai")!.status).toBe("unavailable");
		expect(report.sources.find((s) => s.id === "openrouter")!.status).toBe("unavailable");
		expect(report.sources.find((s) => s.id === "anthropic")!.status).toBe("unavailable");
		expect(report.sources.find((s) => s.id === "openai")!.status).toBe("unchanged");
		// unavailable is a boundary verdict, not a body/error dump.
		expect(JSON.stringify(report)).not.toContain("down");
	});

	test("overdue review metadata fails the run even when every source is unchanged", async () => {
		const { impl } = fakeFetch(async (url) => new Response(bodyFor(url)));
		const farFuture = Date.parse("2027-06-01T00:00:00.000Z");
		const { report, ok } = await checkCacheContractSources({ fetchImpl: impl, now: farFuture });
		expect(ok).toBe(false);
		expect(report.sources.every((s) => s.status === "unchanged" || s.status === "unknown")).toBe(
			true,
		);
	});
});

describe("redirect policy", () => {
	test("redirects to non-https or credential-bearing URLs are unavailable", async () => {
		const { impl, urls } = fakeFetch(async (url) => {
			if (url === cacheContractSources.zai.url) {
				return new Response(null, {
					status: 302,
					headers: { location: "http://docs.z.ai/help/faq" },
				});
			}
			if (url === cacheContractSources.openrouter.url) {
				return new Response(null, {
					status: 301,
					headers: { location: "https://user:pass@openrouter.ai/x" },
				});
			}
			return new Response(bodyFor(url));
		});
		const { report, ok } = await checkCacheContractSources({ fetchImpl: impl, now: Date.parse("2026-10-16T00:00:00.000Z") });
		expect(ok).toBe(false);
		expect(report.sources.find((s) => s.id === "zai")!.status).toBe("unavailable");
		expect(report.sources.find((s) => s.id === "openrouter")!.status).toBe("unavailable");
		expect(urls.filter((u) => u.startsWith("http:"))).toHaveLength(0);
		expect(urls.filter((u) => u.includes("user:pass"))).toHaveLength(0);
	});

	test("an https redirect chain resolves and reports the pinned source url", async () => {
		const { impl, urls } = fakeFetch(async (url) => {
			if (url === cacheContractSources.openrouter.url) {
				return new Response(null, {
					status: 308,
					headers: { location: "https://openrouter.ai/docs/guides/best-practices/prompt-caching-final.md" },
				});
			}
			if (url === "https://openrouter.ai/docs/guides/best-practices/prompt-caching-final.md") {
				return new Response(bodyFor(cacheContractSources.openrouter.url));
			}
			return new Response(bodyFor(url));
		});
		const { report, ok } = await checkCacheContractSources({ fetchImpl: impl, now: Date.parse("2026-10-16T00:00:00.000Z") });
		expect(ok).toBe(true);
		expect(report.sources.find((s) => s.id === "openrouter")!.status).toBe("unchanged");
		expect(urls).toContain("https://openrouter.ai/docs/guides/best-practices/prompt-caching-final.md");
	});

	test("a redirect loop beyond five hops is unavailable", async () => {
		const { impl } = fakeFetch(async (url) => {
			if (url === cacheContractSources.zai.url || url === "https://docs.z.ai/loop") {
				return new Response(null, {
					status: 302,
					headers: { location: "https://docs.z.ai/loop" },
				});
			}
			return new Response(bodyFor(url));
		});
		const { report } = await checkCacheContractSources({ fetchImpl: impl, now: Date.parse("2026-10-16T00:00:00.000Z") });
		expect(report.sources.find((s) => s.id === "zai")!.status).toBe("unavailable");
	});
});

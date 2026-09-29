// The gws mail reader's boundaries: history polling, baseline, thread
// lookup, and failure mapping — all against a fake gws runner, never
// the real CLI. The runner speaks the real surface mail-gws.ts calls:
// `gmail users history list / messages list|get / getProfile --params
// JSON --format json`, JSON on stdout, exit code + stderr on failure.
// Invariants: the fake records argv per call (envelope, not behavior);
// poll keeps the old seam's record-batch checkpoint contract (whole
// records, cap 10, truncate at last fired); a 404 history list becomes
// HistoryExpiredError; a missing reply target is null.

import { describe, expect, test } from "bun:test";
import { setLogFile, setLogWriter } from "./log.ts";
import { HistoryExpiredError, type MailHit } from "./mail.ts";
import { makeGwsReader, type GwsRunResult, type GwsRunner } from "./mail-gws.ts";

interface Call {
	args: string[];
}

function headers(from = "a@x.com", subject = "s", date = "d"): Array<{ name: string; value: string }> {
	return [
		{ name: "From", value: from },
		{ name: "Subject", value: subject },
		{ name: "Date", value: date },
	];
}

function msgGet(id: string, thread = "t"): unknown {
	return { id, threadId: thread, snippet: `snip-${id}`, payload: { headers: headers(`a-${id}@x.com`, `sub-${id}`, "today") } };
}

// A fake gws: route on (resource, method) with the handler's queued
// responses. Defaults: empty history at head "200", empty list, generic
// metadata get. Handlers see the parsed --params JSON.
function fakeGws(routes: {
	history?: (params: Record<string, unknown>, call: number) => unknown;
	list?: (params: Record<string, unknown>, call: number) => unknown;
	get?: (params: Record<string, unknown>, call: number) => unknown;
	profile?: (params: Record<string, unknown>, call: number) => unknown;
	fail?: { code: number; stdout: string; stderr: string };
}): { run: GwsRunner; calls: Call[] } {
	const calls: Call[] = [];
	let n = 0;
	const run: GwsRunner = async (args) => {
		calls.push({ args: [...args] });
		n++;
		if (routes.fail) return { ...routes.fail };
		const pi = args.indexOf("--params");
		const params = pi === -1 ? {} : (JSON.parse(args[pi + 1]!) as Record<string, unknown>);
		const [resource, method] = [args[2], args[3]];
		if (resource === "history" && method === "list") {
			return { code: 0, stdout: JSON.stringify(routes.history?.(params, n) ?? { historyId: "200" }), stderr: "" };
		}
		if (resource === "messages" && method === "list") {
			return { code: 0, stdout: JSON.stringify(routes.list?.(params, n) ?? { messages: [] }), stderr: "" };
		}
		if (resource === "messages" && method === "get") {
			return { code: 0, stdout: JSON.stringify(routes.get?.(params, n) ?? msgGet(String(params.id ?? "m"))) , stderr: "" };
		}
		if (resource === "getProfile") {
			return { code: 0, stdout: JSON.stringify(routes.profile?.(params, n) ?? { historyId: "999" }), stderr: "" };
		}
		throw new Error(`unexpected gws argv: ${args.join(" ")}`);
	};
	return { run, calls };
}

/** The envelope each call used: resource/method + parsed --params. */
function envelope(c: Call): { resource: string; method: string; params: Record<string, unknown> } {
	const pi = c.args.indexOf("--params");
	return {
		resource: c.args[2]!,
		method: c.args[3]!,
		params: pi === -1 ? {} : (JSON.parse(c.args[pi + 1]!) as Record<string, unknown>),
	};
}

describe("gws mail reader", () => {
	test("poll intersects arrivals with the filter, oldest first, over raw discovery flags", async () => {
		const { run, calls } = fakeGws({
			history: (p) => {
				expect(p.startHistoryId).toBe("100");
				expect(p.historyTypes).toEqual(["messageAdded"]);
				return {
					history: [
						{ id: "110", messagesAdded: [{ message: { id: "new-match" } }] },
						{ id: "111", messagesAdded: [{ message: { id: "new-other" } }] },
					],
					historyId: "120",
				};
			},
			list: (p) => {
				expect(p.q).toBe("from:bank");
				expect(p.maxResults).toBe(50);
				// Newest first — new-match is older than the noise above it.
				return { messages: [{ id: "old-noise" }, { id: "new-match" }] };
			},
		});
		const reader = makeGwsReader(run);
		const { hits, historyId } = await reader.poll("from:bank", "100");
		// new-other arrived but doesn't match; old-noise matches but isn't new.
		expect(hits.map((h) => h.id)).toEqual(["new-match"]);
		expect(historyId).toBe("120");
		expect(hits[0]).toMatchObject({ from: "a-new-match@x.com", subject: "sub-new-match" });
		// Raw discovery surface, not helpers: resource/method argv with
		// userId + --format json on every call.
		expect(calls.map((c) => c.args.slice(0, 4))).toEqual([
			["gmail", "users", "history", "list"],
			["gmail", "users", "messages", "list"],
			["gmail", "users", "messages", "get"],
		]);
		for (const c of calls) expect(c.args).toContain("--format");
		expect(envelope(calls[0]!).params.userId).toBe("me");
	});

	test("poll reads every history page before advancing the cursor", async () => {
		const seen: unknown[] = [];
		const { run } = fakeGws({
			history: (p) => {
				seen.push(p.pageToken ?? "");
				return p.pageToken === undefined || p.pageToken === ""
					? { history: [], historyId: "150", nextPageToken: "more" }
					: { history: [{ id: "120", messagesAdded: [{ message: { id: "late" } }] }], historyId: "150" };
			},
			list: () => ({ messages: [{ id: "late" }] }),
		});
		const out = await makeGwsReader(run).poll("from:bank", "100");
		expect(seen).toEqual(["", "more"]);
		expect(out.hits.map((h) => h.id)).toEqual(["late"]);
		expect(out.historyId).toBe("150");
	});

	test("poll sorts records ascending and batches whole records at the cap", async () => {
		const ids = Array.from({ length: 14 }, (_, i) => `m${i + 1}`);
		const records = ids.map((id, i) => ({
			id: String(101 + i),
			messagesAdded: [{ message: { id } }],
		}));
		const { run } = fakeGws({
			// Descending on purpose — the reader must sort before batching.
			history: (p) => ({
				history: records.filter((r) => Number(r.id) > Number(p.startHistoryId)).reverse(),
				historyId: "200",
			}),
			list: () => ({ messages: [...ids].reverse().map((id) => ({ id })) }),
		});
		const reader = makeGwsReader(run);
		const first = await reader.poll("from:bank", "100");
		expect(first.hits.map((h) => h.id)).toEqual(ids.slice(0, 10));
		expect(first.historyId).toBe("110");
		const second = await reader.poll("from:bank", first.historyId);
		expect(second.hits.map((h) => h.id)).toEqual(ids.slice(10));
		expect(second.historyId).toBe("200");
	});

	test("a single record over the cap fires cap-many, skips the rest, and warns", async () => {
		const ids = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
		const { run } = fakeGws({
			history: () => ({
				history: [{ id: "150", messagesAdded: ids.map((id) => ({ message: { id } })) }],
				historyId: "200",
			}),
			list: () => ({ messages: [...ids].reverse().map((id) => ({ id })) }),
		});
		const captured: string[] = [];
		setLogFile("gws-poll-collapse-test.log");
		setLogWriter((_path, line) => {
			captured.push(line);
		});
		let out: { hits: MailHit[]; historyId: string };
		try {
			out = await makeGwsReader(run).poll("from:bank", "100");
		} finally {
			setLogFile(null);
			setLogWriter(null);
		}
		expect(out.hits.map((h) => h.id)).toEqual(ids.slice(0, 10));
		expect(out.historyId).toBe("150");
		const warns = captured
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((l) => l.msg === "Gmail collapsed a burst into one history record — 2 matches skipped");
		expect(warns).toHaveLength(1);
		expect(warns[0]).toMatchObject({ level: "warn", filter: "from:bank", matched: 12, firing: 10 });
	});

	test("a full filter list page warns — older matches may be invisible to the intersection", async () => {
		const { run } = fakeGws({
			history: () => ({
				history: ["m1", "m2"].map((id, i) => ({
					id: String(101 + i),
					messagesAdded: [{ message: { id } }],
				})),
				historyId: "200",
			}),
			list: () => ({
				messages: [{ id: "m2" }, { id: "m1" }, ...Array.from({ length: 48 }, (_, i) => ({ id: `x${i}` }))],
			}),
		});
		const captured: string[] = [];
		setLogFile("gws-poll-fullpage-test.log");
		setLogWriter((_path, line) => {
			captured.push(line);
		});
		let out: { hits: MailHit[]; historyId: string };
		try {
			out = await makeGwsReader(run).poll("from:bank", "100");
		} finally {
			setLogFile(null);
			setLogWriter(null);
		}
		expect(out.hits.map((h) => h.id)).toEqual(["m1", "m2"]);
		expect(out.historyId).toBe("200");
		const warns = captured
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((l) => l.msg === "mail poll filter list page full — matches older than the newest 50 may be skipped by this checkpoint");
		expect(warns).toHaveLength(1);
		expect(warns[0]).toMatchObject({ level: "warn", filter: "from:bank", listed: 50 });
	});

	test("poll with no arrivals advances the checkpoint without a list call", async () => {
		const { run, calls } = fakeGws({ history: () => ({ historyId: "130" }) });
		const out = await makeGwsReader(run).poll("from:bank", "120");
		expect(out).toEqual({ hits: [], historyId: "130" });
		expect(calls.map((c) => c.args[3])).toEqual(["list"]);
	});

	test("a 404 history list surfaces as HistoryExpiredError", async () => {
		const { run } = fakeGws({
			fail: {
				code: 1,
				stdout: JSON.stringify({ error: { code: 404, message: "Requested entity was not found." } }),
				stderr: "error[api]: ...",
			},
		});
		await expect(makeGwsReader(run).poll("from:bank", "1")).rejects.toBeInstanceOf(HistoryExpiredError);
	});

	test("a non-404 gws failure propagates as a poll failure with the exit code", async () => {
		const { run } = fakeGws({
			fail: {
				code: 2,
				stdout: JSON.stringify({ error: { code: 401, message: "Access denied." } }),
				stderr: "error[auth]: Access denied. Run `gws auth login`.",
			},
		});
		await expect(makeGwsReader(run).poll("from:bank", "1")).rejects.toThrow("gws: poll.history failed — HTTP 401");
	});

	test("a repeated history page token fails loud with the cursor unchanged", async () => {
		const { run } = fakeGws({
			history: () => ({ history: [], historyId: "150", nextPageToken: "loop" }),
		});
		await expect(makeGwsReader(run).poll("from:bank", "100")).rejects.toThrow("repeated or exceeded 100 pages");
	});

	test("an unexpected gws shape fails loud, never as empty results", async () => {
		const run: GwsRunner = async () => ({ code: 0, stdout: JSON.stringify({ nope: true }), stderr: "" });
		await expect(makeGwsReader(run).profileHistoryId()).rejects.toThrow("carried no historyId");
	});

	test("profileHistoryId returns the baseline checkpoint", async () => {
		const { run, calls } = fakeGws({ profile: () => ({ historyId: "999", messagesTotal: 1 }) });
		expect(await makeGwsReader(run).profileHistoryId()).toBe("999");
		expect(calls[0]!.args.slice(0, 3)).toEqual(["gmail", "users", "getProfile"]);
	});

	test("threadFor returns thread context; a 404 target is null", async () => {
		const { run } = fakeGws({
			get: (p) => {
				if (p.id === "ghost") {
					throw new Error("unreachable — the 404 arm below handles ghosts");
				}
				return { id: "m1", threadId: "thread-9", payload: { headers: [{ name: "Message-ID", value: "<orig@mail>" }] } };
			},
		});
		expect(await makeGwsReader(run).threadFor("m1")).toEqual({ threadId: "thread-9", messageId: "<orig@mail>" });
		const ghost: GwsRunner = async () => ({
			code: 1,
			stdout: JSON.stringify({ error: { code: 404, message: "not found" } }),
			stderr: "",
		});
		expect(await makeGwsReader(ghost).threadFor("ghost")).toBeNull();
	});

	test("a spawn failure fails the call without hanging", async () => {
		const run: GwsRunner = async () => {
			throw new Error("spawn gws ENOENT");
		};
		await expect(makeGwsReader(run).profileHistoryId()).rejects.toThrow("could not spawn gws");
	});

	test("gws result contract: exit code, stdout, stderr", () => {
		const r: GwsRunResult = { code: 0, stdout: "{}", stderr: "" };
		expect(r.code).toBe(0);
	});
});

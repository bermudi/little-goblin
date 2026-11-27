// Fakes gws at the process seam — the fake speaks the real argv
// surface mail-gws.ts calls: `gmail users history list / messages
// list|get / getProfile --params JSON --format json`, JSON on stdout,
// exit code + stderr on failure.

import { describe, expect, spyOn, test } from "bun:test";
import { log, setLogFile, setLogWriter } from "./log.ts";
import { HistoryExpiredError, type MailHit } from "./mail.ts";
import { GwsApiError, makeGwsReader, type GwsRunner } from "./mail-gws.ts";
import { envelope, fakeGws, msgGet } from "./testkit/fake-gws.ts";

async function poll(run: GwsRunner, filter: string, cursor: string) {
	const reader = makeGwsReader(run);
	return reader.matches(await reader.history(cursor), filter, cursor);
}

describe("gws mail reader", () => {
	test("metadata batch skips missing and fatal messages but aborts on transient failures", async () => {
		const makeRunner = (failure: (id: string) => number | null): GwsRunner => async (args) => {
			const resource = args[2];
			const method = args[3];
			const params = envelope({ args }).params;
			if (resource === "history" && method === "list") {
				return {
					code: 0,
					stdout: JSON.stringify({ history: [{ id: "110", messagesAdded: [
						{ message: { id: "m1" } }, { message: { id: "m2" } },
					] }], historyId: "120" }),
					stderr: "",
				};
			}
			if (resource === "messages" && method === "list") {
				return { code: 0, stdout: JSON.stringify({ messages: [{ id: "m2" }, { id: "m1" }] }), stderr: "" };
			}
			if (resource === "messages" && method === "get") {
				const code = failure(String(params.id));
				if (code !== null) {
					return { code: 1, stdout: JSON.stringify({ error: { code } }), stderr: "failed" };
				}
				return { code: 0, stdout: JSON.stringify(msgGet(String(params.id))), stderr: "" };
			}
			throw new Error(`unexpected gws route: ${args.join(" ")}`);
		};
		const skipped = makeGwsReader(makeRunner((id) => id === "m1" ? 404 : null));
		const out = await poll(makeRunner((id) => id === "m1" ? 404 : null), "from:test", "100");
		expect(out.hits.map((hit) => hit.id)).toEqual(["m2"]);
		expect(out.historyId).toBe("120");

		const fatal = makeGwsReader(makeRunner((id) => id === "m1" ? 403 : null));
		expect((await poll(makeRunner((id) => id === "m1" ? 403 : null), "from:test", "100")).hits.map((hit) => hit.id)).toEqual(["m2"]);

		const transient = makeGwsReader(makeRunner((id) => id === "m1" ? 503 : null));
		await expect(poll(makeRunner((id) => id === "m1" ? 503 : null), "from:test", "100")).rejects.toMatchObject({
			boundary: "gws", kind: "transient",
		});
	});
	test("classifies API status and malformed data errors", async () => {
		for (const [code, kind] of [[404, "missing"], [429, "transient"], [503, "transient"], [403, "fatal"]] as const) {
			const run: GwsRunner = async () => ({
				code: 1, stdout: JSON.stringify({ error: { code } }), stderr: "",
			});
			const err = await makeGwsReader(run).profileHistoryId().catch((e: unknown) => e);
			expect(err).toBeInstanceOf(GwsApiError);
			expect(err).toMatchObject({ kind, boundary: "gws" });
		}
		const malformed: GwsRunner = async () => ({ code: 0, stdout: "{}", stderr: "" });
		const err = await makeGwsReader(malformed).profileHistoryId().catch((e: unknown) => e);
		expect(err).toMatchObject({ kind: "fatal", boundary: "gws" });
	});
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
		const { hits, historyId } = await poll(run, "from:bank", "100");
		// new-other arrived but doesn't match; old-noise matches but isn't new.
		expect(hits.map((h) => h.id)).toEqual(["new-match"]);
		// new-other is an arrival the search does not show — lag or noise,
		// unknowable — so the checkpoint holds at record 110 instead of
		// the head: record 111 re-arrives next poll and is offered again.
		expect(historyId).toBe("110");
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

	test("history reads every page and returns its records with the head", async () => {
		const seen: unknown[] = [];
		const { run } = fakeGws({
			history: (p) => {
				seen.push(p.pageToken ?? "");
				return p.pageToken === undefined || p.pageToken === ""
					? { history: [], historyId: "150", nextPageToken: "more" }
					: {
							history: [{ id: "120", messagesAdded: [{ message: { id: "late" } }] }],
							historyId: "150",
						};
			},
			list: () => ({ messages: [{ id: "late" }] }),
		});
		const out = await makeGwsReader(run).history("100");
		expect(seen).toEqual(["", "more"]);
		expect(out).toEqual({ records: [{ id: "120", ids: ["late"] }], historyId: "150" });
	});

	test("matches offers each cursor only the records after it", async () => {
		const { run, calls } = fakeGws({
			history: () => ({
				history: ["105:m0", "110:m1", "111:m2"].map((entry) => {
					const [id, message] = entry.split(":");
					return { id, messagesAdded: [{ message: { id: message } }] };
				}),
				historyId: "120",
			}),
			list: () => ({ messages: [{ id: "m2" }, { id: "m1" }, { id: "m0" }] }),
		});
		const reader = makeGwsReader(run);
		const page = await reader.history("100");
		const first = await reader.matches(page, "from:bank", "100");
		const second = await reader.matches(page, "from:bank", "110");
		expect(first.hits.map((h) => h.id)).toEqual(["m0", "m1", "m2"]);
		expect(first.historyId).toBe("120");
		expect(second.hits.map((h) => h.id)).toEqual(["m2"]);
		expect(second.historyId).toBe("120");
		expect(calls.map((c) => c.args.slice(0, 4))).toEqual([
			["gmail", "users", "history", "list"],
			["gmail", "users", "messages", "list"],
			["gmail", "users", "messages", "get"],
			["gmail", "users", "messages", "get"],
			["gmail", "users", "messages", "get"],
			["gmail", "users", "messages", "list"],
			["gmail", "users", "messages", "get"],
		]);
	});

	test("a cursor at or past the last record gets the head with no list call", async () => {
		const { run, calls } = fakeGws({
			history: () => ({
				history: ["105:m0", "110:m1"].map((entry) => {
					const [id, message] = entry.split(":");
					return { id, messagesAdded: [{ message: { id: message } }] };
				}),
				historyId: "120",
			}),
			list: () => ({ messages: [] }),
		});
		const reader = makeGwsReader(run);
		const page = await reader.history("100");
		expect(await reader.matches(page, "from:bank", "110")).toEqual({ hits: [], historyId: "120" });
		expect(await reader.matches(page, "from:bank", "120")).toEqual({ hits: [], historyId: "120" });
		expect(calls.some((c) => c.args[2] === "messages" && c.args[3] === "list")).toBe(false);
	});

	test("history ids sort and compare exactly beyond what Number holds", async () => {
		const { run } = fakeGws({
			history: () => ({
				history: ["9007199254740995:m2", "9007199254740993:m1"].map((entry) => {
					const [id, message] = entry.split(":");
					return { id, messagesAdded: [{ message: { id: message } }] };
				}),
				historyId: "9007199254740999",
			}),
			list: () => ({ messages: [{ id: "m2" }, { id: "m1" }] }),
		});
		const reader = makeGwsReader(run);
		const page = await reader.history("9007199254740992");
		const first = await reader.matches(page, "from:bank", "9007199254740992");
		const second = await reader.matches(page, "from:bank", "9007199254740993");
		expect(first.hits.map((h) => h.id)).toEqual(["m1", "m2"]);
		expect(first.historyId).toBe("9007199254740999");
		expect(second.hits.map((h) => h.id)).toEqual(["m2"]);
	});

	test("a non-numeric history id is provider drift and fails loud", async () => {
		const record: GwsRunner = async () => ({
			code: 0,
			stdout: JSON.stringify({ history: [{ id: "zz", messagesAdded: [{ message: { id: "m" } }] }], historyId: "200" }),
			stderr: "",
		});
		const page: GwsRunner = async () => ({
			code: 0, stdout: JSON.stringify({ historyId: "12a" }), stderr: "",
		});
		const profile: GwsRunner = async () => ({
			code: 0, stdout: JSON.stringify({ historyId: "x" }), stderr: "",
		});
		await expect(makeGwsReader(record).history("100")).rejects.toThrow(/poll\.history returned an unexpected shape/);
		await expect(makeGwsReader(page).history("100")).rejects.toThrow(/poll\.history returned an unexpected shape/);
		await expect(makeGwsReader(profile).profileHistoryId()).rejects.toThrow(/profile\.get returned an unexpected shape/);
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
		const first = await poll(run, "from:bank", "100");
		expect(first.hits.map((h) => h.id)).toEqual(ids.slice(0, 10));
		expect(first.historyId).toBe("110");
		const second = await poll(run, "from:bank", first.historyId);
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
			out = await poll(run, "from:bank", "100");
		} finally {
			setLogFile(null);
			setLogWriter(null);
		}
		expect(out.hits.map((h) => h.id)).toEqual(ids.slice(0, 10));
		expect(out.historyId).toBe("150");
		const warns = captured
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter(
				(l) => l.msg === "Gmail collapsed a burst into one history record — 2 matches skipped",
			);
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
				messages: [
					{ id: "m2" },
					{ id: "m1" },
					...Array.from({ length: 48 }, (_, i) => ({ id: `x${i}` })),
				],
			}),
		});
		const captured: string[] = [];
		setLogFile("gws-poll-fullpage-test.log");
		setLogWriter((_path, line) => {
			captured.push(line);
		});
		let out: { hits: MailHit[]; historyId: string };
		try {
			out = await poll(run, "from:bank", "100");
		} finally {
			setLogFile(null);
			setLogWriter(null);
		}
		expect(out.hits.map((h) => h.id)).toEqual(["m1", "m2"]);
		expect(out.historyId).toBe("200");
		const warns = captured
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter(
				(l) =>
					l.msg ===
					"mail poll filter list page full — matches older than the newest 50 may be skipped by this checkpoint",
			);
		expect(warns).toHaveLength(1);
		expect(warns[0]).toMatchObject({ level: "warn", filter: "from:bank", listed: 50 });
	});

	test("poll with no arrivals advances the checkpoint without a list call", async () => {
		const { run, calls } = fakeGws({ history: () => ({ historyId: "130" }) });
		const out = await poll(run, "from:bank", "120");
		expect(out).toEqual({ hits: [], historyId: "130" });
		expect(calls.map((c) => c.args[3])).toEqual(["list"]);
	});

	test("an arrival the filter list cannot show holds the checkpoint — index lag is not a skip", async () => {
		// The report's sketch: one history record with message m, head
		// past it, and a filter list that cannot see m yet. The old
		// behavior returned the head and skipped m forever.
		const { run } = fakeGws({
			history: () => ({
				history: [{ id: "150", messagesAdded: [{ message: { id: "m" } }] }],
				historyId: "155",
			}),
			list: () => ({ messages: [] }),
		});
		const captured: string[] = [];
		setLogFile("gws-poll-hold-test.log");
		setLogWriter((_path, line) => {
			captured.push(line);
		});
		let out: { hits: MailHit[]; historyId: string };
		try {
			out = await poll(run, "from:bank", "100");
		} finally {
			setLogFile(null);
			setLogWriter(null);
		}
		// The cursor does not move past the record: ""-free hold at the
		// poll's own cursor keeps the record ahead of it for the next poll.
		expect(out).toEqual({ hits: [], historyId: "100" });
		const holds = captured
			.map((l) => JSON.parse(l) as Record<string, unknown>)
			.filter((l) => l.msg?.toString().startsWith("mail poll checkpoint held"));
		expect(holds).toHaveLength(1);
		expect(holds[0]).toMatchObject({ level: "info", filter: "from:bank", boundary: "100" });
	});

	test("a lagged match fires on redelivery once the search can see it", async () => {
		let listCall = 0;
		const { run } = fakeGws({
			history: (p) => ({
				history:
					Number(p.startHistoryId) < 150
						? [{ id: "150", messagesAdded: [{ message: { id: "m" } }] }]
						: [],
				historyId: "155",
			}),
			list: () => (++listCall === 1 ? { messages: [] } : { messages: [{ id: "m" }] }),
		});
		const first = await poll(run, "from:bank", "100");
		expect(first).toEqual({ hits: [], historyId: "100" });
		const second = await poll(run, "from:bank", first.historyId);
		expect(second.hits.map((h) => h.id)).toEqual(["m"]);
		expect(second.historyId).toBe("155");
	});

	test("the hold never crosses a fired record — the fired match cannot refire", async () => {
		const { run } = fakeGws({
			history: (p) => ({
				history: [
					{ id: "110", messagesAdded: [{ message: { id: "m1" } }] },
					{ id: "111", messagesAdded: [{ message: { id: "m2" } }] },
				].filter((r) => Number(r.id) > Number(p.startHistoryId)),
				historyId: "120",
			}),
			// The search confirms m1 only — m2 is unconfirmed.
			list: () => ({ messages: [{ id: "m1" }] }),
		});
		const first = await poll(run, "from:bank", "100");
		expect(first.hits.map((h) => h.id)).toEqual(["m1"]);
		// Held at the fired record's boundary, not the head: m2's record
		// re-arrives, m1's cannot.
		expect(first.historyId).toBe("110");
		const second = await poll(run, "from:bank", first.historyId);
		// The API returns records after 110 — m1 cannot re-arrive; m2 is
		// offered again and still unconfirmed, so the hold stands.
		expect(second.hits).toEqual([]);
		expect(second.historyId).toBe("110");
	});

	test("an arrival that outlasts the grace window is treated as a non-match — the cursor advances", async () => {
		// Grace is counted in records observed after the candidate —
		// history ids are opaque and gappy, their distance means nothing.
		// 50 later records past the candidate is the full grace.
		const { run } = fakeGws({
			history: () => ({
				history: [
					{ id: "150", messagesAdded: [{ message: { id: "m" } }] },
					...Array.from({ length: 50 }, (_, i) => ({ id: String(151 + i) })),
				],
				historyId: "250",
			}),
			list: () => ({ messages: [] }),
		});
		const out = await poll(run, "from:bank", "100");
		expect(out).toEqual({ hits: [], historyId: "250" });
	});

	test("the hold skips an aged-out unconfirmed record and pins to the next fresh one", async () => {
		// 140 trails 51 later records — aged out. 191 trails none — fresh,
		// so the hold pins to its predecessor, 190.
		const { run } = fakeGws({
			history: () => ({
				history: [
					{ id: "140", messagesAdded: [{ message: { id: "old" } }] },
					...Array.from({ length: 50 }, (_, i) => ({ id: String(141 + i) })),
					{ id: "191", messagesAdded: [{ message: { id: "new" } }] },
				],
				historyId: "250",
			}),
			list: () => ({ messages: [] }),
		});
		const out = await poll(run, "from:bank", "100");
		expect(out).toEqual({ hits: [], historyId: "190" });
	});

	test("a 404 history list surfaces as HistoryExpiredError", async () => {
		const { run } = fakeGws({
			fail: {
				code: 1,
				stdout: JSON.stringify({
					error: { code: 404, message: "Requested entity was not found." },
				}),
				stderr: "error[api]: ...",
			},
		});
		await expect(makeGwsReader(run).history("1")).rejects.toBeInstanceOf(
			HistoryExpiredError,
		);
	});

	test("a failure that merely MENTIONS 404 in stderr is not expiry (parsed code, not substring)", async () => {
		// No API error envelope on stdout — the stderr happens to say
		// "404". The old substring match silently re-baselined here,
		// skipping owed mail; the parsed apiCode must refuse the leap.
		const { run } = fakeGws({
			fail: {
				code: 1,
				stdout: "",
				stderr: "gws: connection reset while fetching (last status 404 in a log line)",
			},
		});
		await expect(makeGwsReader(run).history("1")).rejects.not.toBeInstanceOf(
			HistoryExpiredError,
		);
		await expect(makeGwsReader(run).threadFor("m1")).rejects.toBeInstanceOf(Error);
	});

	test("a non-404 gws failure propagates as a poll failure with the exit code", async () => {
		const { run } = fakeGws({
			fail: {
				code: 2,
				stdout: JSON.stringify({ error: { code: 401, message: "Access denied." } }),
				stderr: "error[auth]: Access denied. Run `gws auth login`.",
			},
		});
		await expect(makeGwsReader(run).history("1")).rejects.toThrow(
			"poll.history failed — HTTP 401",
		);
	});

	test("a repeated history page token fails loud with the cursor unchanged", async () => {
		const { run } = fakeGws({
			history: () => ({ history: [], historyId: "150", nextPageToken: "loop" }),
		});
		await expect(makeGwsReader(run).history("100")).rejects.toThrow(
			"repeated or exceeded 100 pages",
		);
	});

	test("an unexpected gws shape fails loud, never as empty results", async () => {
		const run: GwsRunner = async () => ({
			code: 0,
			stdout: JSON.stringify({ nope: true }),
			stderr: "",
		});
		await expect(makeGwsReader(run).profileHistoryId()).rejects.toThrow("unexpected shape");
	});

	test("a send-shaped drift on reads fails loud too — an id-less meta.get and a historyId-less page", async () => {
		// meta.get without id: used to silently substitute the request id —
		// exercise it through threadFor (the public seam over getMetadata).
		const noId: GwsRunner = async () => ({
			code: 0,
			stdout: JSON.stringify({ threadId: "t", snippet: "s" }),
			stderr: "",
		});
		await expect(makeGwsReader(noId).threadFor("m9")).rejects.toThrow(
			"reply.get returned an unexpected shape",
		);
		// history.list without historyId: used to collapse to "" and
		// leave the checkpoint to a warn-and-retry; drift should name
		// itself at the boundary instead.
		const noHistoryId: GwsRunner = async () => ({
			code: 0,
			stdout: JSON.stringify({ history: [] }),
			stderr: "",
		});
		await expect(makeGwsReader(noHistoryId).history("1")).rejects.toThrow(
			"poll.history returned an unexpected shape",
		);
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
				return {
					id: "m1",
					threadId: "thread-9",
					payload: { headers: [{ name: "Message-ID", value: "<orig@mail>" }] },
				};
			},
		});
		expect(await makeGwsReader(run).threadFor("m1")).toEqual({
			threadId: "thread-9",
			messageId: "<orig@mail>",
		});
		const ghost: GwsRunner = async () => ({
			code: 1,
			stdout: JSON.stringify({ error: { code: 404, message: "not found" } }),
			stderr: "",
		});
		expect(await makeGwsReader(ghost).threadFor("ghost")).toBeNull();
	});

	test("Message-ID is not RFC 2047 decoded and invalid values are rejected", async () => {
		const warning = spyOn(log, "warn").mockImplementation(() => {});
		try {
			for (const value of [
				"=?UTF-8?Q?<a@b>=0D=0ABcc:_x@y>?=",
				"<a b@c>",
				"<a\u0085Bcc:_evil@x>",
				"<a\u0000@b>",
			]) {
				const run: GwsRunner = async () => ({
					code: 0,
					stdout: JSON.stringify({
						id: "m1",
						threadId: "thread-9",
						payload: { headers: [{ name: "Message-ID", value }] },
					}),
					stderr: "",
				});
				expect(await makeGwsReader(run).threadFor("m1")).toEqual({
					threadId: "thread-9",
					messageId: null,
				});
			}
			const valid: GwsRunner = async () => ({
				code: 0,
				stdout: JSON.stringify({
					id: "m1",
					threadId: "thread-9",
					payload: { headers: [{ name: "Message-ID", value: "<a@b>" }] },
				}),
				stderr: "",
			});
			expect(await makeGwsReader(valid).threadFor("m1")).toEqual({
				threadId: "thread-9",
				messageId: "<a@b>",
			});
			expect(warning).toHaveBeenCalledTimes(4);
			expect(warning).toHaveBeenCalledWith("mail message-id rejected", {
				length: "<a\u0085Bcc:_evil@x>".length,
				reason: "line_break",
			});
			expect(warning).toHaveBeenCalledWith("mail message-id rejected", {
				length: "=?UTF-8?Q?<a@b>=0D=0ABcc:_x@y>?=".length,
				reason: "invalid_format",
			});
			expect(JSON.stringify(warning.mock.calls)).not.toContain("Bcc:");
		} finally {
			warning.mockRestore();
		}
	});

	test("a spawn failure fails the call without hanging", async () => {
		const run: GwsRunner = async () => {
			throw new Error("spawn gws ENOENT");
		};
		await expect(makeGwsReader(run).profileHistoryId()).rejects.toThrow("could not spawn gws");
	});
});

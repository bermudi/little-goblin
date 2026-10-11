// Live gws drift check: pins the REAL CLI's wire behavior the mail
// adapter depends on — pure-JSON stdout, the profile/history/list
// response shapes, and the error envelope (JSON with error.code on
// stdout, human text on stderr, exit 1) that apiCode() and the
// 404→null threading mapping are built on. mail-gws.test.ts fakes the
// runner — hermetic, but blind to upstream drift; this file is what
// catches a gws upgrade or a Gmail API change moving the wire
// underneath it. Gated OFF the default suite, run deliberately:
//
//     GOBLIN_GWS_LIVE=1 bun test src/mail-gws.live.test.ts
//
// Read-only by construction: no `gws auth` (an unauthenticated run
// fails loud with its HTTP code), no sends, and no mail content —
// only ids and cursor strings cross here, and nothing from any
// response is printed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { setLogFile } from "./log.ts";
import { type GwsMailReader, makeGwsReader } from "./mail-gws.ts";
import { boundedRun, spawnProc } from "./proc.ts";

const LIVE = process.env.GOBLIN_GWS_LIVE === "1";

// Matches nothing real — poll's history.list ignores the filter and
// the list intersection can only come back empty, so the poll pin
// exercises the wire without ever reading message metadata.
const IMPOSSIBLE_FILTER = "from:goblin-gws-drift-nonexistent";

// Well-formed enough for Gmail to answer notFound (long ids get
// 400 invalidArgument instead) — the exact input the adapter's
// 404→null mapping exists for.
const MISSING_ID = "aa";

let reader: GwsMailReader | null = null;
let cwd = "";

describe.skipIf(!LIVE)("gws live drift (GOBLIN_GWS_LIVE=1)", () => {
	beforeAll(() => {
		// The run's adapter log lines land in a temp file, removed at
		// teardown — never the operator's state log.
		cwd = mkdtempSync(join(tmpdir(), "goblin-gws-drift-"));
		setLogFile(join(cwd, "drift.log"));
		reader = makeGwsReader();
	});

	test("getProfile: pure-JSON stdout carrying a numeric historyId", async () => {
		// Pure JSON on stdout is load-bearing: the adapter JSON.parses
		// it directly, so any chatter there fails every call.
		const historyId = await reader!.profileHistoryId();
		expect(historyId).toMatch(/^\d+$/);
	}, 60_000);

	test("poll at head over a matchless filter: empty hits, numeric cursor", async () => {
		const head = await reader!.profileHistoryId();
		const { hits, historyId } = await reader!.poll(IMPOSSIBLE_FILTER, head);
		expect(hits).toEqual([]);
		expect(historyId).toMatch(/^\d+$/);
	}, 60_000);

	test("messages.get on a real id: the threading lookup parses live", async () => {
		// One raw list call to obtain a real message id — the adapter
		// never exposes list; ids only, parsed locally.
		const r = await boundedRun(
			spawnProc([
				"gws",
				"gmail",
				"users",
				"messages",
				"list",
				"--params",
				JSON.stringify({ userId: "me", maxResults: 1 }),
				"--format",
				"json",
			]),
			{ timeoutMs: 30_000, maxOutput: 1 << 20 },
		);
		expect(r.exitCode).toBe(0);
		const page = z
			.object({
				messages: z.array(z.object({ id: z.string() }).passthrough()).optional(),
			})
			.parse(JSON.parse(r.stdout) as unknown);
		const id = page.messages?.[0]?.id;
		if (id === undefined) {
			throw new Error("mailbox has no messages — cannot pin the threading lookup");
		}
		const hit = await reader!.threadFor(id);
		if (hit === null) throw new Error(`threadFor returned null for live message ${id}`);
		expect(hit.threadId).not.toBe("");
		expect(hit.messageId === null || typeof hit.messageId === "string").toBe(true);
	}, 60_000);

	test("messages.get on an absent id maps 404 to null", async () => {
		// Red here means gws moved the error envelope off stdout or the
		// API code changed — poll's history-expiry re-baseline hinges on
		// this exact mapping.
		expect(await reader!.threadFor(MISSING_ID)).toBeNull();
	}, 60_000);

	afterAll(() => {
		setLogFile(null);
		if (cwd !== "") rmSync(cwd, { recursive: true, force: true });
	});
});

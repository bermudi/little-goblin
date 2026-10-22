// Boot-level contract: the app channel, HTTP, scheduler and mail watcher
// stand without Telegram — the channel attaches (or degrades) through the
// deferred init task. Every case spawns the real src/index.ts under an
// isolated GOBLIN_HOME with the loopback-only preload and a controllable
// fake Bot API; no real credentials, models, or network.

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setLogFile } from "./log.ts";
import { openOutbox } from "./mail-outbox.ts";
import { openPrograms } from "./programs.ts";
import { bootChild, fakeTelegram } from "./test-helpers/boot.ts";
import { tmpDir } from "./testkit.ts";

setLogFile(null);

const T = 30_000;
const TG_TOKEN = "0000:synthetic-fixture-token";

// A real WebAppData-signed initData blob — proves the late-bound botToken
// getter, not just a token-shaped string.
function signedInitData(userId: number): string {
	const user = JSON.stringify({ id: userId, first_name: "Op", username: "op" });
	const params = new URLSearchParams({
		auth_date: String(Math.floor(Date.now() / 1000)),
		user,
	});
	const checkString = [...params.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${v}`)
		.join("\n");
	const secret = createHmac("sha256", "WebAppData").update(TG_TOKEN).digest();
	params.set("hash", createHmac("sha256", secret).update(checkString).digest("hex"));
	return params.toString();
}

describe("deferred telegram boot", () => {
	test(
		"enabled + missing telegram auth degrades the channel; the app serves",
		async () => {
			const tg = fakeTelegram({ getMe: "ok", getUpdates: "hold" });
			const child = bootChild({
				baseDir: tmpDir(),
				telegram: { enabled: true, apiRoot: tg.apiRoot },
				withTelegramAuth: false,
			});
			try {
				await child.waitLog("http listening");
				expect((await child.http("/api/app/status")).status).toBe(200);
				await child.waitLog("telegram channel init failed");
				// Auth never resolved → the fake API sees nothing.
				expect(tg.methods).toEqual([]);
			} finally {
				await child.stop();
				tg.stop();
			}
		},
		T,
	);

	test(
		"enabled + getMe 401 degrades the channel; the app serves",
		async () => {
			const tg = fakeTelegram({ getMe: "unauthorized", getUpdates: "hold" });
			const child = bootChild({
				baseDir: tmpDir(),
				telegram: { enabled: true, apiRoot: tg.apiRoot },
			});
			try {
				await child.waitLog("http listening");
				expect((await child.http("/api/app/status")).status).toBe(200);
				await child.waitLog("telegram channel init failed");
				expect(tg.methods).toContain("getMe");
				expect(tg.methods).not.toContain("getUpdates");
			} finally {
				await child.stop();
				tg.stop();
			}
		},
		T,
	);

	test(
		"getMe held behind a gate: the app serves while pending, then attach reconnects every seam",
		async () => {
			const tg = fakeTelegram({ getMe: "held", getUpdates: "hold" });
			const child = bootChild({
				baseDir: tmpDir(),
				telegram: { enabled: true, apiRoot: tg.apiRoot },
				seed: (home) => {
					// A Telegram-targeted program due now is held at the boot scan
					// (no delivery yet); a pending outbox row exercises the lane.
					// bindDraft makes it an already-presented pre-restart draft —
					// synthetic durable state, not presentation in this test.
					mkdirSync(join(home, "state"), { recursive: true });
					const dbPath = join(home, "state", "goblin.sqlite");
					const programs = openPrograms(dbPath);
					programs.create(
						{
							name: "tg catch-up",
							charter: "say hi",
							cron: "* * * * *",
							maxLatenessMinutes: null,
							address: { chatId: 42, threadId: null },
						},
						new Date(Date.now() - 10 * 60_000),
					);
					programs.close();
					const outbox = openOutbox(dbPath);
					const draft = outbox.queue({
						to: ["a@b.c"],
						subject: "s",
						body: "b",
						address: { chatId: 42, threadId: null },
					});
					outbox.bindDraft(draft.id, 7001);
					outbox.close();
				},
			});
			try {
				await child.waitLog("http listening");
				// getMe is in flight and the app is already fully usable.
				await tg.waitMethod("getMe");
				expect((await child.http("/api/app/status")).status).toBe(200);
				const created = await child.http("/api/app/conversations", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				});
				expect(created.status).toBe(201);
				const listed = await child.http("/api/app/conversations");
				expect(listed.status).toBe(200);
				expect(JSON.stringify(await listed.json())).toContain("app/");
				// Every Telegram door fails closed while unattached: mini-app
				// page, initData auth, and the held program does NOT fire.
				expect((await child.http("/t/settings")).status).toBe(503);
				expect(
					(
						await child.http("/api/status", {
							headers: { "x-init-data": signedInitData(42) },
						})
					).status,
				).not.toBe(200);
				expect(tg.methods).not.toContain("sendMessage");
				// Release auth — the channel attaches, replays, polls.
				tg.releaseGetMe();
				await child.waitLog("telegram channel attached");
				await child.waitLog("long polling started");
				expect(tg.methods).toContain("getUpdates");
				// Late-bound seams are live now: the held due program fires via
				// the attach-time tick (sendMessage through delivery), and the
				// mail cancel stamps the presented draft through the telegram
				// lane — an editMessageText the unavailable lane could never issue.
				await tg.waitMethod("sendMessage");
				const cancel = await child.http("/api/app/approvals/mail/1", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ action: "cancel" }),
				});
				expect(cancel.status).toBe(200);
				const cancelBody = (await cancel.json()) as { status: string };
				expect(cancelBody.status).toBe("cancelled");
				await tg.waitMethod("editMessageText");
				const stamp = tg.calls.find((c) => c.method === "editMessageText")!;
				expect(stamp.body.message_id).toBe(7001);
				expect(stamp.body.chat_id).toBe(42);
				expect(String(stamp.body.text)).toContain("cancelled");
				// The mini-app door opens on a real signed blob.
				expect(
					(
						await child.http("/api/status", {
							headers: { "x-init-data": signedInitData(42) },
						})
					).status,
				).toBe(200);
				expect((await child.http("/api/app/status")).status).toBe(200);
			} finally {
				await child.stop();
				tg.stop();
			}
		},
		T,
	);

	test(
		"disabled + no auth + no operators: the app serves and the mini-app refuses",
		async () => {
			const tg = fakeTelegram({ getMe: "ok", getUpdates: "hold" });
			const child = bootChild({ baseDir: tmpDir(), telegram: { enabled: false } });
			try {
				await child.waitLog("http listening");
				await child.waitLog("telegram channel disabled");
				expect((await child.http("/api/app/status")).status).toBe(200);
				expect((await child.http("/api/app/conversations")).status).toBe(200);
				expect((await child.http("/t/settings")).status).toBe(503);
				expect(tg.methods).toEqual([]);
			} finally {
				await child.stop();
				tg.stop();
			}
		},
		T,
	);

	test(
		"a 401 getUpdates after attach detaches the channel; the app stays up",
		async () => {
			const tg = fakeTelegram({ getMe: "ok", getUpdates: "unauthorized" });
			const child = bootChild({
				baseDir: tmpDir(),
				telegram: { enabled: true, apiRoot: tg.apiRoot },
			});
			try {
				await child.waitLog("http listening");
				await child.waitLog("telegram channel attached");
				await child.waitLog("telegram polling ended");
				expect(tg.methods).toContain("getUpdates");
				// Detached seams stay refused but the process and app live.
				expect((await child.http("/api/app/status")).status).toBe(200);
				expect((await child.http("/t/settings")).status).toBe(503);
			} finally {
				await child.stop();
				tg.stop();
			}
		},
		T,
	);

	test(
		"SIGTERM during a held getMe exits clean and never reaches replay or polling",
		async () => {
			const tg = fakeTelegram({ getMe: "held", getUpdates: "hold" });
			const child = bootChild({
				baseDir: tmpDir(),
				telegram: { enabled: true, apiRoot: tg.apiRoot },
			});
			try {
				await child.waitLog("http listening");
				await tg.waitMethod("getMe");
				const done = child.stop();
				// The seal is only proven once shutdown actually begins.
				await child.waitLog("shutting down");
				tg.releaseGetMe();
				expect(await done).toBe(0);
				expect(tg.methods).not.toContain("getUpdates");
				const logs = child.lines().join("\n");
				expect(logs).not.toContain("telegram channel attached");
				expect(logs).not.toContain("telegram inbox recovery queued");
				expect(logs).not.toContain("long polling started");
				expect(logs).toContain('"msg":"bye"');
			} finally {
				try {
					// A held getMe must never outlive the test even on failure.
					tg.releaseGetMe();
					await child.stop();
				} finally {
					tg.stop();
				}
			}
		},
		T,
	);
});

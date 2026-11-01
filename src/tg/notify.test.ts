import { describe, expect, test } from "bun:test";
import type { Api } from "grammy";
import { formatAddress, type ConversationAddress } from "../conversation.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpDir } from "../testkit.ts";
import { join } from "node:path";
import { setLogFile, setLogWriter } from "../log.ts";
import { proposalFingerprint } from "../skill-decisions.ts";
import { TelegramTimeoutError } from "./deadline.ts";
import {
	parseConversationAddress,
	sendMemoryBlockedNotice,
	sendMemoryOutageNotice,
	sendRollMarker,
	sendSkillProposedNotice,
} from "./notify.ts";

// formatAddress ∘ parseConversationAddress must be the identity on every
// address goblin stores — the outage notice depends on the round trip.
// Colocated here because the invariant spans both modules (review
// finding: held by convention only, untested).
describe("conversation address round trip", () => {
	const addresses: ConversationAddress[] = [
		{ kind: "dm", chatId: 1 },
		{ kind: "dm", chatId: -100200300 },
		{ kind: "topic", chatId: -100200300, threadId: 546216 },
	];
	for (const addr of addresses) {
		test(`${formatAddress(addr)} parses back`, () => {
			expect(parseConversationAddress(formatAddress(addr))).toEqual(
				addr.kind === "dm"
					? { chatId: addr.chatId, threadId: null }
					: { chatId: addr.chatId, threadId: (addr as { threadId: number }).threadId },
			);
		});
	}

	test("a rolling conversation id decodes to its bare chat", () => {
		// dm:<chat>:<n> — the rolling DM's door is the private chat,
		// never a thread (Rolling DM).
		expect(parseConversationAddress("dm:1:2")).toEqual({ chatId: 1, threadId: null });
		expect(parseConversationAddress("dm:-100:3")).toEqual({ chatId: -100, threadId: null });
	});

	test("malformed ids are rejected, not guessed", () => {
		expect(parseConversationAddress("topic:1")).toBeNull(); // missing thread
		expect(parseConversationAddress("group:1")).toBeNull(); // unknown kind
		expect(parseConversationAddress("app/chat-01")).toBeNull(); // not a telegram door
		expect(parseConversationAddress("")).toBeNull();
	});
});

describe("outage notice send", () => {
	test("topic ids send into their thread; dm ids without one", async () => {
		type Send = { chatId: number; text: string; threadId?: number };
		const sends: Send[] = [];
		const api = {
			sendMessage: async (chatId: number, text: string, other?: { message_thread_id?: number }) => {
				sends.push({
					chatId,
					text,
					...(other?.message_thread_id !== undefined ? { threadId: other.message_thread_id } : {}),
				});
			},
		} as unknown as Api;
		await sendMemoryOutageNotice(api, "topic:-100200300:546216", 3_600_000, 2);
		await sendMemoryOutageNotice(api, "dm:42", 7_200_000, 1);
		expect(sends).toHaveLength(2);
		const [topic, dm] = sends;
		expect(topic).toMatchObject({ chatId: -100200300, threadId: 546216 });
		expect(topic?.text).toContain("unreachable");
		expect(topic?.text).toContain("2 exchanges queued");
		expect(dm).toMatchObject({ chatId: 42 });
		expect(dm?.text).toContain("1 exchange queued"); // singular
		expect(dm?.threadId).toBeUndefined();
	});

	test("an unparseable id throws — the caller's retry/logging depends on it", async () => {
		const api = {
			sendMessage: async () => {
				throw new Error("must not be called");
			},
		} as unknown as Api;
		await expect(sendMemoryOutageNotice(api, "garbage", 3_600_000, 1)).rejects.toThrow(
			/unparseable conversation id/,
		);
	});
});

describe("blocked notice send", () => {
	test("one line into the stuck exchange's thread; error capped at 120 chars", async () => {
		type Send = { chatId: number; text: string; threadId?: number };
		const sends: Send[] = [];
		const api = {
			sendMessage: async (chatId: number, text: string, other?: { message_thread_id?: number }) => {
				sends.push({
					chatId,
					text,
					...(other?.message_thread_id !== undefined ? { threadId: other.message_thread_id } : {}),
				});
			},
		} as unknown as Api;
		await sendMemoryBlockedNotice(api, "topic:-100200300:546216", "x".repeat(300), 3);
		await sendMemoryBlockedNotice(api, "dm:42", null, 1);
		expect(sends).toHaveLength(2);
		const [topic, dm] = sends;
		expect(topic).toMatchObject({ chatId: -100200300, threadId: 546216 });
		expect(topic?.text).toContain("memory retention blocked for one exchange: ");
		expect(topic?.text).toContain("— /memory retry to resend, /memory dismiss to drop");
		expect(topic?.text.split("\n")).toHaveLength(1); // one line, plain
		// 43-char prefix + 120-char error + 51-char suffix is the ceiling.
		expect(topic?.text.length).toBeLessThanOrEqual(43 + 120 + 51);
		expect(dm).toMatchObject({ chatId: 42 });
		expect(dm?.threadId).toBeUndefined();
		expect(dm?.text).toContain("unknown error"); // null error never renders as "null"
	});

	test("an unparseable id throws — the caller logs it", async () => {
		const api = {
			sendMessage: async () => {
				throw new Error("must not be called");
			},
		} as unknown as Api;
		await expect(sendMemoryBlockedNotice(api, "garbage", "err", 1)).rejects.toThrow(
			/unparseable conversation id/,
		);
	});
});

describe("skill proposal notice send", () => {
	type Send = {
		chatId: number;
		text: string;
		threadId?: number;
		keyboard?: Array<Array<{ text: string; callback_data: string }>>;
	};
	function noticeApi() {
		const sends: Send[] = [];
		const api = {
			sendMessage: async (
				chatId: number,
				text: string,
				other?: {
					message_thread_id?: number;
					reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
				},
			) => {
				sends.push({
					chatId,
					text,
					...(other?.message_thread_id !== undefined ? { threadId: other.message_thread_id } : {}),
					...(other?.reply_markup !== undefined
						? { keyboard: other.reply_markup.inline_keyboard }
						: {}),
				});
			},
		} as unknown as Api;
		return { api, sends };
	}

	test("one message per skill, each with the install/discard row", async () => {
		const { api, sends } = noticeApi();
		const proposedDir = tmpDir("notify-proposed-");
		for (const name of ["pdf-tables", "a", "b"]) {
			mkdirSync(join(proposedDir, name), { recursive: true });
			writeFileSync(join(proposedDir, name, "SKILL.md"), `# ${name}\n`);
		}
		await sendSkillProposedNotice(api, "topic:-100200300:546216", ["pdf-tables"], proposedDir);
		await sendSkillProposedNotice(api, "dm:42", ["a", "b"], proposedDir);
		expect(sends).toHaveLength(3);
		expect(sends[0]).toMatchObject({ chatId: -100200300, threadId: 546216 });
		expect(sends[0]?.text).toBe("proposed skill: pdf-tables — approve to install");
		const fp = proposalFingerprint(proposedDir, "pdf-tables");
		expect(fp).not.toBeNull();
		expect(sends[0]?.keyboard).toEqual([
			[
				{
					text: "✅ Install",
					callback_data: `skill:install:topic:-100200300:546216:pdf-tables#${fp}`,
				},
				{
					text: "🚫 Discard",
					callback_data: `skill:discard:topic:-100200300:546216:pdf-tables#${fp}`,
				},
			],
		]);
		expect(sends[1]?.text).toBe("proposed skill: a — approve to install");
		expect(sends[2]?.text).toBe("proposed skill: b — approve to install");
	});

	test("one failing skill does not abort the rest of the batch", async () => {
		const sends: string[] = [];
		const api = {
			sendMessage: async (_chatId: number, text: string) => {
				if (text.includes("skill: bad")) throw new Error("chat blocked");
				sends.push(text);
			},
		} as unknown as Api;
		await expect(
			sendSkillProposedNotice(api, "dm:42", ["good-a", "bad", "good-b"]),
		).rejects.toThrow("skill proposal notice delivery failed for 1 skill(s)");
		expect(sends).toEqual([
			"proposed skill: good-a — approve to install",
			"proposed skill: good-b — approve to install",
		]);
	});

	test("fingerprint errors are aggregated without aborting later skills", async () => {
		const { api, sends } = noticeApi();
		const proposedDir = tmpDir("notify-fingerprint-");
		writeFileSync(join(proposedDir, "not-a-directory"), "x");
		mkdirSync(join(proposedDir, "good"));
		writeFileSync(join(proposedDir, "good", "SKILL.md"), "# good");
		try {
			await sendSkillProposedNotice(api, "dm:42", ["not-a-directory/child", "good"], proposedDir);
			throw new Error("expected failure");
		} catch (err) {
			expect(err).toBeInstanceOf(AggregateError);
			const errors = (err as AggregateError).errors as Error[];
			expect(errors).toHaveLength(1);
			expect(errors[0]?.message).toContain("not-a-directory/child");
			expect((errors[0]?.cause as NodeJS.ErrnoException).code).toBe("ENOTDIR");
		}
		expect(sends).toHaveLength(1);
		expect(sends[0]?.text).toContain("skill: good");
		expect(sends[0]?.keyboard).toBeDefined();
	});

	test("multiple delivery failures are aggregated after every skill is attempted", async () => {
		const attempted: string[] = [];
		const api = {
			sendMessage: async (_chat: number, text: string) => {
				attempted.push(text);
				throw new Error(text);
			},
		} as unknown as Api;
		try {
			await sendSkillProposedNotice(api, "dm:42", ["a", "b"]);
			throw new Error("expected failure");
		} catch (err) {
			expect(err).toBeInstanceOf(AggregateError);
			const errors = (err as AggregateError).errors as Error[];
			expect(errors.map((e) => e.message)).toEqual([
				"skill proposal notice failed for a",
				"skill proposal notice failed for b",
			]);
			expect(errors.every((e) => e.cause instanceof Error)).toBe(true);
		}
		expect(attempted).toHaveLength(2);
	});

	test("callback data over 64 bytes degrades to the conversational notice", async () => {
		const { api, sends } = noticeApi();
		const long = "a".repeat(64); // spec-legal name, worst case
		const proposedDir = tmpDir("notify-proposed-");
		mkdirSync(join(proposedDir, long), { recursive: true });
		writeFileSync(join(proposedDir, long, "SKILL.md"), "# long\n");
		await sendSkillProposedNotice(api, "dm:42", [long], proposedDir);
		expect(sends).toHaveLength(1);
		expect(sends[0]?.text).toBe(`proposed skill: ${long} — approve to install`);
		expect(sends[0]?.keyboard).toBeUndefined();
	});

	test("no fingerprintable proposal on disk degrades to the conversational notice", async () => {
		const { api, sends } = noticeApi();
		const proposedDir = tmpDir("notify-proposed-");
		await sendSkillProposedNotice(api, "dm:42", ["ghost"], proposedDir);
		expect(sends).toHaveLength(1);
		expect(sends[0]?.text).toBe("proposed skill: ghost — approve to install");
		expect(sends[0]?.keyboard).toBeUndefined();
	});
});

describe("roll marker", () => {
	test("a timeout resolves without resending, logged at error as may-land-late with the marker text", async () => {
		const lines: Array<Record<string, unknown>> = [];
		setLogFile("/tmp/goblin-notify-test.log");
		setLogWriter((_path, line) => {
			lines.push(JSON.parse(line) as Record<string, unknown>);
		});
		let calls = 0;
		const api = {
			sendMessage: async () => {
				calls++;
				throw new TelegramTimeoutError("sendMessage (roll marker)", 30_000);
			},
		} as unknown as Api;
		try {
			await expect(sendRollMarker(api, 42, "dm:42:2")).resolves.toBeUndefined();
		} finally {
			setLogFile(null);
			setLogWriter(null);
		}
		expect(calls).toBe(1); // abandoned send is never resent
		const line = lines.find((l) => String(l.msg).includes("roll marker"));
		expect(line).toBeDefined();
		expect(line!.level).toBe("error");
		expect(String(line!.msg)).toContain("may land late");
		expect(line!.marker).toBe("— new conversation —");
	});
});

describe("disabled telegram notices", () => {
	test("telegram ids skip cleanly when no api exists", async () => {
		await sendMemoryOutageNotice(null, "dm:42", 3_600_000, 1);
		await sendMemoryBlockedNotice(null, "topic:-100:7", "err", 2);
		await sendSkillProposedNotice(null, "dm:42", ["x"]);
	});
});

describe("app conversation notices", () => {
	// App conversations ring nothing — no push channel exists. Every
	// notice is a deliberate skip, not a parse failure: the api is never
	// touched and nothing throws for the caller's retry loop.
	test("all three notices skip app ids without sending", async () => {
		let calls = 0;
		const api = {
			sendMessage: async () => {
				calls++;
				throw new Error("must not be called");
			},
		} as unknown as Api;
		await sendMemoryOutageNotice(api, "app/chat-01", 3_600_000, 2);
		await sendMemoryBlockedNotice(api, "app/chat-01", "err", 1);
		await sendSkillProposedNotice(api, "app/chat-01", ["x"]);
		expect(calls).toBe(0);
	});
});

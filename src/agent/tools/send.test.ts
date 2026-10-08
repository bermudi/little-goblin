import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTools } from "./mod.ts";
import { sendFileInputSchema, sendFileTool, DeliveryUncertainError } from "./send.ts";
import type { OutgoingFile } from "./send.ts";

const dirs: string[] = [];
const opts = { toolCallId: "t1", messages: [], context: {} };

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs.length = 0;
});

function workdir(): string {
	const dir = mkdtempSync(join(tmpdir(), "goblin-send-"));
	dirs.push(dir);
	return dir;
}

describe("send_file", () => {
	test("is absent without file delivery wired", () => {
		expect(makeTools({ cwd: "/tmp" }).send_file).toBeUndefined();
	});

	test("sends a real file and reports its name and size", async () => {
		const dir = workdir();
		writeFileSync(join(dir, "report.pdf"), "pdf-bytes");
		const delivered: OutgoingFile[] = [];
		const t = sendFileTool(dir, async (f) => {
			delivered.push(f);
		});
		const out = await t.execute!({ path: "report.pdf", caption: "here you go" }, opts);
		expect(delivered).toEqual([
			{ path: join(dir, "report.pdf"), filename: "report.pdf", caption: "here you go" },
		]);
		expect(out).toEqual({ sent: "report.pdf", bytes: 9 });
	});

	test("as_file passes through to the delivery sink", async () => {
		const dir = workdir();
		writeFileSync(join(dir, "shot.png"), "not-real-png-bytes");
		const delivered: OutgoingFile[] = [];
		const t = sendFileTool(dir, async (f) => {
			delivered.push(f);
		});
		await t.execute!({ path: "shot.png", as_file: true }, opts);
		expect(delivered[0]?.asFile).toBe(true);
		// Absent by default — the document decision stays delivery's.
		await t.execute!({ path: "shot.png" }, opts);
		expect("asFile" in delivered[1]!).toBe(false);
	});

	test("a missing file is an error result, not a throw", async () => {
		const t = sendFileTool(workdir(), async () => {});
		const out = (await t.execute!({ path: "nope.txt" }, opts)) as { error?: string };
		expect(out.error).toContain("file not found");
	});

	test("a timed-out send reads as delivery uncertain, never as a plain failure", async () => {
		const dir = workdir();
		writeFileSync(join(dir, "report.pdf"), "pdf-bytes");
		const t = sendFileTool(dir, async () => {
			// What the delivery sink raises when Telegram abandons the send.
			throw new DeliveryUncertainError(new Error("sendDocument timed out after 30000ms"));
		});
		const out = (await t.execute!({ path: "report.pdf" }, opts)) as { error?: string };
		// "send failed" invites a resend of content that may have arrived.
		expect(out.error).toContain("delivery uncertain");
		expect(out.error).not.toContain("send failed");
	});

	test("directories and empty files are refused", async () => {
		const dir = workdir();
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "empty.txt"), "");
		const t = sendFileTool(dir, async () => {});
		expect(((await t.execute!({ path: "sub" }, opts)) as { error?: string }).error).toContain(
			"is a directory",
		);
		expect(((await t.execute!({ path: "empty.txt" }, opts)) as { error?: string }).error).toContain(
			"is empty",
		);
	});

	test("a failed delivery surfaces as an error result", async () => {
		const dir = workdir();
		writeFileSync(join(dir, "a.txt"), "data");
		const t = sendFileTool(dir, async () => {
			throw new Error("telegram wedged");
		});
		const out = (await t.execute!({ path: "a.txt" }, opts)) as { error?: string };
		expect(out.error).toContain("telegram wedged");
	});
});

describe("send_file input rule", () => {
	test("caption is optional and capped at 1024 chars", () => {
		expect(sendFileInputSchema.safeParse({ path: "a.txt" }).success).toBe(true);
		expect(sendFileInputSchema.safeParse({ path: "a.txt", caption: "hi" }).success).toBe(true);
		expect(
			sendFileInputSchema.safeParse({ path: "a.txt", caption: "x".repeat(1025) }).success,
		).toBe(false);
		expect(sendFileInputSchema.safeParse({}).success).toBe(false);
	});
});

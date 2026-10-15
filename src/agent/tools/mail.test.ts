// The mail tool's contract: send-only. It hands the draft to the
// approval gate — it never sends, queues, reads, or touches Telegram
// itself. Reads left for the goblin-mail wrapper + gws skill (bash):
// the description points the model there, and the wire schema admits
// only the send action.

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { type MailDraftInput, type MailToolDeps, mailInputSchema, mailTool } from "./mail.ts";

// The gate's request closure is a passthrough unless a test overrides
// it — send-path behavior lives in the gate's tests.
function toolFor(requestDraft?: MailToolDeps["requestDraft"]) {
	return mailTool({
		requestDraft:
			requestDraft ?? (async () => ({ queued: 1, status: "awaiting operator approval" })),
	});
}

const exec = (t: ReturnType<typeof mailTool>, input: unknown) =>
	// biome-ignore lint: the tool's execute is the boundary under test
	(t as unknown as { execute: (i: unknown) => Promise<unknown> }).execute(input);

describe("mail tool", () => {
	test("provider sees an object schema admitting only the send action", () => {
		const wire = z.toJSONSchema(mailInputSchema);
		expect(wire.type).toBe("object");
		expect(wire.properties?.action).toEqual({ type: "string", const: "send" });
		expect(wire.required).toContain("action");
	});

	test.each([
		["requires an action", {}, false],
		["send requires a recipient", { action: "send", body: "hello" }, false],
		["send accepts recipient and body", { action: "send", to: ["a@x.com"], body: "hello" }, true],
		["does not expose search", { action: "search", q: "in:inbox" }, false],
		["does not expose read", { action: "read", id: "m1" }, false],
	] as const)("input schema %s", (_name, input, accepted) => {
		expect(mailInputSchema.safeParse(input).success).toBe(accepted);
	});

	// Header injection is closed at the schema, not by encodeSubject's
	// accidental encoded-word branch — raw text must never reach the
	// approval draft or the wire (#103).
	test.each([
		["CRLF injection", "hi\r\nBcc: x@evil.com", false],
		["CR injection", "hi\rBcc: x@evil.com", false],
		["LF injection", "hi\nBcc: x@evil.com", false],
		["plain text", "hi", true],
		["non-ASCII text", "Hellóz ☕", true],
	] as const)("subject boundary: %s", (_name, subject, accepted) => {
		// Legal plain and Unicode subjects remain valid.
		expect(
			mailInputSchema.safeParse({ action: "send", to: ["a@x.com"], body: "hello", subject })
				.success,
		).toBe(accepted);
	});

	test("the description routes reads to the goblin-mail wrapper", () => {
		const t = toolFor();
		const desc = (t as unknown as { description: string }).description;
		expect(desc).toContain("goblin-mail");
		expect(desc).toContain("gws skill");
	});

	test("send hands the draft to the gate and relays the verdict", async () => {
		const asked: MailDraftInput[] = [];
		const t = toolFor(async (input) => {
			asked.push(input);
			return {
				queued: 7,
				status: "awaiting operator approval — the draft is in Telegram with Send/Cancel buttons",
			};
		});
		const out = (await exec(t, {
			action: "send",
			to: ["a@x.com"],
			cc: ["b@y.com"],
			subject: "hi",
			body: "hello",
			replyToId: "m9",
		})) as { queued: number; status: string };
		// The verdict is the gate's, relayed verbatim — the model reads
		// the same words the operator's tap will answer.
		expect(out.queued).toBe(7);
		expect(out.status).toContain("awaiting operator approval");
		expect(asked[0]).toEqual({
			to: ["a@x.com"],
			cc: ["b@y.com"],
			subject: "hi",
			body: "hello",
			replyToId: "m9",
		});
	});

	test("an omitted subject queues as empty; a gate error verdict passes through", async () => {
		const asked: unknown[] = [];
		const t = toolFor(async (input) => {
			asked.push(input);
			return {
				error:
					"posting the draft to Telegram failed — the draft was cancelled; retry the send when delivery recovers",
			};
		});
		const out = (await exec(t, { action: "send", to: ["a@x.com"], body: "hello" })) as {
			error: string;
		};
		expect(out.error).toContain("posting the draft to Telegram failed");
		expect(asked[0]).toEqual({ to: ["a@x.com"], subject: "", body: "hello" });
	});

	test("a non-send action fails validation, never the gate", async () => {
		let called = false;
		const t = toolFor(async () => {
			called = true;
			return { queued: 1, status: "x" };
		});
		await expect(exec(t, { action: "search", q: "x" })).rejects.toThrow();
		expect(called).toBe(false);
	});
});

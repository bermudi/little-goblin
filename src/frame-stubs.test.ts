// The between-turn screenshot sweep: old frame descriptors become
// deterministic text stubs through event projections — the model view
// overlays the marker while stored events keep the descriptor.

import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Message } from "./message.ts";
import { openStore } from "./conversation.ts";
import { COMPUTER_AGENT_TYPE } from "./agent-types.ts";
import { sweepScreenshotFrames } from "./frame-stubs.ts";
import { tmpDb } from "./testkit.ts";

const userMsg = (text: string): Message => ({
	id: randomUUID(),
	role: "user",
	parts: [{ type: "text", text }],
});

const shotMsg = (toolCallId: string, descriptor: string): Message =>
	({
		id: `a-${toolCallId}`,
		role: "assistant",
		parts: [
			{
				type: "tool-screenshot",
				toolCallId,
				state: "output-available",
				input: {},
				output: descriptor,
			},
		],
	}) as unknown as Message;

const descriptor = (obs: string) =>
	JSON.stringify({ v: 1, observation_id: obs, path: `/shots/${obs}.png`, bytes: 1234 });

const shotOutput = (message: Message | undefined): unknown =>
	(message?.parts[0] as { output?: unknown } | undefined)?.output;

function fixture() {
	const dbPath = tmpDb("goblin-frames-");
	const store = openStore(dbPath);
	const parent = store.resolve({ kind: "dm", chatId: 1 }, "/w");
	const child = store.resolveAgentChild(
		parent,
		COMPUTER_AGENT_TYPE.name,
		{ model: "openrouter/minimax/minimax-m3.1-flash", thinking: "off" } as never,
		new Date().toISOString(),
	);
	return { store, parent, child, dbPath };
}

describe("sweepScreenshotFrames", () => {
	test("a non-computer conversation is skipped without scanning", () => {
		const { store, parent } = fixture();
		store.append(parent.id, [shotMsg("c1", descriptor("o1")), shotMsg("c2", descriptor("o2"))]);
		expect(sweepScreenshotFrames(store, parent.id)).toBe(0);
		expect(store.eventProjections(parent.id)).toEqual([]);
		store.close();
	});

	test("old frames stub to text; the newest stays live; originals survive", () => {
		const { store, child } = fixture();
		store.append(child.id, [userMsg("drive the desktop")]);
		store.append(child.id, [shotMsg("s1", descriptor("obs-1"))]);
		store.append(child.id, [shotMsg("s2", descriptor("obs-2"))]);
		store.append(child.id, [shotMsg("s3", descriptor("obs-3"))]);
		expect(sweepScreenshotFrames(store, child.id)).toBe(2);
		const projections = store.eventProjections(child.id);
		expect(projections).toHaveLength(2);
		const view = store.modelEntries(child.id);
		const out1 = shotOutput(view.find((e) => e.seq === 2)?.message) as string;
		const out2 = shotOutput(view.find((e) => e.seq === 3)?.message) as string;
		const out3 = shotOutput(view.find((e) => e.seq === 4)?.message) as string;
		expect(out1).toContain("pruned-frame");
		expect(out1).toContain("obs-1");
		expect(out1).toContain("history_search");
		expect(out2).toContain("pruned-frame");
		// The newest frame keeps its descriptor — still rehydratable.
		expect(out3).toBe(descriptor("obs-3"));
		// Stored events are untouched.
		const detail = store.historyDetail(child.id);
		expect(shotOutput(detail.find((e) => e.seq === 2)?.message)).toBe(descriptor("obs-1"));
		// Idempotent — a second sweep inserts nothing.
		expect(sweepScreenshotFrames(store, child.id)).toBe(0);
		store.close();
	});

	test("a single frame is never stubbed", () => {
		const { store, child } = fixture();
		store.append(child.id, [shotMsg("s1", descriptor("obs-1"))]);
		expect(sweepScreenshotFrames(store, child.id)).toBe(0);
		expect(store.eventProjections(child.id)).toEqual([]);
		store.close();
	});
});

import { expect, test } from "bun:test";
import type { Message } from "./message.ts";
import { LaneRegistry, type QueuedTurn } from "./runtime-lanes.ts";
import { RecordingSink } from "./testkit.ts";

function pendingTurn(id: string, mode: "steer" | "followUp"): QueuedTurn {
	const message: Message = {
		id,
		role: "user",
		parts: [{ type: "text", text: id }],
	};
	return {
		seq: null,
		pending: { id, mode },
		message,
		sink: new RecordingSink(),
		doneSent: false,
	};
}

function materialize(turns: QueuedTurn[]): void {
	for (const turn of turns) {
		turn.seq = turns.indexOf(turn) + 1;
		delete turn.pending;
	}
}

test("a failed claim callback restores the pending prefix to its original lane position", () => {
	const lanes = new LaneRegistry();
	const followUp = pendingTurn("follow-up", "followUp");
	const steer = pendingTurn("steer", "steer");
	for (const turn of [followUp, steer]) lanes.enqueue("app/test", turn);

	expect(() =>
		lanes.claim("app/test", true, false, () => {
			throw new Error("database transaction failed");
		}, true),
	).toThrow("database transaction failed");

	const stillFoldable = lanes.claim("app/test", true, false, materialize, true);
	expect(stillFoldable.map((turn) => turn.message.id)).toEqual(["steer"]);
	const stillQueued = lanes.claim("app/test", true);
	expect(stillQueued.map((turn) => turn.message.id)).toEqual(["follow-up"]);
});

test("fold claims steers past follow-ups; the drain keeps the follow-up next", () => {
	const lanes = new LaneRegistry();
	const followUp = pendingTurn("follow-up", "followUp");
	const steer = pendingTurn("steer", "steer");
	for (const turn of [followUp, steer]) lanes.enqueue("app/test", turn);

	expect(lanes.claimablePending("app/test", true)).toBe(true);
	const folded = lanes.claim("app/test", true, false, materialize, true);
	expect(folded.map((turn) => turn.message.id)).toEqual(["steer"]);
	expect(steer.seq).not.toBeNull();
	expect(steer.pending).toBeUndefined();
	expect(lanes.pendingSeqs("app/test")).toEqual(new Set());

	const nextTurn = lanes.claim("app/test", true, true, materialize);
	expect(nextTurn.map((turn) => turn.message.id)).toEqual(["follow-up"]);
	expect(lanes.claimablePending("app/test", true)).toBe(false);
});

test("unrequeued steers return ahead of follow-ups without changing their order", () => {
	const lanes = new LaneRegistry();
	const followUp = pendingTurn("follow-up", "followUp");
	const firstSteer = pendingTurn("first-steer", "steer");
	const secondSteer = pendingTurn("second-steer", "steer");
	for (const turn of [followUp, firstSteer, secondSteer]) lanes.enqueue("app/test", turn);

	const folded = lanes.claim("app/test", true, false, materialize, true);
	expect(folded.map((turn) => turn.message.id)).toEqual(["first-steer", "second-steer"]);
	lanes.unrequeue("app/test", folded);

	expect(lanes.claim("app/test", true, true, materialize).map((turn) => turn.message.id)).toEqual([
		"first-steer",
		"second-steer",
		"follow-up",
	]);
});

test("a failed dequeue restores a removed middle item at its original position", () => {
	const lanes = new LaneRegistry();
	const first = pendingTurn("first", "steer");
	const middle = pendingTurn("middle", "followUp");
	const last = pendingTurn("last", "steer");
	for (const turn of [first, middle, last]) lanes.enqueue("app/test", turn);

	const removed = lanes.removePending("app/test", "middle");
	expect(removed?.index).toBe(1);
	expect(() => {
		try {
			throw new Error("pending row delete failed");
		} catch (err) {
			if (removed !== null) lanes.restorePending("app/test", removed.turn, removed.index);
			throw err;
		}
	}).toThrow("pending row delete failed");

	expect(lanes.claim("app/test", true).map((turn) => turn.message.id)).toEqual([
		"first",
		"middle",
		"last",
	]);
});

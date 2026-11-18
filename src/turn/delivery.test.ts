import { describe, expect, test } from "bun:test";
import type { OutgoingFile } from "../agent/tools/send.ts";
import type { TurnSink } from "./sink.ts";
import { sinkDelivery } from "./delivery.ts";

describe("sink delivery authority", () => {
	test("an epoch advance during a held sink action fences completion and later actions", async () => {
		let epoch = 0;
		let entered!: () => void;
		let release!: () => void;
		const actionEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const actions: string[] = [];
		const sink: TurnSink = {
			delivery: "headless",
			onTextDelta: () => {},
			onReasoningDelta: () => {},
			onToolCall: () => {},
			onDone: () => {},
			onVoiceNote: async () => {
				actions.push("voice");
				entered();
				await gate;
			},
			onFile: async (file: OutgoingFile) => {
				actions.push(file.filename);
			},
		};
		const authority = () => {
			if (epoch !== 0) throw new Error("turn fenced by conversation epoch");
		};
		const delivery = sinkDelivery(sink, authority);
		const voice = delivery.deliverVoice!(new Uint8Array([1]));
		try {
			await actionEntered;
			epoch++;
			release();
			await expect(voice).rejects.toThrow("turn fenced by conversation epoch");
			await expect(delivery.deliverFile!({ path: "/tmp/a", filename: "a.txt" })).rejects.toThrow(
				"turn fenced by conversation epoch",
			);
			expect(actions).toEqual(["voice"]);
		} finally {
			release();
		}
	});
});

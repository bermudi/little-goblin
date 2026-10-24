import { describe, expect, test } from "bun:test";
import type { TurnDone } from "../runtime.ts";
import { appStreamSink } from "./app-sse.ts";

describe("app stream sink", () => {
	test("a live stream finishing normally does not invoke the disconnected callback", async () => {
		const called: TurnDone[] = [];
		const stream = appStreamSink("app/live", undefined, async (done) => {
			called.push(done);
		});
		await stream.sink.onDone({ kind: "completed" });
		expect(called).toEqual([]);
		stream.dispose();
	});

	test("a client-cancelled stream marks the terminal callback as disconnected", async () => {
		const called: TurnDone[] = [];
		const stream = appStreamSink("app/closed", undefined, async (done) => {
			called.push(done);
		});
		const reader = stream.body.getReader();
		await reader.cancel();
		reader.releaseLock();

		const done: TurnDone = { kind: "completed" };
		await stream.sink.onDone(done);

		expect(called).toEqual([done]);
	});
});

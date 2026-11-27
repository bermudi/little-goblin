import { describe, expect, test } from "bun:test";
import { INSERTS_PART, storedTurnInserts } from "./turn-inserts.ts";

describe("stored turn inserts", () => {
	test("reads valid insert records", () => {
		const result = storedTurnInserts(
			[{
				message: ({
					id: "a1",
					role: "assistant",
					parts: [{
						type: INSERTS_PART,
						data: { inserts: [{ step: 2, items: [{ kind: "text", text: "[context: 1k]" }] }] },
					}],
				} as never),
			}],
			"conv-1",
		);
		expect(result[0]?.inserts).toEqual([
			{ step: 2, items: [{ kind: "text", text: "[context: 1k]" }] },
		]);
	});

	test("malformed insert records identify the conversation and message", () => {
		expect(() => storedTurnInserts(
			[{
				message: ({
					id: "a1",
					role: "assistant",
					parts: [{ type: INSERTS_PART, data: { inserts: [{ step: -1, items: [] }] } }],
				} as never),
			}],
			"conv-1",
		)).toThrow("malformed data-inserts part in conversation conv-1, message a1");
	});
});

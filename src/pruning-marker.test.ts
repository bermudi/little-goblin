import { describe, expect, test } from "bun:test";
import { pruningReplacement } from "./cache-pruning.ts";
import { pruningRecoveryAddress, retargetPruningMarker } from "./pruning-marker.ts";

describe("retargetPruningMarker", () => {
	const marker = pruningReplacement({
		conversation: "dm/5/3",
		seq: 42,
		toolCallId: "call-1",
		text: "x".repeat(500),
		headChars: 50,
		tailChars: 50,
	});

	test("re-points the embedded recovery address at the fork's id", () => {
		const retargeted = retargetPruningMarker(marker, 42, "call-1", "dm/5/3", "app/spun-1");
		expect(retargeted).toContain(pruningRecoveryAddress("app/spun-1", 42, "call-1"));
		expect(retargeted).not.toContain('"dm/5/3"');
		// Head, tail, and framing ride along byte-identically.
		expect(retargeted.replace("app/spun-1", "dm/5/3")).toBe(marker);
	});

	test("a marker without the exact address is left alone", () => {
		const foreign = "<pruned-observation>marker</pruned-observation>";
		expect(retargetPruningMarker(foreign, 42, "call-1", "dm/5/3", "app/spun-1")).toBe(foreign);
		// A different call's address on the same conversation is not a hit.
		expect(retargetPruningMarker(marker, 7, "call-1", "dm/5/3", "app/spun-1")).toBe(marker);
	});
});

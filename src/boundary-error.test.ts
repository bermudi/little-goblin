import { describe, expect, test } from "bun:test";
import { BoundaryError, boundaryKind } from "./boundary-error.ts";

describe("boundaryKind", () => {
	test("returns the kind of a boundary error", () => {
		expect(boundaryKind(new BoundaryError("x", "transient", "down"))).toBe("transient");
	});

	test("returns null for an ordinary error", () => {
		expect(boundaryKind(new Error("ordinary"))).toBeNull();
	});
});

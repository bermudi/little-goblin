import { beforeEach, describe, expect, test } from "bun:test";
import { after } from "../../timing.ts";

beforeEach((done) => done());

test("a calm test passes", () => {
	expect("calm").toBe("calm");
});

describe("table", () => {
	test.each([1, 2] as const)("value %s stays positive", (value) => {
		expect(value).toBeGreaterThan(0);
	});
});

test("done style", (done) => {
	after(10, "calm fixture done callback", done);
});

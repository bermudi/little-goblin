import { beforeEach, describe, expect, test } from "bun:test";

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
	setTimeout(done, 10);
});

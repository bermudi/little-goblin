import { expect, test } from "bun:test";
import { isTest, tally } from "./test-ratio";

test("test-support modules count as tests, live checks too", () => {
	expect(["src/a.test.ts", "src/testkit.ts", "src/x/testing.ts", "src/http/app-testing.ts", "src/herdr.live.test.ts", "src/test-helpers/boot.ts"].every(isTest)).toBe(true);
	expect(isTest("src/latest.ts")).toBe(false);
});

test("tally splits per directory", () => {
	const m = tally([{ path: "src/a/x.ts", lines: 10 }, { path: "src/a/x.test.ts", lines: 25 }]);
	expect(m.get("src/a")).toEqual({ prod: 10, test: 25 });
});

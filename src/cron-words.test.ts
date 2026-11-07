import { expect, test } from "bun:test";
import { cronWords } from "./cron-words.ts";

test("common shapes read as plain words", () => {
	expect(cronWords("0 7 * * *")).toBe("Daily 07:00");
	expect(cronWords("30 6 * * 1-5")).toBe("Weekdays 06:30");
	expect(cronWords("0 9 * * 0,6")).toBe("Weekends 09:00");
	expect(cronWords("0 9 * * 1")).toBe("Mondays 09:00");
	expect(cronWords("0 9 * * 1,3")).toBe("Monday, Wednesday 09:00");
	expect(cronWords("15 8 1 * *")).toBe("Monthly on day 1, 08:15");
	expect(cronWords("*/15 * * * *")).toBe("Every 15 minutes");
	expect(cronWords("0 * * * *")).toBe("Hourly");
	expect(cronWords("0 */6 * * *")).toBe("Every 6 hours");
});

test("shapes it does not cover return null so the caller shows the raw cron", () => {
	expect(cronWords("0 9 * 6 *")).toBeNull();
	expect(cronWords("0 9 1 * 1")).toBeNull();
	expect(cronWords("0 25 * * *")).toBeNull();
	expect(cronWords("0 9 * * 1-3")).toBeNull();
	expect(cronWords("nonsense")).toBeNull();
});

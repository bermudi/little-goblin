import { describe, expect, test } from "bun:test";
import { sanitizeTitle } from "./title.ts";

describe("sanitizeTitle", () => {
	test("strips decoration the model was told not to add", () => {
		expect(sanitizeTitle('"Math questions"\nmore text here')).toBe("Math questions");
		expect(sanitizeTitle("## Project planning.")).toBe("Project planning");
		expect(sanitizeTitle("**Deploy  checklist**")).toBe("Deploy checklist");
	});

	test("returns null when nothing usable remains", () => {
		expect(sanitizeTitle("")).toBeNull();
		expect(sanitizeTitle("   \n  ")).toBeNull();
		expect(sanitizeTitle('""')).toBeNull();
	});

	test("caps at the Telegram topic-name limit", () => {
		const long = `x`.repeat(200);
		expect(sanitizeTitle(long)).toHaveLength(128);
	});
});

import { describe, expect, test } from "bun:test";
import { liveThoughtLine } from "./liveThoughtLine.ts";

describe("live thought preview", () => {
  test("chooses a bold heading or first sentence and removes markdown", () => {
    expect(liveThoughtLine("**Inspecting the log**\n\nLong text. Next.")).toBe("Inspecting the log");
    expect(liveThoughtLine("First *sentence* with `code`. Next sentence.")).toBe("First sentence with code.");
    expect(liveThoughtLine("**Insp")).toBe("Insp");
    expect(liveThoughtLine("")).toBe("");
  });
});

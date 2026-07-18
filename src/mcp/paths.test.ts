import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveMcporterConfigPath } from "./paths.ts";

describe("resolveMcporterConfigPath", () => {
  const goblinHome = "/tmp/goblin";

  it("returns undefined when input is undefined", () => {
    expect(resolveMcporterConfigPath(undefined, goblinHome)).toBeUndefined();
  });

  it("expands a leading tilde to the home directory", () => {
    const input = "~/.mcporter/mcporter.json";
    const expected = join(homedir(), ".mcporter", "mcporter.json");
    expect(resolveMcporterConfigPath(input, goblinHome)).toBe(expected);
  });

  it("resolves relative paths against goblinHome", () => {
    expect(resolveMcporterConfigPath("mcporter.json", goblinHome)).toBe(
      join(goblinHome, "mcporter.json"),
    );
  });

  it("leaves absolute paths unchanged", () => {
    expect(resolveMcporterConfigPath("/etc/mcporter.json", goblinHome)).toBe("/etc/mcporter.json");
  });
});

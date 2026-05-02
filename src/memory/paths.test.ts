import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { archiveTopicPath, memoryDir, scopeMemoryPath, userPath } from "./paths.ts";

describe("memory paths", () => {
  const home = "/tmp/goblin";

  it("resolves the memory root", () => {
    expect(memoryDir(home)).toBe(join(home, "memory"));
  });

  it("resolves user.md globally", () => {
    expect(userPath(home)).toBe(join(home, "memory", "user.md"));
  });

  it("resolves the general scope", () => {
    expect(scopeMemoryPath(home, "general")).toBe(
      join(home, "memory", "general", "memory.md"),
    );
  });

  it("resolves topic scopes by chat id and topic id", () => {
    expect(scopeMemoryPath(home, { topic: { chatId: -100123, topicId: 42 } })).toBe(
      join(home, "memory", "topics", "-100123", "42", "memory.md"),
    );
  });

  it("resolves named-agent persona scopes", () => {
    expect(scopeMemoryPath(home, { agent: { name: "researcher" } })).toBe(
      join(home, "memory", "agents", "researcher", "memory.md"),
    );
  });

  it("mirrors topic scopes under archive", () => {
    expect(archiveTopicPath(home, -100123, 42)).toBe(
      join(home, "memory", "archive", "topics", "-100123", "42"),
    );
  });
});

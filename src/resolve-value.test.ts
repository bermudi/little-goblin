import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveConfigValue, clearResolveCache } from "./resolve-value.ts";

describe("resolveConfigValue", () => {
  beforeEach(() => {
    clearResolveCache();
  });

  afterEach(() => {
    clearResolveCache();
    delete process.env.TEST_VALUE;
    delete process.env.TEST_VAR_NAME;
  });

  it("returns literal value when no special prefix", () => {
    expect(resolveConfigValue("hello")).toBe("hello");
    expect(resolveConfigValue("some literal text")).toBe("some literal text");
  });

  it("returns env var value when string matches env var name", () => {
    process.env.TEST_VALUE = "secret123";
    expect(resolveConfigValue("TEST_VALUE")).toBe("secret123");
  });

  it("prefers env var over literal when name matches", () => {
    process.env.HELLO = "from env";
    // HELLO matches the env var name, so it resolves to env value
    expect(resolveConfigValue("HELLO")).toBe("from env");
    delete process.env.HELLO;
  });

  it("executes shell command with ! prefix", () => {
    const result = resolveConfigValue("!echo hello from shell");
    expect(result).toBe("hello from shell");
  });

  it("caches command output", () => {
    // First call
    const r1 = resolveConfigValue("!echo cached");
    expect(r1).toBe("cached");

    // Second call should return cached value without re-executing
    const r2 = resolveConfigValue("!echo cached");
    expect(r2).toBe("cached");
  });

  it("returns undefined for failed commands", () => {
    const result = resolveConfigValue("!false"); // false returns exit 1
    expect(result).toBeUndefined();
  });

  it("returns undefined for command that doesn't exist", () => {
    const result = resolveConfigValue("!nonexistent_command_xyz");
    expect(result).toBeUndefined();
  });

  it("handles empty string as literal", () => {
    expect(resolveConfigValue("")).toBe("");
  });

  it("handles ! with only whitespace as failed command", () => {
    expect(resolveConfigValue("!   ")).toBeUndefined();
  });

  it("differentiates env var from literal with same name", () => {
    // When env var exists
    process.env.TEST_VAR_NAME = "env_value";
    expect(resolveConfigValue("TEST_VAR_NAME")).toBe("env_value");

    // When env var doesn't exist, treat as literal
    delete process.env.TEST_VAR_NAME;
    expect(resolveConfigValue("TEST_VAR_NAME")).toBe("TEST_VAR_NAME");
  });
});

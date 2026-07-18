import { afterEach, describe, expect, it } from "bun:test";
import { prepareMcpEnv } from "./env.ts";

describe("prepareMcpEnv", () => {
  const keys = [
    "XDG_CONFIG_HOME",
    "OPENAI_API_KEY",
    "SSH_AUTH_SOCK",
    "BUN_FAKE_TEST_KEY",
    "NODE_FAKE_TEST_KEY",
    "MCP_FAKE_TEST_KEY",
  ];

  afterEach(() => {
    for (const key of keys) {
      delete process.env[key];
    }
  });

  it("passes through the safe base environment variables", () => {
    process.env.XDG_CONFIG_HOME = "/tmp/xdg/config";
    const env = prepareMcpEnv("/tmp/goblin");
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.GOBLIN_HOME).toBe("/tmp/goblin");
    expect(env.XDG_CONFIG_HOME).toBe("/tmp/xdg/config");
  });

  it("excludes API keys, SSH agent socket, and broad runtime prefixes", () => {
    process.env.OPENAI_API_KEY = "secret";
    process.env.SSH_AUTH_SOCK = "/run/ssh/agent";
    process.env.BUN_FAKE_TEST_KEY = "value";
    process.env.NODE_FAKE_TEST_KEY = "value";
    process.env.MCP_FAKE_TEST_KEY = "value";
    const env = prepareMcpEnv("/tmp/goblin");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.BUN_FAKE_TEST_KEY).toBeUndefined();
    expect(env.NODE_FAKE_TEST_KEY).toBeUndefined();
    expect(env.MCP_FAKE_TEST_KEY).toBeUndefined();
  });
});

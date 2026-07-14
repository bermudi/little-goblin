import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { prepareEnv } from "./env.ts";

const ORIGINAL_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "DEVIN_API_KEY",
  "BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "GOBLIN_HOME",
  "HOME",
  "PATH",
  "USER",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_PAPER",
  "LC_SECRET",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "TMPDIR",
  "TERM",
  "COLORTERM",
  "SSH_AUTH_SOCK",
  "SSL_CERT_FILE",
] as const;

describe("prepareEnv", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "openai-secret";
    process.env.ANTHROPIC_API_KEY = "anthropic-secret";
    process.env.CODEX_API_KEY = "codex-secret";
    process.env.DEVIN_API_KEY = "devin-secret";
    process.env.BOT_TOKEN = "tg-secret";
    process.env.TELEGRAM_BOT_TOKEN = "tg-secret-2";
    process.env.GOBLIN_HOME = "/home/goblin";
  });

  afterEach(() => {
    for (const key of ORIGINAL_KEYS) {
      delete process.env[key];
    }
  });

  it("includes only the allowlisted execution environment variables", () => {
    process.env.HOME = "/home/user";
    process.env.PATH = "/usr/bin";
    process.env.USER = "user";
    process.env.LANG = "en_US.UTF-8";
    process.env.LC_ALL = "en_US.UTF-8";
    process.env.LC_CTYPE = "en_US.UTF-8";
    process.env.LC_PAPER = "letter";
    process.env.LC_SECRET = "should-not-leak";
    process.env.XDG_CONFIG_HOME = "/home/user/.config";
    process.env.XDG_DATA_HOME = "/home/user/.local/share";
    process.env.XDG_STATE_HOME = "/home/user/.local/state";
    process.env.XDG_CACHE_HOME = "/home/user/.cache";
    process.env.TMPDIR = "/tmp";
    process.env.TERM = "xterm-256color";
    process.env.COLORTERM = "truecolor";
    process.env.SSH_AUTH_SOCK = "/run/ssh/agent";
    process.env.SSL_CERT_FILE = "/etc/ssl/cert.pem";

    const env = prepareEnv();

    expect(env.HOME).toBe("/home/user");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.USER).toBe("user");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.LC_ALL).toBe("en_US.UTF-8");
    expect(env.LC_CTYPE).toBe("en_US.UTF-8");
    expect(env.LC_PAPER).toBe("letter");
    expect(env.XDG_CONFIG_HOME).toBe("/home/user/.config");
    expect(env.SSH_AUTH_SOCK).toBe("/run/ssh/agent");
    expect(env.SSL_CERT_FILE).toBe("/etc/ssl/cert.pem");

    expect(env.LC_SECRET).toBeUndefined();
    expect(env.EXTERNAL_AGENT).toBeUndefined();
    expect(env.EXTERNAL_AGENT_BACKEND).toBeUndefined();
    expect(env.EXTERNAL_AGENT_RUN_ID).toBeUndefined();
    expect(env.EXTERNAL_AGENT_SESSION_ID).toBeUndefined();
    expect(env.EXTERNAL_AGENT_PERMISSION_PROFILE).toBeUndefined();
  });

  it("excludes provider API keys and Goblin secrets", () => {
    const env = prepareEnv();

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.DEVIN_API_KEY).toBeUndefined();
    expect(env.BOT_TOKEN).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.GOBLIN_HOME).toBeUndefined();
  });
});

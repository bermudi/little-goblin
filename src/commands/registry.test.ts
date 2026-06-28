import { describe, it, expect } from "bun:test";
import {
  COMMAND_REGISTRY,
  resolveCommand,
  CANCEL_CAPABLE_COMMANDS,
  helpReply,
  telegramBotCommands,
  syncTelegramMenu,
} from "./registry.ts";

describe("COMMAND_REGISTRY structure", () => {
  it("has no duplicate names or aliases", () => {
    const seen = new Set<string>();
    for (const def of COMMAND_REGISTRY) {
      expect(seen.has(def.name)).toBe(false);
      seen.add(def.name);
      for (const alias of def.aliases ?? []) {
        expect(seen.has(alias)).toBe(false);
        seen.add(alias);
      }
    }
  });

  it("every def has exactly one of handler or grammyHandler", () => {
    for (const def of COMMAND_REGISTRY) {
      const hasHandler = def.handler !== undefined;
      const hasGrammy = def.grammyHandler !== undefined;
      expect(hasHandler !== hasGrammy).toBe(true);
    }
  });

  it("all cancelCapable defs have a handler (not grammyHandler)", () => {
    for (const def of COMMAND_REGISTRY) {
      if (def.cancelCapable) {
        expect(def.handler).toBeDefined();
        expect(def.grammyHandler).toBeUndefined();
      }
    }
  });
});

describe("resolveCommand", () => {
  it("resolves by name with leading slash", () => {
    const def = resolveCommand("/voice");
    expect(def?.name).toBe("voice");
  });

  it("resolves by name without leading slash", () => {
    const def = resolveCommand("voice");
    expect(def?.name).toBe("voice");
  });

  it("resolves by alias", () => {
    expect(resolveCommand("/v")?.name).toBe("voice");
    expect(resolveCommand("v")?.name).toBe("voice");
  });

  it("returns null for unknown commands", () => {
    expect(resolveCommand("/unknown")).toBeNull();
    expect(resolveCommand("")).toBeNull();
  });
});

describe("CANCEL_CAPABLE_COMMANDS", () => {
  it("includes the expected cancel-capable commands", () => {
    const expected = ["/cancel", "/new", "/archive", "/project", "/model", "/debug", "/compact", "/resume", "/name", "/think"];
    for (const cmd of expected) {
      expect(CANCEL_CAPABLE_COMMANDS.has(cmd)).toBe(true);
    }
  });

  it("excludes /voice and /v", () => {
    expect(CANCEL_CAPABLE_COMMANDS.has("/voice")).toBe(false);
    expect(CANCEL_CAPABLE_COMMANDS.has("/v")).toBe(false);
  });

  it("excludes /queue", () => {
    expect(CANCEL_CAPABLE_COMMANDS.has("/queue")).toBe(false);
  });

  it("excludes non-dispatched commands", () => {
    expect(CANCEL_CAPABLE_COMMANDS.has("/ping")).toBe(false);
    expect(CANCEL_CAPABLE_COMMANDS.has("/start")).toBe(false);
    expect(CANCEL_CAPABLE_COMMANDS.has("/help")).toBe(false);
    expect(CANCEL_CAPABLE_COMMANDS.has("/subagents")).toBe(false);
    expect(CANCEL_CAPABLE_COMMANDS.has("/cancel_subagent")).toBe(false);
    expect(CANCEL_CAPABLE_COMMANDS.has("/revive")).toBe(false);
  });

  it("every entry resolves to a cancelCapable def (aliases cascade correctly)", () => {
    // If a cancel-capable def gets an alias, the alias MUST appear in
    // CANCEL_CAPABLE_COMMANDS and resolveCommand of it MUST return a
    // cancelCapable def — otherwise handleCommand would skip the cascade
    // for the alias but run it for the canonical name.
    for (const token of CANCEL_CAPABLE_COMMANDS) {
      const def = resolveCommand(token);
      expect(def).not.toBeNull();
      expect(def?.cancelCapable).toBe(true);
    }
  });
});

describe("helpReply", () => {
  const reply = helpReply();

  it("lists every spec-mandated command", () => {
    const required = [
      "/cancel",
      "/new",
      "/archive",
      "/project",
      "/model",
      "/compact",
      "/debug",
      "/think",
      "/name",
      "/resume",
      "/voice",
      "/ping",
      "/start",
      "/subagents",
      "/cancel_subagent",
      "/revive",
      "/help",
    ];
    for (const cmd of required) {
      expect(reply).toContain(cmd);
    }
  });

  it("includes /queue <text>", () => {
    expect(reply).toContain("/queue <text>");
  });

  it("includes /revive <id> <prompt>", () => {
    expect(reply).toContain("/revive <id> <prompt>");
  });

  it("does not contain 'not implemented'", () => {
    expect(reply).not.toContain("not implemented");
  });

  it("renders as a multi-line string", () => {
    expect(reply.split("\n").length).toBeGreaterThan(5);
  });
});

describe("telegramBotCommands", () => {
  const commands = telegramBotCommands();

  it("returns one entry per canonical command (no aliases)", () => {
    expect(commands.length).toBe(COMMAND_REGISTRY.length);
  });

  it("produces valid Telegram command names", () => {
    for (const cmd of commands) {
      expect(cmd.command).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      expect(cmd.command.length).toBeLessThanOrEqual(32);
    }
  });

  it("truncates descriptions to 256 chars", () => {
    for (const cmd of commands) {
      expect(cmd.description.length).toBeLessThanOrEqual(256);
    }
  });

  it("includes ping and start", () => {
    expect(commands.some((c) => c.command === "ping")).toBe(true);
    expect(commands.some((c) => c.command === "start")).toBe(true);
  });
});

describe("syncTelegramMenu", () => {
  it("calls setMyCommands with the registry-derived commands", async () => {
    let calledWith: { command: string; description: string }[] | null = null;
    const api = {
      setMyCommands: async (cmds: { command: string; description: string }[]) => {
        calledWith = cmds;
      },
    };
    const warn = () => { throw new Error("warn should not be called on success"); };
    await syncTelegramMenu(api, warn);
    expect(calledWith).not.toBeNull();
    expect(calledWith!.length).toBe(COMMAND_REGISTRY.length);
  });

  it("swallows setMyCommands failures and calls warn", async () => {
    const api = {
      setMyCommands: async () => { throw new Error("network error"); },
    };
    let warned = false;
    const warn = () => { warned = true; };
    await syncTelegramMenu(api, warn);
    expect(warned).toBe(true);
  });

  it("resolves even when setMyCommands rejects (startup continues)", async () => {
    const api = {
      setMyCommands: async () => { throw new Error("rate limited"); },
    };
    const warn = () => {};
    // If syncTelegramMenu throws, this await would reject and fail the test.
    await syncTelegramMenu(api, warn);
  });
});

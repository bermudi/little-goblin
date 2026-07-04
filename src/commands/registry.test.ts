import { describe, it, expect } from "bun:test";
import {
  COMMAND_REGISTRY,
  resolveCommand,
  resolveTiming,
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

  it("every def declares timing", () => {
    for (const def of COMMAND_REGISTRY) {
      expect(def.timing).toBeDefined();
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

describe("resolveTiming", () => {
  it("/cancel is the sole interrupt-timing command", () => {
    expect(resolveTiming(resolveCommand("/cancel"), "")).toBe("interrupt");
    // No other command interrupts.
    for (const def of COMMAND_REGISTRY) {
      if (def.name === "cancel") continue;
      // Static-timing commands: assert directly. Predicate-timing commands
      // (model, think): assert their non-interrupt cases below.
      if (typeof def.timing === "function") continue;
      expect(def.timing ?? "instant").not.toBe("interrupt");
    }
  });

  it("state-mutating commands are queue-timing", () => {
    for (const name of ["/new", "/archive", "/project", "/compact", "/resume"]) {
      expect(resolveTiming(resolveCommand(name), name)).toBe("queue");
    }
  });

  it("/model is instant with no arg, queue with an arg", () => {
    expect(resolveTiming(resolveCommand("/model"), "/model")).toBe("instant");
    expect(resolveTiming(resolveCommand("/model"), "/model@bot")).toBe("instant");
    expect(resolveTiming(resolveCommand("/model"), "/model 2")).toBe("queue");
    expect(resolveTiming(resolveCommand("/model"), "/model poe/gpt-5")).toBe("queue");
  });

  it("/think is instant with no arg, queue with an arg", () => {
    expect(resolveTiming(resolveCommand("/think"), "/think")).toBe("instant");
    expect(resolveTiming(resolveCommand("/think"), "/think high")).toBe("queue");
  });

  it("read-only commands are instant", () => {
    for (const name of ["/debug", "/name foo", "/subagents", "/help", "/queue x", "/voice", "/schedule list", "/schedule every 1h hi"]) {
      const token = name.split(" ")[0]!;
      expect(resolveTiming(resolveCommand(token), name)).toBe("instant");
    }
  });

  it("unknown commands default to instant", () => {
    expect(resolveTiming(null, "/bogus")).toBe("instant");
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
      "/schedule",
    ];
    for (const cmd of required) {
      expect(reply).toContain(cmd);
    }
  });

  it("includes /queue <text>", () => {
    expect(reply).toContain("/queue <text>");
  });

  it("includes /schedule <subcommand>", () => {
    expect(reply).toContain("/schedule <list|at|in|every|remove|pause|resume|heartbeat ...>");
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

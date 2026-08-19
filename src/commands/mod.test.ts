import { describe, expect, it } from "bun:test";
import type { Bot, Context } from "grammy";
import type { ConversationLifecycle } from "../orchestration/conversation-lifecycle.ts";
import { UpdateGate } from "../shutdown/mod.ts";
import { registerCommands } from "./mod.ts";

type RegisteredHandler = (ctx: Context) => Promise<unknown>;

function registerHarness(): {
  gate: UpdateGate;
  handlers: Map<string, RegisteredHandler>;
} {
  const handlers = new Map<string, RegisteredHandler>();
  const bot = {
    command: (name: string, handler: RegisteredHandler) => {
      handlers.set(name, handler);
    },
  } as unknown as Bot;
  const gate = new UpdateGate({
    closeCoalescer: async () => {},
    awaitBufferedTextAdmission: async () => {},
  });
  registerCommands(bot, {} as ConversationLifecycle, gate);
  return { gate, handlers };
}

function invokeAuthorized(
  gate: UpdateGate,
  handler: RegisteredHandler,
  ctx: Context,
): Promise<void> {
  return gate.runAuthorization(ctx, async () => {
    gate.commitAuthorization(ctx);
    await handler(ctx);
  });
}

function pingContext(reply: Context["reply"]): Context {
  return {
    from: { id: 1, is_bot: false, first_name: "Daniel" },
    chat: { id: 1, type: "private", first_name: "Daniel" },
    reply,
  } as unknown as Context;
}

describe("registerCommands", () => {
  it("settles Grammy command admission before blocked delivery", async () => {
    const { gate, handlers } = registerHarness();
    const handler = handlers.get("ping");
    if (handler === undefined) throw new Error("ping handler was not registered");
    let finishDelivery!: () => void;
    const delivery = new Promise<void>((resolve) => { finishDelivery = resolve; });
    const ctx = pingContext(async () => {
      await delivery;
      return {} as Awaited<ReturnType<Context["reply"]>>;
    });

    const boundary = invokeAuthorized(gate, handler, ctx);
    await gate.runtimeAdmission();

    let completed = false;
    void boundary.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);

    finishDelivery();
    await boundary;
  });

  it("keeps rejected Grammy delivery as completion failure after the decision", async () => {
    const { gate, handlers } = registerHarness();
    const handler = handlers.get("ping");
    if (handler === undefined) throw new Error("ping handler was not registered");
    const failure = new Error("Telegram unavailable");
    const ctx = pingContext(async () => { throw failure; });

    const boundary = invokeAuthorized(gate, handler, ctx);
    const observed = boundary.catch((error: unknown) => error);
    await gate.runtimeAdmission();

    expect(await observed).toBe(failure);
    const authorization = (gate as unknown as {
      authorizations: WeakMap<object, { outcome: { kind: string } }>;
    }).authorizations.get(ctx);
    expect(authorization?.outcome).toEqual({ kind: "admitted" });
  });
});

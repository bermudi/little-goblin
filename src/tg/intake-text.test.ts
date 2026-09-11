import { describe, expect, it, mock } from "bun:test";
import type { AgentRunner } from "../agent/mod.ts";
import type { WorkAuthority } from "../orchestration/conversation-runtime-host.ts";
import type { PromptContent, TurnDispatcher } from "../orchestration/dispatcher.ts";
import type { ConversationState } from "../sessions/mod.ts";
import { runtimeAdmission } from "../shutdown/mod.ts";
import { dmSurface, type Surface } from "../surface.ts";
import type { TelegramIntakeMessage } from "./intake.ts";
import {
  applySideEffects,
  createTextHandler,
  type TextIntakeDeps,
} from "./intake-text.ts";

const surface = dmSurface(1);
const conversation = { id: "conv-text-1" } as unknown as ConversationState;

function makeMessage(
  replies?: { text: string }[],
  prepare: (content: PromptContent) => PromptContent = (content) => content,
): TelegramIntakeMessage {
  return {
    surface,
    reply: async (text) => {
      replies?.push({ text });
    },
    prepare,
  };
}

function healthyRunner(): AgentRunner & { prompt: ReturnType<typeof mock> } {
  return {
    isAbortTimedOut: false,
    tryClearAbortTimeout: () => false,
    prompt: mock(async (_content: unknown, _buffer: unknown) => {}),
  } as unknown as AgentRunner & { prompt: ReturnType<typeof mock> };
}

const alwaysCurrent = { isCurrent: () => true } as unknown as WorkAuthority;
const neverCurrent = { isCurrent: () => false } as unknown as WorkAuthority;

type PromptRun = (runner: AgentRunner, authority: WorkAuthority) => Promise<void>;

describe("createTextHandler", () => {
  it("builds the handleText port handler from explicit deps", () => {
    const handleText = createTextHandler({} as unknown as TextIntakeDeps);
    expect(typeof handleText).toBe("function");
  });
});

describe("applySideEffects", () => {
  it("returns null when the command produced no side effects", async () => {
    const dispatcher = {} as unknown as TurnDispatcher;
    expect(await applySideEffects(dispatcher, [], makeMessage())).toBeNull();
  });

  it("admits a runner-created effect through admitGetOrCreateRunner", async () => {
    const runner = healthyRunner();
    const admitGetOrCreateRunner = mock(
      (_conversation: ConversationState, _surface: Surface) =>
        runtimeAdmission.handoff<AgentRunner>(Promise.resolve(runner)),
    );
    const dispatcher = { admitGetOrCreateRunner } as unknown as TurnDispatcher;

    const admission = await applySideEffects(
      dispatcher,
      [{ kind: "runner-created", conversation, surface }],
      makeMessage(),
    );

    expect(admission?.kind).toBe("handoff");
    await admission!.completion;
    expect(admitGetOrCreateRunner).toHaveBeenCalledTimes(1);
    expect(admitGetOrCreateRunner).toHaveBeenCalledWith(conversation, surface);
  });

  it("admits a runner-disposed effect through admitDisposeRunner", async () => {
    const admitDisposeRunner = mock(
      (_conversationId: string) => runtimeAdmission.handoff(Promise.resolve()),
    );
    const dispatcher = { admitDisposeRunner } as unknown as TurnDispatcher;

    const admission = await applySideEffects(
      dispatcher,
      [{ kind: "runner-disposed", conversationId: "conv-text-1" }],
      makeMessage(),
    );

    expect(admission?.kind).toBe("handoff");
    await admission!.completion;
    expect(admitDisposeRunner).toHaveBeenCalledTimes(1);
    expect(admitDisposeRunner).toHaveBeenCalledWith("conv-text-1");
  });

  it("admits a queue-prompt effect and prompts with the prepared text", async () => {
    const runner = healthyRunner();
    const buffer = { marker: "buffer" };
    const createMessageBuffer = mock(() => buffer);
    const admitPromptTurn = mock(
      (_conversation: ConversationState, _surface: Surface, run: PromptRun, _onError: unknown) =>
        runtimeAdmission.handoff(run(runner, alwaysCurrent)),
    );
    const dispatcher = { admitPromptTurn, createMessageBuffer } as unknown as TurnDispatcher;
    const message = makeMessage(undefined, (content) => `prepared:${String(content)}`);

    const admission = await applySideEffects(
      dispatcher,
      [{ kind: "queue-prompt", conversation, surface, text: "queued text" }],
      message,
    );

    expect(admission?.kind).toBe("handoff");
    await admission!.completion;
    expect(admitPromptTurn).toHaveBeenCalledTimes(1);
    expect(createMessageBuffer).toHaveBeenCalledWith(surface, conversation);
    expect(runner.prompt).toHaveBeenCalledTimes(1);
    expect(runner.prompt).toHaveBeenCalledWith("prepared:queued text", buffer);
  });

  it("does no work in a queue-prompt run whose authority is no longer current", async () => {
    const runner = healthyRunner();
    const createMessageBuffer = mock(() => ({}));
    const admitPromptTurn = mock(
      (_conversation: ConversationState, _surface: Surface, run: PromptRun, _onError: unknown) =>
        runtimeAdmission.handoff(run(runner, neverCurrent)),
    );
    const dispatcher = { admitPromptTurn, createMessageBuffer } as unknown as TurnDispatcher;
    const replies: { text: string }[] = [];

    const admission = await applySideEffects(
      dispatcher,
      [{ kind: "queue-prompt", conversation, surface, text: "queued text" }],
      makeMessage(replies),
    );

    await admission!.completion;
    expect(runner.prompt).not.toHaveBeenCalled();
    expect(createMessageBuffer).not.toHaveBeenCalled();
    expect(replies).toHaveLength(0);
  });

  it("sends the wedge reply instead of prompting when the queued runner is wedged", async () => {
    const runner = {
      isAbortTimedOut: true,
      tryClearAbortTimeout: () => false,
      prompt: mock(async (_content: unknown, _buffer: unknown) => {}),
    } as unknown as AgentRunner & { prompt: ReturnType<typeof mock> };
    const createMessageBuffer = mock(() => ({}));
    const admitPromptTurn = mock(
      (_conversation: ConversationState, _surface: Surface, run: PromptRun, _onError: unknown) =>
        runtimeAdmission.handoff(run(runner, alwaysCurrent)),
    );
    const dispatcher = { admitPromptTurn, createMessageBuffer } as unknown as TurnDispatcher;
    const replies: { text: string }[] = [];

    const admission = await applySideEffects(
      dispatcher,
      [{ kind: "queue-prompt", conversation, surface, text: "queued text" }],
      makeMessage(replies),
    );

    await admission!.completion;
    expect(runner.prompt).not.toHaveBeenCalled();
    expect(createMessageBuffer).not.toHaveBeenCalled();
    expect(replies).toHaveLength(1);
    expect(replies[0]!.text).toContain("still running after a failed cancel");
  });

  it("applies remaining effects inside the earlier admission's completion", async () => {
    const order: string[] = [];
    let resolveCreate!: (runner: AgentRunner) => void;
    const admitGetOrCreateRunner = mock(() => {
      order.push("admit-create");
      return runtimeAdmission.handoff(
        new Promise<AgentRunner>((resolve) => {
          resolveCreate = resolve;
        }),
      );
    });
    const admitPromptTurn = mock(() => {
      order.push("admit-prompt");
      return runtimeAdmission.handoff(Promise.resolve());
    });
    const dispatcher = { admitGetOrCreateRunner, admitPromptTurn } as unknown as TurnDispatcher;

    const admission = await applySideEffects(
      dispatcher,
      [
        { kind: "runner-created", conversation, surface },
        { kind: "queue-prompt", conversation, surface, text: "later" },
      ],
      makeMessage(),
    );

    expect(admission?.kind).toBe("handoff");
    expect(order).toEqual(["admit-create"]);
    const settled = admission!.completion.then(() => {
      order.push("settled");
    });
    resolveCreate(healthyRunner());
    await settled;
    expect(order).toEqual(["admit-create", "admit-prompt", "settled"]);
  });

  it("turns a rejected later admission into a completion failure", async () => {
    const admitGetOrCreateRunner = mock(
      () => runtimeAdmission.handoff<AgentRunner>(Promise.resolve(healthyRunner())),
    );
    const admitPromptTurn = mock(() => runtimeAdmission.rejected(undefined));
    const dispatcher = { admitGetOrCreateRunner, admitPromptTurn } as unknown as TurnDispatcher;

    const admission = await applySideEffects(
      dispatcher,
      [
        { kind: "runner-created", conversation, surface },
        { kind: "queue-prompt", conversation, surface, text: "later" },
      ],
      makeMessage(),
    );

    expect(admission?.kind).toBe("handoff");
    await expect(admission!.completion).rejects.toThrow(
      "command side-effect rejected after handoff",
    );
    expect(admitPromptTurn).toHaveBeenCalledTimes(1);
  });

  it("propagates a first-effect rejection without admitting later effects", async () => {
    const admitGetOrCreateRunner = mock(
      () => runtimeAdmission.rejected<AgentRunner>(Promise.resolve(undefined as unknown as AgentRunner)),
    );
    const admitPromptTurn = mock(() => runtimeAdmission.handoff(Promise.resolve()));
    const dispatcher = { admitGetOrCreateRunner, admitPromptTurn } as unknown as TurnDispatcher;

    const admission = await applySideEffects(
      dispatcher,
      [
        { kind: "runner-created", conversation, surface },
        { kind: "queue-prompt", conversation, surface, text: "later" },
      ],
      makeMessage(),
    );

    expect(admission?.kind).toBe("rejected");
    await expect(admission!.completion).rejects.toThrow(
      "command side-effect rejected after handoff",
    );
    expect(admitPromptTurn).not.toHaveBeenCalled();
  });

  it("returns the rejected admission unchanged when queue-prompt admission rejects", async () => {
    const admitPromptTurn = mock(() => runtimeAdmission.rejected(undefined));
    const dispatcher = { admitPromptTurn } as unknown as TurnDispatcher;

    const admission = await applySideEffects(
      dispatcher,
      [{ kind: "queue-prompt", conversation, surface, text: "later" }],
      makeMessage(),
    );

    expect(admission?.kind).toBe("rejected");
    await admission!.completion;
  });
});

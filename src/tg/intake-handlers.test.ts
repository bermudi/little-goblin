import { describe, expect, it, mock } from "bun:test";
import type { Bot } from "grammy";
import type { InlineQueryResult } from "@grammyjs/types";
import type { AgentRunner } from "../agent/mod.ts";
import type { Config } from "../config.ts";
import type { PendingCompletionClaim } from "../delegated-work/mod.ts";
import type { MemoryStore } from "../memory/mod.ts";
import type { ConversationLifecycle } from "../orchestration/conversation-lifecycle.ts";
import type { WorkAuthority } from "../orchestration/conversation-runtime-host.ts";
import type { TurnDispatcher } from "../orchestration/dispatcher.ts";
import type { ConversationState } from "../sessions/mod.ts";
import { runtimeAdmission } from "../shutdown/mod.ts";
import { dmSurface, guestSurface } from "../surface.ts";
import { downloadFile, downloadFileBytes, downloadPhoto } from "./intake-download.ts";
import { attemptCreationAdmission, withRejectedCreationRelease } from "./intake-admission.ts";
import {
  claimPendingCompletions,
  claimPendingGuestCompletions,
  recordAssistantReply,
  resolveActiveTurn,
  runnerWedged,
  runPrompt,
  WEDGED_RUNNER_REPLY,
  type IntakeDeps,
} from "./intake-turn.ts";
import { createAudioHandler } from "./intake-audio.ts";
import { createDocumentHandler } from "./intake-document.ts";
import { article, busyArticle, createGuestMessageHandler, errorArticle } from "./intake-guest.ts";
import { createPhotoHandler } from "./intake-photo.ts";
import { createTopicDescriptionHandler } from "./intake-topic-description.ts";
import { createVoiceHandler } from "./intake-voice.ts";
import type { GuestMessage, TelegramIntakeMessage } from "./intake.ts";

const originalFetch = globalThis.fetch;

function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}

describe("leaf intake handler modules", () => {
  it("exposes every leaf handler factory and shared leaf helper as importable", () => {
    for (const factory of [
      createPhotoHandler,
      createDocumentHandler,
      createVoiceHandler,
      createAudioHandler,
      createTopicDescriptionHandler,
      createGuestMessageHandler,
    ]) {
      expect(typeof factory).toBe("function");
    }
    for (const helper of [
      downloadFileBytes,
      downloadFile,
      downloadPhoto,
      claimPendingCompletions,
      claimPendingGuestCompletions,
      withRejectedCreationRelease,
      attemptCreationAdmission,
      recordAssistantReply,
      runnerWedged,
      resolveActiveTurn,
      runPrompt,
      article,
      busyArticle,
      errorArticle,
    ]) {
      expect(typeof helper).toBe("function");
    }
    expect(typeof WEDGED_RUNNER_REPLY).toBe("string");
  });

  it("drives the photo handler end to end through a constructed deps object", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = mock(async () =>
      new Response(bytes, { headers: { "content-length": String(bytes.byteLength) } }),
    ) as unknown as typeof fetch;
    try {
      const prompt = mock(async (_content: unknown, _buffer: unknown) => {});
      const runner = {
        isAbortTimedOut: false,
        tryClearAbortTimeout: () => false,
        prompt,
      } as unknown as AgentRunner;
      const conversation = {
        id: "conv-photo",
        executionEnvironment: undefined,
      } as unknown as ConversationState;
      const authority = { isCurrent: () => true } as unknown as WorkAuthority;
      const admitPromptTurn = mock(
        (
          _conversation: ConversationState,
          _surface: unknown,
          run: (runner: AgentRunner, authority: WorkAuthority) => Promise<void>,
          _onError: unknown,
        ) => runtimeAdmission.handoff(run(runner, authority)),
      );
      const claimForInteraction = mock(async () => 0);
      const deps: IntakeDeps = {
        cfg: { botToken: "test-token" } as Config,
        dispatcher: {
          getRunner: () => null,
          admitPromptTurn,
          createMessageBuffer: () => ({}),
        } as unknown as TurnDispatcher,
        lifecycle: {
          resolveOrStart: mock(async () => ({
            kind: "existing" as const,
            conversation,
            creationLease: null,
          })),
        } as unknown as ConversationLifecycle,
        pendingClaim: {
          claimForInteraction,
          claimForGuestSummon: mock(async () => 0),
        } as unknown as PendingCompletionClaim,
        memoryStore: {} as MemoryStore,
      };
      const message: TelegramIntakeMessage = {
        surface: dmSurface(1),
        reply: async () => {},
        prepare: (content) => content,
      };
      const api = {
        getFile: mock(async () => ({ file_path: "photos/x.jpg" })),
      } as unknown as Bot["api"];

      const handlePhoto = createPhotoHandler(deps);
      const admission = await handlePhoto(message, api, ["small", "large"], "a caption");
      expect(admission.kind).toBe("handoff");
      await admission.completion;

      expect(claimForInteraction).toHaveBeenCalledTimes(1);
      expect(prompt).toHaveBeenCalledTimes(1);
      const content = prompt.mock.calls[0]![0] as { type: string; text?: string; mimeType?: string }[];
      expect(content[0]).toEqual({ type: "text", text: "a caption" });
      expect(content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    } finally {
      restoreFetch();
    }
  });

  it("drives the guest handler's busy classification through a constructed deps object", async () => {
    const results: InlineQueryResult[] = [];
    const claimForGuestSummon = mock(async () => 0);
    const admitImmediateTurn = mock(() => ({ kind: "busy" as const }));
    const conversation = { id: "conv-guest" } as unknown as ConversationState;
    const deps: IntakeDeps = {
      cfg: {} as Config,
      dispatcher: { admitImmediateTurn } as unknown as TurnDispatcher,
      lifecycle: {
        resolveOrStart: mock(async () => ({
          kind: "existing" as const,
          conversation,
          creationLease: null,
        })),
      } as unknown as ConversationLifecycle,
      pendingClaim: {
        claimForInteraction: mock(async () => 0),
        claimForGuestSummon,
      } as unknown as PendingCompletionClaim,
      memoryStore: {} as MemoryStore,
    };
    const message: GuestMessage = {
      surface: guestSurface(99),
      replyVia: async (result) => {
        results.push(result);
        return true;
      },
    };

    const handleGuestMessage = createGuestMessageHandler(deps);
    const admission = await handleGuestMessage(message, "hello");
    expect(admission.kind).toBe("busy");
    await admission.completion;

    expect(claimForGuestSummon).toHaveBeenCalledTimes(1);
    expect(admitImmediateTurn).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ type: "article" });
    const articleResult = results[0] as { input_message_content: { message_text: string } };
    expect(articleResult.input_message_content.message_text).toContain("already thinking");
  });

  it("drives the topic description handler through a constructed deps object", async () => {
    const setDescription = mock(async () => {});
    const deps = {
      memoryStore: { setDescription } as unknown as MemoryStore,
    } as IntakeDeps;
    const handleTopicDescription = createTopicDescriptionHandler(deps);

    const written = await handleTopicDescription(5, 7, "a topic");
    expect(written.kind).toBe("completed");
    await written.completion;
    expect(setDescription).toHaveBeenCalledWith({ topic: { chatId: 5, topicId: 7 } }, "a topic");

    setDescription.mockClear();
    const skipped = await handleTopicDescription(undefined, 7, "a topic");
    expect(skipped.kind).toBe("completed");
    expect(setDescription).not.toHaveBeenCalled();
  });
});

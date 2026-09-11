import { randomUUID } from "node:crypto";
import type { InlineQueryResult } from "@grammyjs/types";
import { log } from "../log.ts";
import { surfaceId } from "../surface.ts";
import type { ConversationState } from "../sessions/mod.ts";
import type { ConversationCreationLease } from "../orchestration/conversation-lifecycle.ts";
import {
  completed,
  runtimeAdmission,
  type AdmissionResult,
  type RuntimeAdmissionResult,
} from "../shutdown/mod.ts";
import { GuestReplySink } from "./guest-sink.ts";
import type { GuestMessage } from "./intake.ts";
import { attemptCreationAdmission, withRejectedCreationRelease } from "./intake-admission.ts";
import { claimPendingGuestCompletions, type IntakeDeps } from "./intake-turn.ts";

/** Build a single-shot `InlineQueryResultArticle` carrying plain text. */
export function article(messageText: string): InlineQueryResult {
  return {
    type: "article",
    id: randomUUID(),
    title: "Goblin",
    input_message_content: { message_text: messageText },
  };
}

export function busyArticle(): InlineQueryResult {
  return article("⏳ I'm already thinking about something — try again in a moment.");
}

export function errorArticle(): InlineQueryResult {
  return article("⚠️ Something went wrong.");
}

/**
 * Resolve guest Surface binding and hand one immediate/no-wait turn to the
 * runtime kernel. Telegram retains only the opaque one-shot reply mapping;
 * runner occupancy, authority, prompting, and settlement stay behind the
 * dispatcher/machine boundary.
 */
export function createGuestMessageHandler(deps: IntakeDeps) {
  return async function handleGuestMessage(
    message: GuestMessage,
    text: string,
  ): Promise<AdmissionResult<void>> {
    const { dispatcher, lifecycle, pendingClaim } = deps;
    const surface = message.surface;
    let replyAttempted = false;
    const replyOnce = async (result: InlineQueryResult, failureLog: string): Promise<void> => {
      if (replyAttempted) return;
      replyAttempted = true;
      try {
        await message.replyVia(result);
      } catch (error) {
        log.warn(failureLog, { error: String(error), surfaceId: surfaceId(surface) });
      }
    };

    let conversation: ConversationState;
    let creationLease: ConversationCreationLease | null;
    try {
      const resolution = await lifecycle.resolveOrStart(surface);
      conversation = resolution.conversation;
      creationLease = resolution.creationLease;
    } catch (error) {
      log.error("guest resolve failed", { error: String(error), surfaceId: surfaceId(surface) });
      return completed(replyOnce(errorArticle(), "guest error reply failed"));
    }

    // The guest query itself is the authorized summon: retained completions
    // for this exact guest Surface claim alongside the summoned turn.
    claimPendingGuestCompletions(pendingClaim, surface);

    const sink = new GuestReplySink();
    const admission = await attemptCreationAdmission(
      () => dispatcher.admitImmediateTurn(
        conversation,
        surface,
        text,
        sink,
        {
          success: () => replyOnce(article(sink.text || "(no response)"), "guest reply failed"),
          failure: async (error) => {
            log.warn("guest turn failed", {
              error: error instanceof Error ? error.message : String(error),
              surfaceId: surfaceId(surface),
              sessionId: conversation.id,
            });
            await replyOnce(errorArticle(), "guest error reply failed");
          },
        },
      ),
      creationLease,
      lifecycle,
      "guest",
    );

    let rejectedAdmission: RuntimeAdmissionResult<void>;
    switch (admission.kind) {
      case "accepted": {
        if (creationLease !== null) lifecycle.sealCreation(creationLease);
        const completion = admission.settlement.then(async (settlement) => {
          if (settlement.kind === "failed") {
            log.error("accepted guest runtime work failed", {
              error: settlement.error instanceof Error
                ? settlement.error.message
                : String(settlement.error),
              surfaceId: surfaceId(surface),
              sessionId: conversation.id,
            });
          }
          if (settlement.delivery !== undefined) await settlement.delivery;
        });
        return runtimeAdmission.handoff(completion);
      }
      case "busy":
        log.debug("guest summon dropped: runtime busy", {
          surfaceId: surfaceId(surface),
          sessionId: conversation.id,
        });
        rejectedAdmission = runtimeAdmission.busy(replyOnce(busyArticle(), "guest busy reply failed"));
        break;
      case "closed":
        rejectedAdmission = runtimeAdmission.rejected(undefined);
        break;
      case "fenced":
        rejectedAdmission = runtimeAdmission.fenced(undefined);
        break;
    }
    return withRejectedCreationRelease(rejectedAdmission, creationLease, lifecycle, "guest");
  };
}

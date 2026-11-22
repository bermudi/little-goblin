import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { z } from "zod";
import type { SentMediaMetadata } from "../../../src/http/app-wire.ts";
import { unlandedMeta } from "./MetaLine.tsx";

const sentMediaMetadata: z.ZodType<SentMediaMetadata> = z.object({
  sentMedia: z.object({ replyId: z.string().min(1), toolCallId: z.string().min(1) }),
});

export function placeSentMedia(messages: readonly UIMessage[]) {
  const replies = new Map(messages.map((message) => [message.id, message]));
  const hidden = new Set<UIMessage>();
  const byReply = new Map<string, Map<string, UIMessage[]>>();
  for (const message of messages) {
    if (message.role !== "assistant" || message.metadata === undefined) continue;
    const parsed = sentMediaMetadata.safeParse(message.metadata);
    if (!parsed.success) continue;
    const { replyId, toolCallId } = parsed.data.sentMedia;
    const reply = replies.get(replyId);
    if (reply === undefined || reply === message) continue;
    const parts = reply.role === "assistant" ? reply.parts : unlandedMeta(reply)?.reply;
    if (!parts?.some((part) =>
      isToolUIPart(part) && part.toolCallId === toolCallId && getToolName(part) !== "ui"
    )) continue;
    const byCall = byReply.get(replyId) ?? new Map<string, UIMessage[]>();
    const media = byCall.get(toolCallId) ?? [];
    media.push(message);
    byCall.set(toolCallId, media);
    byReply.set(replyId, byCall);
    hidden.add(message);
  }
  return { hidden, byReply };
}

import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { placeSentMedia } from "./sentMedia.ts";

const reply: UIMessage = {
  id: "reply",
  role: "assistant",
  parts: [{ type: "tool-send_file", toolCallId: "call", state: "output-available", input: {}, output: {} }],
};
const media = (id: string, replyId?: string, toolCallId = "call"): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text: id }],
  ...(replyId === undefined ? {} : { metadata: { sentMedia: { replyId, toolCallId } } }),
});

describe("placeSentMedia", () => {
  test("moves matched media in delivery order and retains unmatched and old messages", () => {
    const first = media("first", reply.id);
    const old = media("old");
    const missingReply = media("missing-reply", "not-loaded");
    const missingCall = media("missing-call", reply.id, "not-loaded");
    const second = media("second", reply.id);
    const result = placeSentMedia([first, old, missingReply, missingCall, second, reply]);
    expect([...result.hidden].map((m) => m.id)).toEqual(["first", "second"]);
    expect(result.byReply.get(reply.id)?.get("call")?.map((m) => m.id)).toEqual(["first", "second"]);
  });
  test("a reused tool call ID does not duplicate or move a file to another reply", () => {
    const next = { ...reply, id: "next" };
    const result = placeSentMedia([media("first", reply.id), reply, media("second", next.id), next]);
    expect(result.byReply.get(reply.id)?.get("call")?.map((m) => m.id)).toEqual(["first"]);
    expect(result.byReply.get(next.id)?.get("call")?.map((m) => m.id)).toEqual(["second"]);
  });
  test("a sent file follows visible tool work in a stopped reply", () => {
    const stopped: UIMessage = {
      id: "stopped",
      role: "system",
      parts: [{ type: "text", text: "record" }],
      metadata: { unlanded: { kind: "aborted", runId: "run", reply: reply.parts } },
    };
    const result = placeSentMedia([media("first", stopped.id), stopped]);
    expect(result.byReply.get(stopped.id)?.get("call")?.[0]?.id).toBe("first");
  });
});

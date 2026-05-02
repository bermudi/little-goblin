import type { MemoryStore } from "./store.ts";

/**
 * Per-turn memory aside.
 *
 * Returns `null` when both `memory.md` and `user.md` are empty/absent.
 * Otherwise returns a `Pick<CustomMessage, ...>` shaped payload suitable
 * for `AgentSession.sendCustomMessage(...)` with `deliverAs: "nextTurn"`.
 *
 * Spec contract (`specs/memory/spec.md`):
 *  - text begins with `[goblin memory snapshot]`
 *  - both `## memory.md` and `## user.md` sections present, in that order
 *  - empty individual files render as the literal `(empty)` body
 */
export interface MemorySnapshotPayload {
  customType: "goblin.memory.snapshot";
  content: string;
  display: false;
  details: undefined;
}

export function formatSnapshot(store: MemoryStore): MemorySnapshotPayload | null {
  const memoryBody = store.readBody("memory");
  const userBody = store.readBody("user");
  if (memoryBody.length === 0 && userBody.length === 0) {
    return null;
  }
  const text =
    `[goblin memory snapshot]\n\n` +
    `## memory.md\n${memoryBody.length === 0 ? "(empty)" : memoryBody}\n\n` +
    `## user.md\n${userBody.length === 0 ? "(empty)" : userBody}`;
  return {
    customType: "goblin.memory.snapshot",
    content: text,
    display: false,
    details: undefined,
  };
}

import type { Context } from "grammy";

type MessageEntity = NonNullable<Context["msg"]>["entities"] extends (infer E)[] | undefined ? E : never;

export function botMentionRanges(
  _bot: { id: number; username?: string },
  _text: string,
  _entities: readonly MessageEntity[],
): Array<[number, number]> {
  throw new Error("botMentionRanges: not implemented");
}

export function botHandlePattern(_username: string, _flags?: string): RegExp {
  throw new Error("botHandlePattern: not implemented");
}

export function isBotMentioned(_ctx: Context): boolean {
  throw new Error("isBotMentioned: not implemented");
}

export function stripBotMention(_ctx: Context, _text: string): string {
  throw new Error("stripBotMention: not implemented");
}

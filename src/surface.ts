/**
 * Pure Telegram surface identity.
 *
 * `Surface` is a discriminated union that completely describes a Telegram
 * delivery lane: DM, private-chat topic, forum-supergroup topic, direct-messages
 * topic, topicless supergroup, or guest summon. `SurfaceId` is the canonical,
 * reversible, versioned string encoding used for map keys, persistence, logs,
 * and equality.
 *
 * This module deliberately imports nothing from grammy, sessions, or Telegram
 * adapters so that sessions and orchestration can consume the type without
 * crossing the Telegram boundary.
 */

export type TopicContainer = "private" | "supergroup" | "direct-messages";

export interface DmSurface {
  kind: "dm";
  chatId: number;
}

export interface TopicSurface {
  kind: "topic";
  container: TopicContainer;
  chatId: number;
  topicId: number;
}

export interface SupergroupSurface {
  kind: "supergroup";
  chatId: number;
}

export interface GuestSurface {
  kind: "guest";
  chatId: number;
}

export type Surface = DmSurface | TopicSurface | SupergroupSurface | GuestSurface;

declare const SurfaceIdBrand: unique symbol;
export type SurfaceId = string & { [SurfaceIdBrand]: true };

const TOPIC_CONTAINERS: readonly TopicContainer[] = ["private", "supergroup", "direct-messages"];

function assertNonZeroSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value === 0) {
    throw new Error(`invalid ${name}: ${String(value)}`);
  }
  return value;
}

function assertPositiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${String(value)}`);
  }
  return value;
}

function assertTopicContainer(value: unknown): TopicContainer {
  if (typeof value !== "string" || !(TOPIC_CONTAINERS as readonly string[]).includes(value)) {
    throw new Error(`invalid topic container: ${String(value)}`);
  }
  return value as TopicContainer;
}

function assertSurface(value: unknown): Surface {
  if (value === null || typeof value !== "object") {
    throw new Error(`invalid surface: ${String(value)}`);
  }
  const s = value as Record<string, unknown>;
  const kind = s.kind;
  if (kind !== "dm" && kind !== "topic" && kind !== "supergroup" && kind !== "guest") {
    throw new Error(`invalid surface kind: ${String(kind)}`);
  }
  const chatId = assertNonZeroSafeInteger(s.chatId, "chatId");
  switch (kind) {
    case "dm":
      return { kind, chatId };
    case "supergroup":
      return { kind, chatId };
    case "guest":
      return { kind, chatId };
    case "topic": {
      const container = assertTopicContainer(s.container);
      const topicId = assertPositiveSafeInteger(s.topicId, "topicId");
      return { kind, container, chatId, topicId };
    }
  }
}

export function dmSurface(chatId: number): DmSurface {
  return { kind: "dm", chatId: assertNonZeroSafeInteger(chatId, "chatId") };
}

export function topicSurface(
  container: TopicContainer,
  chatId: number,
  topicId: number,
): TopicSurface {
  return {
    kind: "topic",
    container: assertTopicContainer(container),
    chatId: assertNonZeroSafeInteger(chatId, "chatId"),
    topicId: assertPositiveSafeInteger(topicId, "topicId"),
  };
}

export function supergroupSurface(chatId: number): SupergroupSurface {
  return { kind: "supergroup", chatId: assertNonZeroSafeInteger(chatId, "chatId") };
}

export function guestSurface(chatId: number): GuestSurface {
  return { kind: "guest", chatId: assertNonZeroSafeInteger(chatId, "chatId") };
}

export function isDm(surface: Surface): surface is DmSurface {
  return surface.kind === "dm";
}

export function isTopic(surface: Surface): surface is TopicSurface {
  return surface.kind === "topic";
}

export function isSupergroupSurface(surface: Surface): surface is SupergroupSurface {
  return surface.kind === "supergroup";
}

export function isGuestSurface(surface: Surface): surface is GuestSurface {
  return surface.kind === "guest";
}

export function surfaceId(surface: Surface): SurfaceId {
  assertSurface(surface);
  switch (surface.kind) {
    case "dm":
      return `tg:v1:dm:${surface.chatId}` as SurfaceId;
    case "supergroup":
      return `tg:v1:supergroup:${surface.chatId}` as SurfaceId;
    case "guest":
      return `tg:v1:guest:${surface.chatId}` as SurfaceId;
    case "topic":
      return `tg:v1:topic:${surface.container}:${surface.chatId}:${surface.topicId}` as SurfaceId;
  }
}

function parseCanonicalInteger(text: string, name: string): number {
  if (text === "") {
    throw new Error(`${name} is empty`);
  }
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n) || String(n) !== text) {
    throw new Error(`non-canonical ${name}: ${text}`);
  }
  return n;
}

export function parseSurfaceId(text: string): Surface {
  if (typeof text !== "string") {
    throw new Error(`invalid SurfaceId: ${String(text)}`);
  }
  const parts = text.split(":");
  if (parts.length < 2 || parts[0] !== "tg" || parts[1] !== "v1") {
    throw new Error(`unknown SurfaceId version: ${text}`);
  }

  const kind = parts[2];
  if (kind === "topic") {
    if (parts.length !== 6) {
      throw new Error(`invalid SurfaceId topic format: ${text}`);
    }
    const container = assertTopicContainer(parts[3]!);
    const chatId = parseCanonicalInteger(parts[4]!, "chatId");
    const topicId = parseCanonicalInteger(parts[5]!, "topicId");
    if (chatId === 0) {
      throw new Error(`invalid SurfaceId chatId: ${text}`);
    }
    if (topicId <= 0) {
      throw new Error(`invalid SurfaceId topicId: ${text}`);
    }
    const surface: Surface = { kind: "topic", container, chatId, topicId };
    if (text !== surfaceId(surface)) {
      throw new Error(`non-canonical SurfaceId: ${text}`);
    }
    return surface;
  }

  if (kind === "dm" || kind === "supergroup" || kind === "guest") {
    if (parts.length !== 4) {
      throw new Error(`invalid SurfaceId ${kind} format: ${text}`);
    }
    const chatId = parseCanonicalInteger(parts[3]!, "chatId");
    if (chatId === 0) {
      throw new Error(`invalid SurfaceId chatId: ${text}`);
    }
    const surface: Surface = { kind, chatId };
    if (text !== surfaceId(surface)) {
      throw new Error(`non-canonical SurfaceId: ${text}`);
    }
    return surface;
  }

  throw new Error(`unknown SurfaceId kind: ${text}`);
}

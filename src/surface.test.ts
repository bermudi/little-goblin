import { describe, expect, it } from "bun:test";
import {
  dmSurface,
  guestSurface,
  isDm,
  isGuestSurface,
  isSupergroupSurface,
  isTopic,
  parseSurfaceId,
  supergroupSurface,
  surfaceId,
  topicSurface,
  type Surface,
  type SurfaceId,
  type TopicContainer,
} from "./surface.ts";

describe("surface constructors", () => {
  it("builds a DM surface", () => {
    const surface = dmSurface(42);
    expect(surface).toEqual({ kind: "dm", chatId: 42 });
    expect(isDm(surface)).toBe(true);
  });

  it("builds a private topic surface", () => {
    const surface = topicSurface("private", 42, 7);
    expect(surface).toEqual({ kind: "topic", container: "private", chatId: 42, topicId: 7 });
    expect(isTopic(surface)).toBe(true);
  });

  it("builds a supergroup topic surface", () => {
    const surface = topicSurface("supergroup", -1001234567890, 99);
    expect(surface).toEqual({ kind: "topic", container: "supergroup", chatId: -1001234567890, topicId: 99 });
  });

  it("builds a direct-messages topic surface", () => {
    const surface = topicSurface("direct-messages", -1003958530002, 91);
    expect(surface).toEqual({ kind: "topic", container: "direct-messages", chatId: -1003958530002, topicId: 91 });
  });

  it("builds a topicless supergroup surface", () => {
    const surface = supergroupSurface(-1003958530002);
    expect(surface).toEqual({ kind: "supergroup", chatId: -1003958530002 });
    expect(isSupergroupSurface(surface)).toBe(true);
  });

  it("builds a guest surface", () => {
    const surface = guestSurface(-1003958530002);
    expect(surface).toEqual({ kind: "guest", chatId: -1003958530002 });
    expect(isGuestSurface(surface)).toBe(true);
  });

  it("rejects zero chat ids", () => {
    expect(() => dmSurface(0)).toThrow("invalid chatId");
    expect(() => supergroupSurface(0)).toThrow("invalid chatId");
    expect(() => guestSurface(0)).toThrow("invalid chatId");
    expect(() => topicSurface("private", 0, 1)).toThrow("invalid chatId");
  });

  it("rejects non-positive topic ids", () => {
    expect(() => topicSurface("private", 42, 0)).toThrow("invalid topicId");
    expect(() => topicSurface("private", 42, -1)).toThrow("invalid topicId");
  });

  it("rejects unsafe chat ids", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(() => dmSurface(unsafe)).toThrow("invalid chatId");
    expect(() => supergroupSurface(-unsafe)).toThrow("invalid chatId");
  });

  it("rejects unsafe topic ids", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(() => topicSurface("supergroup", -1, unsafe)).toThrow("invalid topicId");
  });

  it("accepts boundary safe integers", () => {
    expect(dmSurface(Number.MAX_SAFE_INTEGER).chatId).toBe(Number.MAX_SAFE_INTEGER);
    expect(supergroupSurface(Number.MIN_SAFE_INTEGER).chatId).toBe(Number.MIN_SAFE_INTEGER);
    expect(topicSurface("supergroup", -1, Number.MAX_SAFE_INTEGER).topicId).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects non-numeric ids", () => {
    // @ts-expect-error testing runtime defense
    expect(() => dmSurface("42")).toThrow("invalid chatId");
    // @ts-expect-error testing runtime defense
    expect(() => topicSurface("private", 42, "7")).toThrow("invalid topicId");
  });

  it("rejects invalid containers", () => {
    // @ts-expect-error testing runtime defense
    expect(() => topicSurface("public", 42, 7)).toThrow("invalid topic container");
  });
});

describe("surfaceId", () => {
  it("encodes every variant", () => {
    expect(surfaceId(dmSurface(889192981)) as string).toBe("tg:v1:dm:889192981");
    expect(surfaceId(supergroupSurface(-1003958530002)) as string).toBe("tg:v1:supergroup:-1003958530002");
    expect(surfaceId(guestSurface(-1003958530002)) as string).toBe("tg:v1:guest:-1003958530002");
    expect(surfaceId(topicSurface("private", 889192981, 42)) as string).toBe("tg:v1:topic:private:889192981:42");
    expect(surfaceId(topicSurface("supergroup", -1003958530002, 180)) as string).toBe("tg:v1:topic:supergroup:-1003958530002:180");
    expect(surfaceId(topicSurface("direct-messages", -1003958530002, 91)) as string).toBe("tg:v1:topic:direct-messages:-1003958530002:91");
  });
});

describe("parseSurfaceId", () => {
  it("round-trips every variant", () => {
    const surfaces: Surface[] = [
      dmSurface(889192981),
      supergroupSurface(-1003958530002),
      guestSurface(-1003958530002),
      topicSurface("private", 889192981, 42),
      topicSurface("supergroup", -1003958530002, 180),
      topicSurface("direct-messages", -1003958530002, 91),
    ];
    for (const surface of surfaces) {
      const id = surfaceId(surface);
      expect(parseSurfaceId(id as string)).toEqual(surface);
    }
  });

  it("round-trips boundary safe integers", () => {
    const s = topicSurface("supergroup", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    expect(parseSurfaceId(surfaceId(s) as string)).toEqual(s);
  });
});

describe("SurfaceId collisions", () => {
  it("keeps same-number dm, supergroup, and guest distinct", () => {
    const chatId = 123;
    const dm = surfaceId(dmSurface(chatId)) as string;
    const sg = surfaceId(supergroupSurface(chatId)) as string;
    const guest = surfaceId(guestSurface(chatId)) as string;
    expect(dm).not.toBe(sg);
    expect(dm).not.toBe(guest);
    expect(sg).not.toBe(guest);
  });

  it("keeps topic containers distinct for same chat/topic numbers", () => {
    const ids: SurfaceId[] = [
      surfaceId(topicSurface("private", 42, 7)),
      surfaceId(topicSurface("supergroup", 42, 7)),
      surfaceId(topicSurface("direct-messages", 42, 7)),
    ];
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("parseSurfaceId rejects malformed input", () => {
  it("rejects unknown versions", () => {
    expect(() => parseSurfaceId("tg:v2:dm:42")).toThrow("unknown SurfaceId version");
    expect(() => parseSurfaceId("foo:v1:dm:42")).toThrow("unknown SurfaceId version");
  });

  it("rejects unknown kinds", () => {
    expect(() => parseSurfaceId("tg:v1:group:42")).toThrow("unknown SurfaceId kind");
  });

  it("rejects missing or extra parts", () => {
    expect(() => parseSurfaceId("tg:v1:dm")).toThrow("invalid SurfaceId dm format");
    expect(() => parseSurfaceId("tg:v1:dm:42:extra")).toThrow("invalid SurfaceId dm format");
    expect(() => parseSurfaceId("tg:v1:topic:private:42")).toThrow("invalid SurfaceId topic format");
    expect(() => parseSurfaceId("tg:v1:topic:private:42:7:extra")).toThrow("invalid SurfaceId topic format");
  });

  it("rejects zero chat ids", () => {
    expect(() => parseSurfaceId("tg:v1:dm:0")).toThrow("invalid SurfaceId chatId");
  });

  it("rejects non-positive topic ids", () => {
    expect(() => parseSurfaceId("tg:v1:topic:private:42:0")).toThrow("invalid SurfaceId topicId");
    expect(() => parseSurfaceId("tg:v1:topic:private:42:-1")).toThrow("invalid SurfaceId topicId");
  });

  it("rejects non-canonical integers", () => {
    expect(() => parseSurfaceId("tg:v1:dm:042")).toThrow();
    expect(() => parseSurfaceId("tg:v1:dm:+42")).toThrow();
    expect(() => parseSurfaceId("tg:v1:dm:1e3")).toThrow();
    expect(() => parseSurfaceId("tg:v1:dm:1.5")).toThrow();
    expect(() => parseSurfaceId("tg:v1:dm:0x2a")).toThrow();
  });

  it("rejects padded topic ids", () => {
    expect(() => parseSurfaceId("tg:v1:topic:private:42:007")).toThrow();
  });

  it("rejects unsafe integers", () => {
    const unsafe = String(Number.MAX_SAFE_INTEGER + 1);
    expect(() => parseSurfaceId(`tg:v1:dm:${unsafe}`)).toThrow("non-canonical chatId");
  });

  it("rejects invalid containers", () => {
    expect(() => parseSurfaceId("tg:v1:topic:public:42:7")).toThrow("invalid topic container");
  });
});

describe("surfaceId rejects malformed runtime values", () => {
  it("rejects surfaces with bad runtime fields", () => {
    expect(() => surfaceId({ kind: "dm", chatId: 1.5 } as Surface)).toThrow("invalid chatId");
    expect(() => surfaceId({ kind: "topic", container: "private" as TopicContainer, chatId: 42, topicId: -1 } as Surface)).toThrow("invalid topicId");
    expect(() => surfaceId({ kind: "topic", container: "unknown" as TopicContainer, chatId: 42, topicId: 1 } as Surface)).toThrow("invalid topic container");
    expect(() => surfaceId({ kind: "unknown", chatId: 42 } as unknown as Surface)).toThrow("invalid surface kind");
  });
});

import { describe, expect, it } from "bun:test";
import { dmSurface, guestSurface, supergroupSurface, topicSurface } from "../surface.ts";
import { deliveryOpts, isPrivateChat, sendTarget } from "./delivery.ts";

describe("delivery", () => {
  describe("deliveryOpts", () => {
    it("returns extra options unchanged for a DM", () => {
      expect(deliveryOpts(dmSurface(123), { disable_notification: true })).toEqual({ disable_notification: true });
    });

    it("returns extra options unchanged for a topicless supergroup", () => {
      expect(deliveryOpts(supergroupSurface(-100123), { disable_notification: true })).toEqual({ disable_notification: true });
    });

    it("adds message_thread_id for a private topic", () => {
      expect(deliveryOpts(topicSurface("private", 456, 7))).toEqual({ message_thread_id: 7 });
    });

    it("adds message_thread_id for a supergroup topic", () => {
      expect(deliveryOpts(topicSurface("supergroup", -100456, 42))).toEqual({ message_thread_id: 42 });
    });

    it("adds direct_messages_topic_id for a direct-messages topic", () => {
      expect(deliveryOpts(topicSurface("direct-messages", 789, 3))).toEqual({ direct_messages_topic_id: 3 });
    });

    it("merges extra options with thread keys", () => {
      expect(deliveryOpts(topicSurface("supergroup", -100456, 42), { disable_notification: true })).toEqual({
        disable_notification: true,
        message_thread_id: 42,
      });
    });

    it("throws for guest surfaces", () => {
      expect(() => deliveryOpts(guestSurface(99))).toThrow("Guest surfaces do not support normal Telegram send/edit methods");
    });
  });

  describe("sendTarget", () => {
    it("returns chatId and opts for a DM", () => {
      expect(sendTarget(dmSurface(123))).toEqual({ chatId: 123, opts: {} });
    });

    it("returns chatId and opts with message_thread_id for a topic", () => {
      expect(sendTarget(topicSurface("private", 456, 7))).toEqual({ chatId: 456, opts: { message_thread_id: 7 } });
    });

    it("throws for guest surfaces", () => {
      expect(() => sendTarget(guestSurface(99))).toThrow("Guest surfaces do not support normal Telegram send/edit methods");
    });
  });

  describe("isPrivateChat", () => {
    it("returns true for DM", () => {
      expect(isPrivateChat(dmSurface(123))).toBe(true);
    });

    it("returns true for a private topic", () => {
      expect(isPrivateChat(topicSurface("private", 456, 7))).toBe(true);
    });

    it("returns false for a supergroup topic", () => {
      expect(isPrivateChat(topicSurface("supergroup", -100456, 42))).toBe(false);
    });

    it("returns false for a direct-messages topic", () => {
      expect(isPrivateChat(topicSurface("direct-messages", 789, 3))).toBe(false);
    });

    it("returns false for a topicless supergroup", () => {
      expect(isPrivateChat(supergroupSurface(-100123))).toBe(false);
    });

    it("returns false for a guest surface", () => {
      expect(isPrivateChat(guestSurface(99))).toBe(false);
    });
  });
});

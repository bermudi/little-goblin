import { describe, expect, it } from "bun:test";
import { dmSurface, guestSurface, supergroupSurface, topicSurface } from "../surface.ts";
import { chatActionDeliveryOpts, deliveryOpts, isPrivateChat, sendTarget } from "./delivery.ts";

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

    it("adds message_thread_id for an ordinary forum topic", () => {
      expect(deliveryOpts(topicSurface("supergroup", -100456, 42))).toEqual({ message_thread_id: 42 });
    });

    it("omits message_thread_id for a supergroup General topic normal send", () => {
      expect(deliveryOpts(topicSurface("supergroup", -100456, 1))).toEqual({});
    });

    it("merges extra options for a supergroup General topic without thread key", () => {
      expect(deliveryOpts(topicSurface("supergroup", -100456, 1), { disable_notification: true })).toEqual({
        disable_notification: true,
      });
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

    it("strips caller-supplied thread keys for a DM", () => {
      expect(deliveryOpts(dmSurface(123), { message_thread_id: 999, direct_messages_topic_id: 888, disable_notification: true })).toEqual({
        disable_notification: true,
      });
    });

    it("strips caller-supplied thread keys for a topicless supergroup", () => {
      expect(deliveryOpts(supergroupSurface(-100123), { message_thread_id: 999, direct_messages_topic_id: 888, disable_notification: true })).toEqual({
        disable_notification: true,
      });
    });

    it("strips caller-supplied thread keys for a supergroup General topic normal send", () => {
      expect(deliveryOpts(topicSurface("supergroup", -100456, 1), { message_thread_id: 999, direct_messages_topic_id: 888 })).toEqual({});
    });

    it("overrides caller-supplied thread keys for an ordinary forum topic", () => {
      expect(deliveryOpts(topicSurface("supergroup", -100456, 42), { message_thread_id: 999, direct_messages_topic_id: 888 })).toEqual({
        message_thread_id: 42,
      });
    });

    it("overrides caller-supplied thread keys for a private topic", () => {
      expect(deliveryOpts(topicSurface("private", 456, 7), { message_thread_id: 999, direct_messages_topic_id: 888 })).toEqual({
        message_thread_id: 7,
      });
    });

    it("overrides caller-supplied thread keys for a direct-messages topic", () => {
      expect(deliveryOpts(topicSurface("direct-messages", 789, 3), { message_thread_id: 999, direct_messages_topic_id: 888 })).toEqual({
        direct_messages_topic_id: 3,
      });
    });

    it("returns a fresh options object and does not mutate extra", () => {
      const extra = { message_thread_id: 999, direct_messages_topic_id: 888, disable_notification: true };
      const result = deliveryOpts(dmSurface(123), extra);
      expect(result).not.toBe(extra);
      expect(extra).toEqual({ message_thread_id: 999, direct_messages_topic_id: 888, disable_notification: true });
    });

    it("throws for guest surfaces", () => {
      expect(() => deliveryOpts(guestSurface(99))).toThrow("Guest surfaces do not support normal Telegram send/edit methods");
    });
  });

  describe("chatActionDeliveryOpts", () => {
    it("returns extra options unchanged for a DM", () => {
      expect(chatActionDeliveryOpts(dmSurface(123), { disable_notification: true })).toEqual({ disable_notification: true });
    });

    it("returns extra options unchanged for a topicless supergroup", () => {
      expect(chatActionDeliveryOpts(supergroupSurface(-100123), { disable_notification: true })).toEqual({ disable_notification: true });
    });

    it("adds message_thread_id for a private topic", () => {
      expect(chatActionDeliveryOpts(topicSurface("private", 456, 7))).toEqual({ message_thread_id: 7 });
    });

    it("adds message_thread_id for an ordinary forum topic", () => {
      expect(chatActionDeliveryOpts(topicSurface("supergroup", -100456, 42))).toEqual({ message_thread_id: 42 });
    });

    it("adds message_thread_id = 1 for a supergroup General topic chat action", () => {
      expect(chatActionDeliveryOpts(topicSurface("supergroup", -100456, 1))).toEqual({ message_thread_id: 1 });
    });

    it("merges extra options with message_thread_id for a supergroup General topic", () => {
      expect(chatActionDeliveryOpts(topicSurface("supergroup", -100456, 1), { disable_notification: true })).toEqual({
        disable_notification: true,
        message_thread_id: 1,
      });
    });

    it("adds direct_messages_topic_id for a direct-messages topic", () => {
      expect(chatActionDeliveryOpts(topicSurface("direct-messages", 789, 3))).toEqual({ direct_messages_topic_id: 3 });
    });

    it("strips caller-supplied thread keys for a DM", () => {
      expect(chatActionDeliveryOpts(dmSurface(123), { message_thread_id: 999, direct_messages_topic_id: 888, disable_notification: true })).toEqual({
        disable_notification: true,
      });
    });

    it("strips caller-supplied thread keys for a topicless supergroup", () => {
      expect(chatActionDeliveryOpts(supergroupSurface(-100123), { message_thread_id: 999, direct_messages_topic_id: 888, disable_notification: true })).toEqual({
        disable_notification: true,
      });
    });

    it("overrides caller-supplied thread keys for a supergroup General topic chat action", () => {
      expect(chatActionDeliveryOpts(topicSurface("supergroup", -100456, 1), { message_thread_id: 999, direct_messages_topic_id: 888 })).toEqual({
        message_thread_id: 1,
      });
    });

    it("overrides caller-supplied thread keys for an ordinary forum topic", () => {
      expect(chatActionDeliveryOpts(topicSurface("supergroup", -100456, 42), { message_thread_id: 999, direct_messages_topic_id: 888 })).toEqual({
        message_thread_id: 42,
      });
    });

    it("overrides caller-supplied thread keys for a private topic", () => {
      expect(chatActionDeliveryOpts(topicSurface("private", 456, 7), { message_thread_id: 999, direct_messages_topic_id: 888 })).toEqual({
        message_thread_id: 7,
      });
    });

    it("overrides caller-supplied thread keys for a direct-messages topic", () => {
      expect(chatActionDeliveryOpts(topicSurface("direct-messages", 789, 3), { message_thread_id: 999, direct_messages_topic_id: 888 })).toEqual({
        direct_messages_topic_id: 3,
      });
    });

    it("returns a fresh options object and does not mutate extra", () => {
      const extra = { message_thread_id: 999, direct_messages_topic_id: 888, disable_notification: true };
      const result = chatActionDeliveryOpts(dmSurface(123), extra);
      expect(result).not.toBe(extra);
      expect(extra).toEqual({ message_thread_id: 999, direct_messages_topic_id: 888, disable_notification: true });
    });

    it("throws for guest surfaces", () => {
      expect(() => chatActionDeliveryOpts(guestSurface(99))).toThrow("Guest surfaces do not support normal Telegram send/edit methods");
    });
  });

  describe("sendTarget", () => {
    it("returns chatId and opts for a DM", () => {
      expect(sendTarget(dmSurface(123))).toEqual({ chatId: 123, opts: {} });
    });

    it("returns chatId and opts with message_thread_id for a topic", () => {
      expect(sendTarget(topicSurface("private", 456, 7))).toEqual({ chatId: 456, opts: { message_thread_id: 7 } });
    });

    it("returns chatId and opts without thread key for a supergroup General topic", () => {
      expect(sendTarget(topicSurface("supergroup", -100456, 1))).toEqual({ chatId: -100456, opts: {} });
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

    it("returns false for a supergroup General topic", () => {
      expect(isPrivateChat(topicSurface("supergroup", -100456, 1))).toBe(false);
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

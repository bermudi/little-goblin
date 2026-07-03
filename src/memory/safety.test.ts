import { describe, it, expect } from "bun:test";
import {
  checkDescriptionSafety,
  checkMemorySafety,
  redactPreview,
  type SafetyReason,
} from "./safety.ts";

function unsafe(content: string, opts?: { isDescription?: boolean }) {
  const r = checkMemorySafety(content, opts);
  return r;
}

function reasonOf(content: string, opts?: { isDescription?: boolean }): SafetyReason | undefined {
  const r = unsafe(content, opts);
  return r.ok ? undefined : r.reason;
}

describe("memory safety filter", () => {
  describe("accepts safe content", () => {
    it("accepts a normal preference entry", () => {
      expect(unsafe("User prefers terse engineering summaries with test output.").ok).toBe(true);
    });

    it("accepts a project fact", () => {
      expect(unsafe("Goblin runs as a single bun process on the homelab.").ok).toBe(true);
    });

    it("accepts a decision entry", () => {
      expect(unsafe("Decided: no vector database for memory in v1.").ok).toBe(true);
    });

    it("accepts a multi-line entry", () => {
      expect(unsafe("Line one.\nLine two with normal text.").ok).toBe(true);
    });
  });

  describe("rejects secrets and credentials", () => {
    it("rejects OpenAI-style API keys", () => {
      expect(reasonOf("the key is sk-abcdefghijklmnopqrstuvwxyz1234567890")).toBe("api_key");
    });

    it("rejects Anthropic-style API keys", () => {
      expect(reasonOf("sk-ant-abcdefghijklmnopqrstuvwxyz1234567890")).toBe("api_key");
    });

    it("rejects AWS access key ids", () => {
      expect(reasonOf("AKIAIOSFODNN7EXAMPLE")).toBe("api_key");
    });

    it("rejects Google API keys", () => {
      expect(reasonOf("AIzaSyDabcdefghijklmnopqrstuvwxyz123456789")).toBe("api_key");
    });

    it("rejects GitHub tokens", () => {
      expect(reasonOf("ghp_abcdefghijklmnopqrstuvwxyz0123456789AB")).toBe("api_key");
    });

    it("rejects Bearer tokens", () => {
      expect(reasonOf("Authorization: Bearer abcdefghijklmnop1234567890")).toBe("bearer_token");
    });

    it("rejects PEM private key blocks", () => {
      expect(reasonOf("-----BEGIN RSA PRIVATE KEY-----\nMIIE...")).toBe("private_key");
    });

    it("rejects password assignments", () => {
      expect(reasonOf("password: hunter2")).toBe("password");
    });

    it("rejects passwd assignments", () => {
      expect(reasonOf("passwd=hunter2")).toBe("password");
    });

    it("rejects cookie assignments", () => {
      expect(reasonOf("cookie: sessionid=abc123;")).toBe("cookie");
    });

    it("rejects Telegram bot tokens", () => {
      expect(reasonOf("123456789:AAEhBP0-abcdefghijklmnopqrstuvwxyz1234")).toBe(
        "telegram_bot_token",
      );
    });

    it("rejects generic api_key assignments", () => {
      expect(reasonOf("api_key: abc123def456")).toBe("secret_assignment");
    });

    it("rejects generic secret assignments", () => {
      expect(reasonOf("secret = abc123def456")).toBe("secret_assignment");
    });

    it("rejects generic token assignments", () => {
      expect(reasonOf("token: abc123def456")).toBe("secret_assignment");
    });
  });

  describe("rejects sensitive identifiers", () => {
    it("rejects credit-card-like digit runs", () => {
      expect(reasonOf("card 4111 1111 1111 1111")).toBe("financial_identifier");
    });

    it("rejects contiguous 16-digit runs", () => {
      expect(reasonOf("4111111111111111")).toBe("financial_identifier");
    });

    it("rejects SSN-like patterns", () => {
      expect(reasonOf("ssn 123-45-6789")).toBe("sensitive_identifier");
    });
  });

  describe("rejects tiny fragments", () => {
    it("rejects empty content", () => {
      expect(reasonOf("")).toBe("tiny_fragment");
    });

    it("rejects whitespace-only content", () => {
      expect(reasonOf("   ")).toBe("tiny_fragment");
    });

    it("rejects content shorter than 3 chars", () => {
      expect(reasonOf("hi")).toBe("tiny_fragment");
    });

    it("accepts a 3-char entry", () => {
      expect(unsafe("yes").ok).toBe(true);
    });
  });

  describe("description safety", () => {
    it("skips tiny-fragment check for descriptions", () => {
      expect(checkDescriptionSafety("ok").ok).toBe(true);
    });

    it("still rejects secrets in descriptions", () => {
      const r = checkDescriptionSafety("password: hunter2");
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("password");
    });

    it("accepts a normal description", () => {
      expect(checkDescriptionSafety("Topic about goblin memory work").ok).toBe(true);
    });
  });

  describe("redactPreview", () => {
    it("redacts long alphanumeric runs", () => {
      const preview = redactPreview("the key is sk-abcdefghijklmnopqrstuvwxyz1234567890");
      expect(preview).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
      expect(preview).toContain("[redacted:");
    });

    it("preserves short readable text", () => {
      const preview = redactPreview("User prefers terse summaries.");
      // Short words are not redacted (only runs >= 8 chars).
      expect(preview).toContain("User");
    });

    it("truncates very long previews", () => {
      const long = "a ".repeat(100) + "sk-abcdefghijklmnopqrstuvwxyz1234567890";
      const preview = redactPreview(long, 40);
      expect(preview.length).toBeLessThanOrEqual(41); // 40 + ellipsis
      expect(preview.endsWith("…")).toBe(true);
    });

    it("never copies the sensitive value verbatim", () => {
      const secret = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
      const preview = redactPreview(`Bearer ${secret}`);
      expect(preview).not.toContain(secret);
    });
  });
});

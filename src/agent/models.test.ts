import { describe, expect, it } from "bun:test";
import { resolveModel } from "./models.ts";
import type { Config } from "../config.ts";

/** Minimal Config stub with all API keys set. */
function makeConfig(modelName: string): Config {
  return {
    modelName,
    botToken: "t",
    allowedTgUserIds: "1",
    poeApiKey: "poe-key",
    openrouterApiKey: "or-key",
    openaiApiKey: "oai-key",
    anthropicApiKey: "ant-key",
    zaiApiKey: "zai-key",
    opencodeApiKey: "oc-key",
  } as unknown as Config;
}

describe("resolveModel", () => {
  it("resolves a hardcoded poe model", () => {
    const r = resolveModel(makeConfig("poe/gemini-2.5-pro"));
    expect(r.model.id).toBe("gemini-2.5-pro");
    expect(r.model.provider).toBe("poe");
    expect(r.apiKey).toBe("poe-key");
  });

  it("resolves a dynamic poe/ model not in the registry", () => {
    const r = resolveModel(makeConfig("poe/some-future-model"));
    expect(r.model.id).toBe("some-future-model");
    expect(r.model.provider).toBe("poe");
    expect(r.apiKey).toBe("poe-key");
  });

  it("resolves a hardcoded or/ model", () => {
    const r = resolveModel(makeConfig("or/openai/gpt-5"));
    expect(r.model.id).toBe("openai/gpt-5");
    expect(r.model.provider).toBe("openrouter");
    expect(r.apiKey).toBe("or-key");
  });

  it("resolves a dynamic or/ model not in the registry", () => {
    const r = resolveModel(makeConfig("or/openai/gpt-5.5"));
    expect(r.model.id).toBe("openai/gpt-5.5");
    expect(r.model.provider).toBe("openrouter");
    expect(r.apiKey).toBe("or-key");
  });

  it("resolves a dynamic openai/ gpt model (responses API)", () => {
    const r = resolveModel(makeConfig("openai/gpt-99"));
    expect(r.model.id).toBe("gpt-99");
    expect(r.model.provider).toBe("openai");
    expect(r.model.api).toBe("openai-responses");
    expect(r.apiKey).toBe("oai-key");
  });

  it("resolves a dynamic openai/ o-series model (responses API)", () => {
    const r = resolveModel(makeConfig("openai/o99"));
    expect(r.model.id).toBe("o99");
    expect(r.model.provider).toBe("openai");
    expect(r.model.api).toBe("openai-responses");
  });

  it("resolves a dynamic openai/ non-gpt model (completions API)", () => {
    const r = resolveModel(makeConfig("openai/whisper-large"));
    expect(r.model.id).toBe("whisper-large");
    expect(r.model.provider).toBe("openai");
    expect(r.model.api).toBe("openai-completions");
  });

  it("resolves a dynamic anthropic/ model", () => {
    const r = resolveModel(makeConfig("anthropic/claude-future-7"));
    expect(r.model.id).toBe("claude-future-7");
    expect(r.model.provider).toBe("anthropic");
    expect(r.model.api).toBe("anthropic-messages");
    expect(r.apiKey).toBe("ant-key");
  });

  it("throws for unknown prefix", () => {
    expect(() => resolveModel(makeConfig("grok/whatever"))).toThrow(
      /Unknown MODEL_NAME/,
    );
  });

  it("hardcoded entry takes priority over dynamic fallback", () => {
    // poe/gemini-2.5-pro has an explicit entry with 1M context;
    // dynamic poe/ fallback would give 128k.
    const r = resolveModel(makeConfig("poe/gemini-2.5-pro"));
    expect(r.model.contextWindow).toBe(1_000_000);
  });

  it("throws when required API key is missing", () => {
    const cfg = {
      modelName: "or/openai/gpt-5.5",
      botToken: "t",
      allowedTgUserIds: "1",
      // no openrouterApiKey
    } as unknown as Config;
    expect(() => resolveModel(cfg)).toThrow(/OPENROUTER_API_KEY/);
  });

  // --- zai/ provider ---

  it("resolves zai/glm-5.1 from pi-ai registry", () => {
    const r = resolveModel(makeConfig("zai/glm-5.1"));
    expect(r.model.id).toBe("glm-5.1");
    expect(r.model.provider).toBe("zai");
    expect(r.model.api).toBe("openai-completions");
    expect(r.apiKey).toBe("zai-key");
    // Verify pi-ai's compat flags survived the round-trip
    expect((r.model as any).compat?.thinkingFormat).toBe("zai");
  });

  it("resolves zai/glm-4.7 with correct endpoint", () => {
    const r = resolveModel(makeConfig("zai/glm-4.7"));
    expect(r.model.id).toBe("glm-4.7");
    expect(r.model.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
  });

  it("resolves an unknown zai/ model via fallback", () => {
    const r = resolveModel(makeConfig("zai/glm-future-99"));
    expect(r.model.id).toBe("glm-future-99");
    expect(r.model.provider).toBe("zai");
    expect(r.apiKey).toBe("zai-key");
  });

  it("zai/ fallback carries zai compat flags (for models not yet in pi-ai)", () => {
    // glm-future-99 isn't in pi-ai's registry, so it takes the manual fallback.
    // The fallback must still set zaiToolStream:true like upstream entries —
    // otherwise tool-call deltas don't stream to Telegram.
    const r = resolveModel(makeConfig("zai/glm-future-99"));
    expect((r.model as any).compat?.thinkingFormat).toBe("zai");
    expect((r.model as any).compat?.zaiToolStream).toBe(true);
    expect((r.model as any).compat?.supportsDeveloperRole).toBe(false);
  });

  it("resolves zai/glm-5.2 from the pi-ai registry with upstream compat", () => {
    const r = resolveModel(makeConfig("zai/glm-5.2"));
    expect(r.model.id).toBe("glm-5.2");
    expect(r.model.provider).toBe("zai");
    expect(r.model.api).toBe("openai-completions");
    expect(r.apiKey).toBe("zai-key");
    // Upstream registry carries compat + thinkingLevelMap
    expect((r.model as any).compat?.thinkingFormat).toBe("zai");
    expect((r.model as any).compat?.zaiToolStream).toBe(true);
    expect(r.model.thinkingLevelMap).toBeDefined();
  });

  it("throws when zai API key is missing", () => {
    const cfg = {
      modelName: "zai/glm-5.1",
      botToken: "t",
      allowedTgUserIds: "1",
      // no zaiApiKey
    } as unknown as Config;
    expect(() => resolveModel(cfg)).toThrow(/ZAI_API_KEY/);
  });

  // --- opencode-go/ provider ---

  it("resolves opencode-go/glm-5.2 from pi-ai registry with v1 baseUrl", () => {
    const r = resolveModel(makeConfig("opencode-go/glm-5.2"));
    expect(r.model.id).toBe("glm-5.2");
    expect(r.model.provider).toBe("opencode-go");
    expect(r.model.api).toBe("openai-completions");
    expect(r.model.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(r.apiKey).toBe("oc-key");
  });

  it("resolves opencode-go/minimax-m3 via anthropic-messages endpoint (no /v1)", () => {
    const r = resolveModel(makeConfig("opencode-go/minimax-m3"));
    expect(r.model.id).toBe("minimax-m3");
    expect(r.model.provider).toBe("opencode-go");
    expect(r.model.api).toBe("anthropic-messages");
    expect(r.model.baseUrl).toBe("https://opencode.ai/zen/go");
    expect(r.apiKey).toBe("oc-key");
  });

  it("resolves opencode-go/kimi-k2.6 from pi-ai registry", () => {
    const r = resolveModel(makeConfig("opencode-go/kimi-k2.6"));
    expect(r.model.id).toBe("kimi-k2.6");
    expect(r.model.provider).toBe("opencode-go");
    expect(r.model.api).toBe("openai-completions");
    expect(r.model.baseUrl).toBe("https://opencode.ai/zen/go/v1");
  });

  it("resolves opencode-go/kimi-k2.7-code (only K2.7 variant in pi-ai registry)", () => {
    const r = resolveModel(makeConfig("opencode-go/kimi-k2.7-code"));
    expect(r.model.id).toBe("kimi-k2.7-code");
    expect(r.model.provider).toBe("opencode-go");
    expect(r.apiKey).toBe("oc-key");
  });

  it("resolves an unknown opencode-go/ model via fallback to v1 chat completions", () => {
    const r = resolveModel(makeConfig("opencode-go/future-model-9"));
    expect(r.model.id).toBe("future-model-9");
    expect(r.model.provider).toBe("opencode-go");
    expect(r.model.api).toBe("openai-completions");
    expect(r.model.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    expect(r.apiKey).toBe("oc-key");
  });

  it("throws when opencode-go API key is missing", () => {
    const cfg = {
      modelName: "opencode-go/glm-5.2",
      botToken: "t",
      allowedTgUserIds: "1",
      // no opencodeApiKey
    } as unknown as Config;
    expect(() => resolveModel(cfg)).toThrow(/OPENCODE_API_KEY/);
  });

  // --- thinkingLevelMap inheritance ---

  it("inherits thinkingLevelMap from pi-ai registry for poe/gpt-5.5", () => {
    const r = resolveModel(makeConfig("poe/gpt-5.5"));
    // pi-ai's openai provider has xhigh for gpt-5.5
    expect(r.model.thinkingLevelMap).toEqual({ off: null, xhigh: "xhigh" });
  });

  it("has no thinkingLevelMap for models without upstream entry", () => {
    const r = resolveModel(makeConfig("poe/some-future-model"));
    expect(r.model.thinkingLevelMap).toBeUndefined();
  });
});

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
    expect(r.model.api).toBe("anthropic");
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
});

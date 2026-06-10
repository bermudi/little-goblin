import { afterEach, describe, expect, it, mock } from "bun:test";
import type { Config } from "../config.ts";
import { validateModelAtStartup } from "./poe-validate.ts";

const originalFetch = globalThis.fetch;

function makeConfig(modelName: string): Config {
  return {
    botToken: "token",
    allowedTgUserIds: new Set([1]),
    modelName,
    poeApiKey: "poe-key",
    goblinHome: "/tmp/goblin-test",
    logLevel: "error",
    toolVisibility: "standard",
    skillSources: "goblin-only",
    favorites: [],
  };
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("validateModelAtStartup", () => {
  it("skips non-poe model names", async () => {
    const fetchMock = mock(async () => response(200, { data: [] }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const logger = { warn: mock(() => {}) };

    await validateModelAtStartup(makeConfig("openai/gpt-4o"), logger);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("accepts a known poe model id", async () => {
    globalThis.fetch = mock(async () => response(200, { data: [{ id: "Claude-Sonnet-4.6" }] })) as unknown as typeof fetch;
    const logger = { warn: mock(() => {}) };

    await validateModelAtStartup(makeConfig("poe/Claude-Sonnet-4.6"), logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("throws with close-match suggestions for unknown poe ids", async () => {
    globalThis.fetch = mock(async () =>
      response(200, {
        data: [
          { id: "Claude-Sonnet-4.6" },
          { id: "Claude-Sonnet-4" },
          { id: "Claude-Sonnet" },
          { id: "GPT-5" },
        ],
      }),
    ) as unknown as typeof fetch;

    await expect(validateModelAtStartup(makeConfig("poe/Claude-Sonnet-4.6-Beta"), { warn: mock(() => {}) })).rejects.toThrow(
      "Did you mean: poe/Claude-Sonnet-4.6, poe/Claude-Sonnet-4, poe/Claude-Sonnet?",
    );
  });

  it("throws with the full-list hint when there are no close matches", async () => {
    globalThis.fetch = mock(async () => response(200, { data: [{ id: "GPT-5" }] })) as unknown as typeof fetch;

    await expect(validateModelAtStartup(makeConfig("poe/Unknown-Model"), { warn: mock(() => {}) })).rejects.toThrow(
      "See https://api.poe.com/v1/models for the full list.",
    );
  });

  it("warns and does not throw when fetch fails", async () => {
    const error = new Error("network down");
    globalThis.fetch = mock(async () => {
      throw error;
    }) as unknown as typeof fetch;
    const logger = { warn: mock(() => {}) };

    await validateModelAtStartup(makeConfig("poe/Claude-Sonnet-4.6"), logger);

    expect(logger.warn).toHaveBeenCalledWith("could not reach Poe to validate model; skipping", { error: "network down" });
  });

  it("warns and does not throw on 500 responses", async () => {
    globalThis.fetch = mock(async () => response(500, { error: "oops" })) as unknown as typeof fetch;
    const logger = { warn: mock(() => {}) };

    await validateModelAtStartup(makeConfig("poe/Claude-Sonnet-4.6"), logger);

    expect(logger.warn).toHaveBeenCalledWith("Poe model list returned non-2xx; skipping validation", { status: 500 });
  });

  it("warns and does not throw on 401 responses", async () => {
    globalThis.fetch = mock(async () => response(401, { error: "bad key" })) as unknown as typeof fetch;
    const logger = { warn: mock(() => {}) };

    await validateModelAtStartup(makeConfig("poe/Claude-Sonnet-4.6"), logger);

    expect(logger.warn).toHaveBeenCalledWith("Poe model list returned non-2xx; skipping validation", { status: 401 });
  });

  it("warns and does not throw on an empty model list", async () => {
    globalThis.fetch = mock(async () => response(200, { data: [] })) as unknown as typeof fetch;
    const logger = { warn: mock(() => {}) };

    await validateModelAtStartup(makeConfig("poe/Claude-Sonnet-4.6"), logger);

    expect(logger.warn).toHaveBeenCalledWith("Poe model list was empty; skipping validation");
  });
});
